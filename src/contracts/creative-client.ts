import type { CreativeHostLimits, CreativeInvocation, CreativeSessionGrant } from "./creative-host";
import type { ToolSearchQuery } from "./agent-tool";
import type { RenderWorkerPolicy } from "./render-worker";
import type { CreativeJobPolicy, CreativeJobSubmission } from "./creative-jobs";

/** Local, sequential UTF-8 JSON Lines protocol. This is not an MCP or HTTP server. */
export const CREATIVE_CLIENT_PROTOCOL = "1.0.0" as const;
export const CREATIVE_CLIENT_JOB_PROTOCOL = "1.1.0" as const;
export type CreativeClientProtocol = typeof CREATIVE_CLIENT_PROTOCOL | typeof CREATIVE_CLIENT_JOB_PROTOCOL;
export type CreativeClientRequest = { id: string; note?: string } & (
  | { method: "discover"; params: ToolSearchQuery }
  | { method: "manifest"; params: { toolId: string } }
  | { method: "invoke"; params: Omit<CreativeInvocation, "signal"> }
  | { method: "jobs.submit"; params: CreativeJobSubmission }
  | { method: "jobs.get" | "jobs.cancel"; params: { jobId: string } }
  | { method: "jobs.list"; params: { offset?: number; limit?: number } }
  | { method: "close"; params: Record<string, never> }
);
export type CreativeClientResponse = { id: string | null } & (
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; fatal?: boolean; outcomeUnknown?: boolean } }
);
/** Trusted launch configuration, never accepted from the request stream. Paths are relative to this config file. */
export interface CreativeLocalConfig {
  schemaVersion: "1.0.0";
  /** Defaults to 1.0.0 to preserve historical clients. 1.1.0 adds background render jobs. */
  protocolVersion?: CreativeClientProtocol;
  directory: string;
  traceFile: string;
  grant: CreativeSessionGrant;
  limits?: Partial<CreativeHostLimits>;
  renderWorker?: Partial<RenderWorkerPolicy>;
  renderJobs?: Partial<CreativeJobPolicy>;
  maxRequestBytes?: number;
  maxTraceBytes?: number;
  /** Operator-supplied provenance, not provider attestation or executable configuration. */
  metadata?: Record<string, unknown>;
}
