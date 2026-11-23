import type { AgentToolManifest, ToolResult, ToolSearchQuery } from "./agent-tool";

export const CREATIVE_PLANNER_PROTOCOL = "1.0.0" as const;

export interface CreativePlannerContext {
  protocolVersion: typeof CREATIVE_PLANNER_PROTOCOL;
  projectId: string;
  brief: string;
  catalogue: { tools: readonly AgentToolManifest[]; total: number; limit: number; offset: number };
  observation?: CreativePlannerObservation;
}

export type CreativePlannerDecision =
  | { kind: "invoke"; toolId: string; toolVersion: string; input: unknown }
  | { kind: "finish"; summary: string }
  | { kind: "needs-input"; question: string };

export interface CreativePlannerObservation {
  callId: string;
  decision: Extract<CreativePlannerDecision, { kind: "invoke" }>;
  result: ToolResult;
}

/** The caller supplies the adapter. Its JSON response is validated before use. */
export interface CreativePlanner {
  propose(context: CreativePlannerContext, signal?: AbortSignal): Promise<string>;
}

export interface CreativeRunLimits {
  maxTurns: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CreativeRunOptions {
  brief: string;
  query?: ToolSearchQuery;
  signal?: AbortSignal;
  limits?: Partial<CreativeRunLimits>;
}

export interface CreativeRunTurn {
  turn: number;
  decision: CreativePlannerDecision;
  call?: { callId: string; result?: ToolResult; omittedResult?: { bytes: number; ok: boolean } };
}

export type CreativeRunStop =
  | { reason: "finished" | "needs-input" | "turn-limit" | "deadline" | "cancelled" }
  | { reason: "planning-failed"; code: string; message: string }
  | { reason: "output-limit"; source: "decision" | "tool-result"; bytes: number }
  | { reason: "outcome-unknown"; callId: string; cause: "deadline" | "cancelled" | "tool-result" | "invocation-error" | "invalid-result" };

export interface CreativeRunReport {
  schemaVersion: "1.0.0";
  projectId: string;
  runId: string;
  limits: CreativeRunLimits;
  elapsedMs: number;
  plannerTurns: number;
  outputBytes: number;
  pinnedTools: Array<Pick<AgentToolManifest, "id" | "version">>;
  turns: CreativeRunTurn[];
  stop: CreativeRunStop;
}
