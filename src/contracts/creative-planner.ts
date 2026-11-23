import type { AgentToolManifest } from "./agent-tool";

export const CREATIVE_PLANNER_PROTOCOL = "1.0.0" as const;

export interface CreativePlannerContext {
  protocolVersion: typeof CREATIVE_PLANNER_PROTOCOL;
  projectId: string;
  brief: string;
  catalogue: { tools: readonly AgentToolManifest[]; total: number; limit: number; offset: number };
}

export type CreativePlannerDecision =
  | { kind: "invoke"; toolId: string; toolVersion: string; input: unknown }
  | { kind: "finish"; summary: string }
  | { kind: "needs-input"; question: string };

/** The caller supplies the adapter. Its JSON response is validated before use. */
export interface CreativePlanner {
  propose(context: CreativePlannerContext, signal?: AbortSignal): Promise<string>;
}
