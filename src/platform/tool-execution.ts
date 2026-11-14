import type { AgentTool, ToolCallContext, ToolExecutionRecord, ToolExecutionStore, ToolResult } from "../contracts/agent-tool";
import { InMemoryToolExecutionStore, hashToolInput } from "./tool-execution-store";

export interface ToolExecutionEvent {
  phase: "started" | "completed" | "failed";
  toolId: string; toolVersion: string; projectId: string; runId: string; callId: string;
  durationMs?: number; message?: string;
}
export interface ToolExecutorOptions {
  executionStore?: ToolExecutionStore;
  maxAttempts?: number;
  maxConcurrentCalls?: number;
  defaultToolConcurrency?: number;
  maxTimeoutMs?: number;
  onEvent?: (event: ToolExecutionEvent) => void | Promise<void>;
}
export type ResultInspector = (result: ToolResult, signal: AbortSignal) => Promise<void>;
type Pending = { inputHash: string; promise: Promise<ToolResult>; settled: Promise<void> };
type Coordination = { pending: Map<string, Pending>; active: Map<string, number>; total: number };
const coordination = new WeakMap<ToolExecutionStore, Coordination>();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
export const toolFailure = (code: string, message: string): ToolResult<never> => ({
  ok: false, diagnostics: [{ level: "error", code, message }],
});
class Stop extends Error {
  constructor(readonly status: "cancelled" | "timed-out") { super(status === "cancelled" ? "Tool call was cancelled" : "Tool execution deadline exceeded"); }
}
function positive(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

/** Execution admission is shared by gateways using the same store object. */
export class LocalToolExecutor {
  readonly store: ToolExecutionStore;
  private accepting = true;
  private readonly state: Coordination;
  private readonly attempts: number;
  private readonly callLimit: number;
  private readonly toolLimit: number;
  private readonly timeoutLimit: number;
  constructor(private readonly options: ToolExecutorOptions = {}) {
    this.store = options.executionStore ?? new InMemoryToolExecutionStore();
    this.attempts = positive(options.maxAttempts ?? 2, "maxAttempts", 5);
    this.callLimit = positive(options.maxConcurrentCalls ?? 32, "maxConcurrentCalls");
    this.toolLimit = positive(options.defaultToolConcurrency ?? 8, "defaultToolConcurrency");
    this.timeoutLimit = positive(options.maxTimeoutMs ?? 30_000, "maxTimeoutMs", 2_147_483_647);
    let state = coordination.get(this.store);
    if (!state) { state = { pending: new Map(), active: new Map(), total: 0 }; coordination.set(this.store, state); }
    this.state = state;
  }

  async invoke(tool: AgentTool, input: unknown, caller: ToolCallContext, inspect?: ResultInspector): Promise<ToolResult> {
    if (!this.accepting) return toolFailure("TOOL_GATEWAY_CLOSED", "Host admission has stopped");
    let snapshot: unknown; let inputHash: string;
    const context = { ...caller }; // No caller mutation across asynchronous admission.
    try {
      for (const value of [context.projectId, context.runId, context.callId]) {
        if (typeof value !== "string" || !value.trim()) throw new Error("Project, run and call IDs are required");
      }
      if (context.idempotencyKey !== undefined && (typeof context.idempotencyKey !== "string" || !context.idempotencyKey.trim())) throw new Error("Idempotency key must be non-empty");
      inputHash = hashToolInput(input); snapshot = structuredClone(input);
    } catch (error) { return toolFailure("TOOL_INPUT_INVALID", messageOf(error)); }
    if (context.signal?.aborted) return toolFailure("TOOL_CANCELLED", "Tool call was cancelled before admission");
    // Capture selection and metadata now; an upgrade affects only future invocations.
    const selected: AgentTool = { manifest: structuredClone(tool.manifest), execute: tool.execute.bind(tool) };
    const manifest = selected.manifest;
    if (context.idempotencyKey && !manifest.execution.idempotent) return toolFailure("TOOL_NOT_IDEMPOTENT", "Tool does not declare idempotent execution");
    const id = JSON.stringify([context.projectId, context.runId, context.callId]);
    const key = context.idempotencyKey === undefined ? undefined : JSON.stringify([context.projectId, manifest.id, manifest.version, context.idempotencyKey]);
    const pendingKey = key === undefined ? `call:${id}` : `idempotency:${key}`;
    const pending = this.state.pending.get(pendingKey);
    if (pending) {
      if (pending.inputHash !== inputHash) return toolFailure(key === undefined ? "TOOL_CALL_CONFLICT" : "IDEMPOTENCY_CONFLICT", "The invocation identity already has different input");
      if (key === undefined) return toolFailure("TOOL_CALL_CONFLICT", "Call ID is already in use; use a new call ID or an idempotency key");
      return this.waitForFollower(pending.promise, context.signal);
    }
    let limit: number; let timeout: number;
    try {
      limit = positive(manifest.execution.maxConcurrency ?? this.toolLimit, "tool concurrency");
      timeout = Math.min(positive(manifest.execution.timeoutMs ?? this.timeoutLimit, "tool timeout", 2_147_483_647), this.timeoutLimit);
    } catch (error) { return toolFailure("TOOL_POLICY_INVALID", messageOf(error)); }
    const active = this.state.active.get(manifest.id) ?? 0;
    if (active >= limit || this.state.total >= this.callLimit) return toolFailure("TOOL_CONCURRENCY_LIMIT", "Local invocation concurrency limit reached");
    this.state.active.set(manifest.id, active + 1); this.state.total++;
    let settled!: () => void;
    const entry: Pending = { inputHash, promise: Promise.resolve(toolFailure("INTERNAL", "Not scheduled")),
      settled: new Promise<void>((resolve) => { settled = resolve; }) };
    // Publish before the first await, including before any async store admission.
    this.state.pending.set(pendingKey, entry);
    let rawWork: Promise<unknown> | undefined;
    const release = () => {
      if (this.state.pending.get(pendingKey) === entry) this.state.pending.delete(pendingKey);
      this.state.total--;
      const remaining = (this.state.active.get(manifest.id) ?? 1) - 1;
      if (remaining > 0) this.state.active.set(manifest.id, remaining); else this.state.active.delete(manifest.id);
      settled();
    };
    entry.promise = Promise.resolve().then(() => this.execute(selected, snapshot, context, inputHash, id, key, timeout,
      (work) => { rawWork = work; }, inspect)).catch((error) => toolFailure("TOOL_HOST_FAILED", messageOf(error)));
    // Aborted code may still run. Keep the capacity reservation until it really settles.
    void entry.promise.then(() => {
      if (rawWork) void rawWork.then(release, release); else release();
    });
    return structuredClone(await entry.promise);
  }

  /** Stop this gateway's admission, then drain actual work (including timed-out tools). */
  async shutdown(): Promise<void> {
    this.accepting = false;
    await Promise.all([...this.state.pending.values()].map((entry) => entry.settled));
  }

  private async execute(tool: AgentTool, input: unknown, context: ToolCallContext, inputHash: string,
    id: string, key: string | undefined, timeoutMs: number, retainWork: (work: Promise<unknown>) => void,
    inspect?: ResultInspector): Promise<ToolResult> {
    const manifest = tool.manifest;
    const started = Date.now();
    const record: ToolExecutionRecord = { id, projectId: context.projectId, runId: context.runId, callId: context.callId,
      toolId: manifest.id, toolVersion: manifest.version, inputHash, idempotencyKey: key,
      status: "started", startedAt: new Date().toISOString() };
    let reservation;
    try { reservation = await this.store.reserve(record); }
    catch (error) { return toolFailure("TOOL_EXECUTION_STORE_FAILED", `Admission failed: ${messageOf(error)}`); }
    if (!reservation.acquired) {
      const prior = reservation.record;
      if (prior.inputHash !== inputHash || prior.toolId !== manifest.id || prior.toolVersion !== manifest.version || prior.idempotencyKey !== key) {
        return toolFailure(key !== undefined && prior.idempotencyKey === key ? "IDEMPOTENCY_CONFLICT" : "TOOL_CALL_CONFLICT", "Stored invocation identity does not match this request");
      }
      if (key === undefined) return toolFailure("TOOL_CALL_CONFLICT", "Call ID already exists");
      if (prior.status === "succeeded" && prior.result) return structuredClone(prior.result);
      if (prior.status === "started") return toolFailure("TOOL_ALREADY_RUNNING", "Invocation has no terminal evidence yet");
      if (prior.status === "interrupted" || prior.result?.metadata?.outcomeUnknown) return { ...toolFailure("TOOL_RECOVERY_REQUIRED", "Reconcile the earlier invocation before choosing a new identity"), metadata: { outcomeUnknown: true } };
      return toolFailure("IDEMPOTENCY_KEY_CONSUMED", "This key belongs to an earlier unsuccessful invocation");
    }

    let executed = false; let attempt = 0;
    const controller = new AbortController();
    const callerAbort = () => controller.abort(new Stop("cancelled"));
    context.signal?.addEventListener("abort", callerAbort, { once: true });
    if (context.signal?.aborted) callerAbort(); // Includes cancellation during store admission.
    const abort = new Promise<never>((_, reject) => {
      const rejectAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    // Always observe abort rejection, including a pre-start cancellation.
    void abort.catch(() => undefined);
    const timer = setTimeout(() => controller.abort(new Stop("timed-out")), timeoutMs);
    const event = (phase: ToolExecutionEvent["phase"], message?: string) => {
      try { void Promise.resolve(this.options.onEvent?.({ phase, toolId: manifest.id, toolVersion: manifest.version,
        projectId: context.projectId, runId: context.runId, callId: context.callId,
        durationMs: Date.now() - started, message })).catch(() => undefined); } catch { /* Observer cannot alter a committed outcome. */ }
    };
    let result: ToolResult;
    let status: ToolExecutionRecord["status"];
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      event("started");
      const maxAttempts = manifest.execution.idempotent ? this.attempts : 1;
      result = toolFailure("TOOL_EXECUTION_FAILED", "No result");
      for (attempt = 1; attempt <= maxAttempts; attempt++) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const work = Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          executed = true;
          const output = await tool.execute(structuredClone(input), { ...context, signal: controller.signal });
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!output || typeof output.ok !== "boolean" || !Array.isArray(output.diagnostics)) throw new Error("Invalid ToolResult envelope");
          if (inspect) await inspect(output, controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (output.output !== undefined) hashToolInput(output.output);
          return structuredClone(output);
        });
        retainWork(work);
        result = await Promise.race([work, abort]);
        if (result.ok || !result.metadata?.retryable || attempt === maxAttempts) break;
      }
      status = result.ok ? "succeeded" : "failed";
    } catch (error) {
      if (error instanceof Stop) {
        status = error.status;
        result = toolFailure(status === "timed-out" ? "TOOL_TIMEOUT" : "TOOL_CANCELLED", error.message);
      } else { status = "failed"; result = toolFailure("TOOL_EXECUTION_FAILED", messageOf(error)); }
      // Failure/cancellation does not establish whether external side effects occurred.
      if (executed) result.metadata = { outcomeUnknown: true };
    } finally { clearTimeout(timer); context.signal?.removeEventListener("abort", callerAbort); }
    result = { ...result, metadata: { ...result.metadata, toolId: manifest.id, toolVersion: manifest.version,
      durationMs: Date.now() - started, attempt, idempotencyKey: key } };
    record.status = status; record.result = structuredClone(result); record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - started; record.errorCode = result.ok ? undefined : result.diagnostics[0]?.code;
    try { await this.store.finish(record, reservation.token); }
    catch (error) {
      const failed = { ...toolFailure("TOOL_EXECUTION_STORE_FAILED", `Terminal evidence not confirmed: ${messageOf(error)}`),
        metadata: { toolId: manifest.id, toolVersion: manifest.version, outcomeUnknown: executed, attempt } };
      event("failed", failed.diagnostics[0].message); return failed;
    }
    event(result.ok ? "completed" : "failed", result.diagnostics[0]?.message);
    return result;
  }

  private async waitForFollower(promise: Promise<ToolResult>, signal?: AbortSignal): Promise<ToolResult> {
    if (!signal) return structuredClone(await promise);
    if (signal.aborted) return toolFailure("TOOL_CANCELLED", "Duplicate caller stopped waiting");
    let onAbort!: () => void;
    const cancelled = new Promise<ToolResult>((resolve) => {
      onAbort = () => resolve(toolFailure("TOOL_CANCELLED", "Duplicate caller stopped waiting; original invocation is unchanged"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return structuredClone(await Promise.race([promise, cancelled])); }
    finally { signal.removeEventListener("abort", onAbort); }
  }
}
