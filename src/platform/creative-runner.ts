import { randomUUID } from "node:crypto";
import type { ToolResult } from "../contracts/agent-tool";
import type { CreativeSession } from "../contracts/creative-host";
import type { CreativePlanner, CreativePlannerDecision, CreativePlannerObservation, CreativeRunLimits, CreativeRunOptions,
  CreativeRunReport, CreativeRunStop, CreativeRunTurn } from "../contracts/creative-planner";
import { abortable } from "./abortable";
import { CreativePlanningError, planCreativeStep } from "./creative-planner";

function resolveLimits(input: Partial<CreativeRunLimits> = {}): CreativeRunLimits {
  const limits = { maxTurns: input.maxTurns ?? 32, timeoutMs: input.timeoutMs ?? 30_000, maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024 };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || (name === "timeoutMs" && value > 2_147_483_647))
      throw new CreativePlanningError("PLANNER_RUN_LIMITS_INVALID", `Invalid ${name}`);
  }
  return limits;
}

/** Drive one scoped session and retain enough evidence to reconcile an uncertain call. */
export async function runCreativePlan(session: Pick<CreativeSession, "projectId" | "discover" | "manifest" | "invoke">,
  planner: CreativePlanner, { brief, query, signal: callerSignal, limits: requestedLimits }: CreativeRunOptions): Promise<CreativeRunReport> {
  const limits = resolveLimits(requestedLimits);
  const started = performance.now();
  const runId = randomUUID();
  const projectId = session.projectId;
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = () => controller.abort("cancelled");
  const deadline = () => controller.abort("deadline");
  const timer = setTimeout(deadline, limits.timeoutMs);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const interrupted = (): "deadline" | "cancelled" | undefined => {
    if (performance.now() - started >= limits.timeoutMs) deadline();
    return signal.aborted ? signal.reason as "deadline" | "cancelled" : undefined;
  };
  const wait = <T>(start: () => Promise<T>) => abortable(signal, () => {
    interrupted();
    signal.throwIfAborted();
    return start();
  });

  const turns: CreativeRunTurn[] = [];
  let plannerTurns = 0, outputBytes = 0;
  let observation: CreativePlannerObservation | undefined;
  let pinnedTools: CreativeRunReport["pinnedTools"] = [];
  const finish = (stop: CreativeRunStop): CreativeRunReport => ({ schemaVersion: "1.0.0", projectId, runId, limits,
    elapsedMs: Math.round(performance.now() - started), plannerTurns, outputBytes, pinnedTools, turns, stop });
  const planningFailure = (error: unknown) => {
    const reason = interrupted();
    if (reason) return finish({ reason });
    return finish(error instanceof CreativePlanningError
      ? { reason: "planning-failed", code: error.code, message: error.message.slice(0, 1024) }
      : { reason: "planning-failed", code: "PLANNER_RUN_FAILED", message: "Planning or tool discovery failed" });
  };

  try {
    let catalogue: Awaited<ReturnType<CreativeSession["discover"]>>;
    try { catalogue = structuredClone(await wait(() => session.discover(query))); }
    catch (error) { return planningFailure(error); }
    pinnedTools = catalogue.tools.map(({ id, version }) => ({ id, version }));
    const planningSession = { projectId, discover: async () => catalogue, manifest: (id: string) => session.manifest(id) };

    while (plannerTurns < limits.maxTurns) {
      const reason = interrupted();
      if (reason) return finish({ reason });
      const turn = ++plannerTurns;
      let decision: CreativePlannerDecision;
      try { decision = await wait(() => planCreativeStep(planningSession, planner, { brief, signal, observation })); }
      catch (error) { return planningFailure(error); }
      const afterPlanning = interrupted();
      if (afterPlanning) return finish({ reason: afterPlanning });
      const decisionBytes = Buffer.byteLength(JSON.stringify(decision));
      if (decisionBytes > limits.maxOutputBytes - outputBytes)
        return finish({ reason: "output-limit", source: "decision", bytes: decisionBytes });
      outputBytes += decisionBytes;
      const record: CreativeRunTurn = { turn, decision };
      turns.push(record);
      if (decision.kind !== "invoke") return finish({ reason: decision.kind === "finish" ? "finished" : "needs-input" });

      const { toolId, toolVersion, input } = decision;
      const callId = `turn-${turn}`;
      const call: NonNullable<CreativeRunTurn["call"]> = { callId };
      const uncertain = (cause: Extract<CreativeRunStop, { reason: "outcome-unknown" }>["cause"]) =>
        finish({ reason: "outcome-unknown", callId, cause });
      let result: ToolResult;
      try {
        result = await wait(() => {
          const copiedInput = structuredClone(input);
          record.call = call;
          return session.invoke({ toolId, toolVersion, input: copiedInput, runId, callId, signal });
        });
      } catch {
        const stop = interrupted();
        return !record.call && stop ? finish({ reason: stop }) : uncertain(stop ?? "invocation-error");
      }
      if (!result || typeof result.ok !== "boolean" || !Array.isArray(result.diagnostics)) return uncertain("invalid-result");
      let serialized: string;
      try { serialized = JSON.stringify(result); }
      catch { return uncertain("invalid-result"); }
      if (typeof serialized !== "string") return uncertain("invalid-result");
      const resultBytes = Buffer.byteLength(serialized);
      if (resultBytes <= limits.maxOutputBytes - outputBytes) {
        call.result = JSON.parse(serialized) as ToolResult;
        outputBytes += resultBytes;
      } else call.omittedResult = { bytes: resultBytes, ok: result.ok };
      if (result.metadata?.outcomeUnknown) return uncertain("tool-result");
      const afterCall = interrupted();
      if (afterCall) return finish({ reason: afterCall });
      if (!call.result) return finish({ reason: "output-limit", source: "tool-result", bytes: resultBytes });
      observation = { callId, decision, result: call.result };
    }
    return finish({ reason: "turn-limit" });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}
