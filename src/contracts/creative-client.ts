import type { CreativeHostLimits, CreativeInvocation, CreativeSessionGrant } from "./creative-host";
import type { ToolSearchQuery } from "./agent-tool";
import type { RenderWorkerPolicy } from "./render-worker";

/** Local, sequential UTF-8 JSON Lines protocol. This is not an MCP or HTTP server. */
export const CREATIVE_CLIENT_PROTOCOL = "1.0.0" as const;
export type CreativeClientRequest = { id: string; note?: string } & (
  | { method: "discover"; params: ToolSearchQuery }
  | { method: "manifest"; params: { toolId: string } }
  | { method: "invoke"; params: Omit<CreativeInvocation, "signal"> }
  | { method: "close"; params: Record<string, never> }
);
export type CreativeClientResponse = { id: string | null } & (
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; fatal?: boolean; outcomeUnknown?: boolean } }
);
/** Trusted launch configuration, never accepted from the request stream. Paths are relative to this config file. */
export interface CreativeLocalConfig {
  schemaVersion: "1.0.0";
  directory: string;
  traceFile: string;
  grant: CreativeSessionGrant;
  limits?: Partial<CreativeHostLimits>;
  renderWorker?: Partial<RenderWorkerPolicy>;
  maxRequestBytes?: number;
  maxTraceBytes?: number;
  /** Operator-supplied provenance, not provider attestation or executable configuration. */
  metadata?: Record<string, unknown>;
}
