import Ajv, { type ValidateFunction } from "ajv";
import { InMemoryToolExecutionStore, hashToolInput } from "./tool-execution-store";
import type { ToolExecutionRecord, ToolExecutionStore } from "../contracts/agent-tool";
import type { ArtifactStore } from "../contracts/artifact";
import type {
  AgentTool,
  AgentToolGateway,
  AgentToolManifest,
  AgentToolRegistry,
  ToolCallContext,
  ToolResult,
  ToolSearchQuery,
} from "../contracts/agent-tool";

export interface ToolExecutionEvent {
  phase: "started" | "completed" | "failed";
  toolId: string;
  toolVersion: string;
  projectId: string;
  runId: string;
  callId: string;
  durationMs?: number;
  message?: string;
}

export interface ToolGatewayOptions {
  allowedPermissions?: string[];
  onEvent?: (event: ToolExecutionEvent) => void;
  executionStore?: import("../contracts/agent-tool").ToolExecutionStore;
  maxAttempts?: number;
  artifactStore?: ArtifactStore;
}

type RegisteredTool = AgentTool<unknown, unknown>;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function matchesAll(values: string[] | undefined, required: string[] | undefined): boolean {
  if (!required?.length) return true;
  const available = new Set(values ?? []);
  return required.every((item) => available.has(item));
}

export class InMemoryAgentToolRegistry implements AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const { id, version, namespace } = tool.manifest;
    if (!/^[a-z][a-z0-9._-]+$/.test(id)) throw new Error(`Invalid tool ID: ${id}`);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid semantic version: ${version}`);
    if (!/^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/.test(namespace)) {
      throw new Error(`Invalid tool namespace: ${namespace}`);
    }
    if (!id.startsWith(`${namespace}.`)) {
      throw new Error(`Tool ID ${id} must be inside namespace ${namespace}`);
    }
    if (!tool.manifest.name.trim() || !tool.manifest.description.trim()) {
      throw new Error("Tool name and description are required");
    }
    const key = this.key(id, version);
    if (this.tools.has(key)) throw new Error(`Tool already registered: ${key}`);
    this.tools.set(key, tool);
  }

  unregister(toolId: string, version: string): boolean {
    return this.tools.delete(this.key(toolId, version));
  }

  async search(query: string, categories: string[] = []): Promise<AgentToolManifest[]> {
    const result = await this.discover({ text: query, categories });
    return result.tools;
  }

  async discover(query: ToolSearchQuery): Promise<{
    tools: AgentToolManifest[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const text = query.text?.trim().toLowerCase();
    const namespaces = new Set(query.namespaces ?? []);
    const categories = new Set(query.categories ?? []);
    const tags = query.tags ?? [];
    const capabilities = query.capabilities ?? [];
    const engines = query.engines ?? [];

    const filtered = [...this.tools.values()]
      .map((tool) => tool.manifest)
      .filter((manifest) => query.includeDeprecated || manifest.lifecycle !== "deprecated")
      .filter((manifest) => namespaces.size === 0 || namespaces.has(manifest.namespace))
      .filter((manifest) => categories.size === 0 || categories.has(manifest.category))
      .filter((manifest) => matchesAll(manifest.tags, tags))
      .filter((manifest) => matchesAll(manifest.capabilities, capabilities))
      .filter((manifest) => matchesAll(manifest.engines, engines))
      .filter((manifest) => !query.projectSchemaVersion ||
        !manifest.projectSchemaVersions?.length ||
        manifest.projectSchemaVersions.includes(query.projectSchemaVersion))
      .filter((manifest) => {
        if (!text) return true;
        const haystack = [
          manifest.id, manifest.namespace, manifest.name, manifest.description,
          manifest.category, ...(manifest.tags ?? []), ...(manifest.capabilities ?? []),
          ...(manifest.engines ?? []),
        ].join(" ").toLowerCase();
        return haystack.includes(text);
      })
      .sort((a, b) => a.namespace.localeCompare(b.namespace) ||
        a.id.localeCompare(b.id) || compareVersions(b.version, a.version));

    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
    return { tools: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
  }

  async get(toolId: string, version?: string): Promise<AgentToolManifest | undefined> {
    if (version) return this.tools.get(this.key(toolId, version))?.manifest;
    const candidates = [...this.tools.values()].filter((tool) => tool.manifest.id === toolId);
    candidates.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    return candidates[0]?.manifest;
  }

  async list(categories: string[] = []): Promise<AgentToolManifest[]> {
    const allowed = new Set(categories);
    return [...this.tools.values()]
      .map((tool) => tool.manifest)
      .filter((manifest) => allowed.size === 0 || allowed.has(manifest.category))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id) ||
        compareVersions(b.version, a.version));
  }

  getImplementation(toolId: string, version?: string): RegisteredTool | undefined {
    if (version) return this.tools.get(this.key(toolId, version));
    const candidates = [...this.tools.values()].filter((tool) => tool.manifest.id === toolId);
    candidates.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    return candidates[0];
  }

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}

export class LocalAgentToolGateway implements AgentToolGateway {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly options: ToolGatewayOptions;
  private readonly inFlight = new Map<string, Promise<ToolResult>>();
  private readonly activeByTool = new Map<string, number>();
  private readonly executions: ToolExecutionStore;

  constructor(private readonly registry: InMemoryAgentToolRegistry, options: ToolGatewayOptions = {}) {
    this.options = options;
    this.executions = options.executionStore ?? new InMemoryToolExecutionStore();
  }

  async invoke<TInput = unknown, TOutput = unknown>(
    toolId: string,
    input: TInput,
    context: ToolCallContext
  ): Promise<ToolResult<TOutput>> {
    const tool = this.registry.getImplementation(toolId);
    if (!tool) return this.failure("TOOL_NOT_FOUND", `No registered tool matches ${toolId}`);
    const manifest = tool.manifest;
    const required = manifest.execution.permissions ?? [];
    if (this.options.allowedPermissions && required.some((permission) => !this.options.allowedPermissions!.includes(permission))) {
      return this.failure("TOOL_PERMISSION_DENIED", `Missing permission for tool ${toolId}`);
    }
    if (context.signal?.aborted) return this.failure("TOOL_CANCELLED", "Tool call was cancelled before execution");
    const validateInput = this.compile(manifest.inputSchema);
    if (!validateInput(input)) return this.failure("TOOL_INPUT_INVALID", this.formatErrors(validateInput));

    const inputHash = hashToolInput(input);
    const idempotencyKey = context.idempotencyKey
      ? `${context.projectId}:${toolId}@${manifest.version}:${context.idempotencyKey}`
      : undefined;
    if (idempotencyKey && !manifest.execution.idempotent) {
      return this.failure("TOOL_NOT_IDEMPOTENT", `Tool ${toolId} does not declare idempotent execution`);
    }
    if (idempotencyKey) {
      const pending = this.inFlight.get(idempotencyKey);
      if (pending) return pending as Promise<ToolResult<TOutput>>;
      const existing = await this.executions.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.inputHash !== inputHash) return this.failure("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different input");
        if (existing.status === "succeeded" && existing.result) return structuredClone(existing.result) as ToolResult<TOutput>;
        if (existing.status === "started") return this.failure("TOOL_ALREADY_RUNNING", "An invocation with this idempotency key is already running");
        return this.failure("IDEMPOTENCY_KEY_CONSUMED", "The idempotency key belongs to a previous failed invocation");
      }
    }

    const active = this.activeByTool.get(toolId) ?? 0;
    const limit = manifest.execution.maxConcurrency;
    if (limit !== undefined && active >= limit) {
      return this.failure("TOOL_CONCURRENCY_LIMIT", `Tool concurrency limit reached (${limit})`);
    }

    this.activeByTool.set(toolId, active + 1);
    const promise = this.executeWithGovernance(tool, input, context, inputHash, idempotencyKey);
    if (idempotencyKey) this.inFlight.set(idempotencyKey, promise);
    try {
      return await promise as ToolResult<TOutput>;
    } finally {
      if (idempotencyKey) this.inFlight.delete(idempotencyKey);
    }
  }

  private async executeWithGovernance(
    tool: RegisteredTool,
    input: unknown,
    context: ToolCallContext,
    inputHash: string,
    idempotencyKey?: string
  ): Promise<ToolResult> {
    const manifest = tool.manifest;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const record: ToolExecutionRecord = {
      id: `${context.projectId}:${context.runId}:${context.callId}`, toolId: manifest.id, toolVersion: manifest.version,
      projectId: context.projectId, runId: context.runId, callId: context.callId,
      idempotencyKey, status: "started", startedAt, inputHash,
    };
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const executionContext: ToolCallContext = { ...context, signal: controller.signal };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.executions.save(record);
      this.options.onEvent?.({
        phase: "started", toolId: manifest.id, toolVersion: manifest.version,
        projectId: context.projectId, runId: context.runId, callId: context.callId,
      });
      const maxAttempts = manifest.execution.idempotent
        ? Math.max(1, Math.min(5, this.options.maxAttempts ?? 2))
        : 1;
      let finalResult: ToolResult | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const timeoutMs = manifest.execution.timeoutMs ?? 30_000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort(new Error(`Tool timed out after ${timeoutMs}ms`));
            reject(new Error(`Tool timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        try {
          const result = await Promise.race([tool.execute(input, executionContext), timeoutPromise]);
          if (controller.signal.aborted) throw new Error("Tool call was cancelled");
          const validateOutput = this.compile(manifest.outputSchema);
          if (result.ok && result.output !== undefined && !validateOutput(result.output)) {
            throw new Error(`Tool output does not match its declared schema: ${this.formatErrors(validateOutput)}`);
          }
          if (result.ok && result.artifacts?.length && this.options.artifactStore) {
            for (const artifact of result.artifacts) {
              const stored = await this.options.artifactStore.get(artifact.id);
              if (!stored || stored.uri !== artifact.uri ||
                  stored.mediaType !== artifact.mediaType ||
                  (artifact.contentHash && stored.contentHash !== artifact.contentHash)) {
                throw new Error(`Tool returned an unknown or inconsistent artifact reference: ${artifact.id}`);
              }
            }
          }
          finalResult = {
            ...result,
            metadata: {
              ...result.metadata, toolId: manifest.id, toolVersion: manifest.version,
              durationMs: Date.now() - started, attempt, idempotencyKey,
            },
          };
          if (result.ok || !result.metadata?.retryable || attempt === maxAttempts) break;
        } finally {
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
        }
      }
      const result = finalResult ?? this.failure("TOOL_EXECUTION_FAILED", "Tool execution produced no result");
      record.status = result.ok ? "succeeded" : "failed";
      record.result = structuredClone(result);
      record.errorCode = result.ok ? undefined : result.diagnostics[0]?.code;
      record.completedAt = new Date().toISOString();
      record.durationMs = Date.now() - started;
      await this.executions.update(record);
      this.options.onEvent?.({
        phase: result.ok ? "completed" : "failed", toolId: manifest.id,
        toolVersion: manifest.version, projectId: context.projectId,
        runId: context.runId, callId: context.callId, durationMs: record.durationMs,
        message: result.ok ? undefined : result.diagnostics[0]?.message,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted;
      const code = cancelled ? "TOOL_CANCELLED" : "TOOL_EXECUTION_FAILED";
      const result = this.failure(code, message);
      record.status = "failed";
      record.errorCode = code;
      record.result = result;
      record.completedAt = new Date().toISOString();
      record.durationMs = Date.now() - started;
      try { await this.executions.update(record); } catch { /* preserve original execution failure */ }
      this.options.onEvent?.({
        phase: "failed", toolId: manifest.id, toolVersion: manifest.version,
        projectId: context.projectId, runId: context.runId, callId: context.callId,
        durationMs: record.durationMs, message,
      });
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      context.signal?.removeEventListener("abort", onCallerAbort);
      this.activeByTool.set(manifest.id, Math.max(0, (this.activeByTool.get(manifest.id) ?? 1) - 1));
    }
  }

  private compile(schema: Record<string, unknown>): ValidateFunction {
    return this.ajv.compile(schema);
  }

  private formatErrors(validate: ValidateFunction): string {
    return (validate.errors ?? []).map((error) =>
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
  }

  private failure(code: string, message: string): ToolResult<never> {
    return { ok: false, diagnostics: [{ level: "error", code, message }] };
  }
}
