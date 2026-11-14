export type ToolCost = "low" | "medium" | "high";
export type ToolLifecycle = "stable" | "beta" | "deprecated";
export interface ToolExample<TInput = unknown> { input: TInput; description?: string }
export interface AgentToolManifest<TInput = unknown, TOutput = unknown> {
  id: string; version: string; namespace: string; name: string; description: string; category: string;
  tags?: string[]; examples?: ToolExample<TInput>[];
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  capabilities?: string[]; engines?: string[]; projectSchemaVersions?: string[];
  lifecycle?: ToolLifecycle; pluginId?: string;
  execution: { deterministic: boolean; stateful: boolean; destructive: boolean; cost: ToolCost;
    timeoutMs?: number; permissions?: string[]; supportsCancellation?: boolean;
    idempotent?: boolean; maxConcurrency?: number };
  artifacts?: string[];
}
export interface ToolCallContext {
  projectId: string; runId: string; callId: string; signal?: AbortSignal; idempotencyKey?: string;
}
export interface ToolDiagnostic {
  level: "info" | "warning" | "error"; code: string; message: string; details?: Record<string, unknown>;
}
export interface ToolArtifact { id: string; mediaType: string; uri: string; contentHash?: string }
export interface ToolResult<TOutput = unknown> {
  ok: boolean; output?: TOutput; diagnostics: ToolDiagnostic[]; artifacts?: ToolArtifact[];
  metadata?: { toolId?: string; toolVersion?: string; durationMs?: number; retryable?: boolean;
    attempt?: number; idempotencyKey?: string; outcomeUnknown?: boolean };
}
export interface ToolSearchQuery {
  text?: string; namespaces?: string[]; categories?: string[]; tags?: string[];
  capabilities?: string[]; engines?: string[]; projectSchemaVersion?: string;
  includeDeprecated?: boolean; limit?: number; offset?: number;
}
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly manifest: AgentToolManifest<TInput, TOutput>;
  execute(input: TInput, context: ToolCallContext): Promise<ToolResult<TOutput>>;
}
export interface AgentToolRegistry {
  search(query: string, categories?: string[]): Promise<AgentToolManifest[]>;
  discover(query: ToolSearchQuery): Promise<{ tools: AgentToolManifest[]; total: number; limit: number; offset: number }>;
  get(toolId: string, version?: string): Promise<AgentToolManifest | undefined>;
  list(categories?: string[]): Promise<AgentToolManifest[]>;
}
export interface AgentToolGateway {
  invoke<TInput = unknown, TOutput = unknown>(toolId: string, input: TInput, context: ToolCallContext): Promise<ToolResult<TOutput>>;
}
export type ToolExecutionStatus = "started" | "succeeded" | "failed" | "cancelled" | "timed-out" | "interrupted";
export interface ToolExecutionRecord {
  id: string; toolId: string; toolVersion: string; projectId: string; runId: string; callId: string;
  idempotencyKey?: string; status: ToolExecutionStatus; startedAt: string; completedAt?: string;
  durationMs?: number; inputHash: string; result?: ToolResult; errorCode?: string;
}
export type ToolExecutionReservation =
  | { acquired: true; token: string; record: ToolExecutionRecord }
  | { acquired: false; reason: "call-id" | "idempotency"; record: ToolExecutionRecord };
/** reserve is atomic; only its owner token may finish the immutable call identity. */
export interface ToolExecutionStore {
  getByIdempotencyKey(key: string): Promise<ToolExecutionRecord | undefined>;
  reserve(record: ToolExecutionRecord): Promise<ToolExecutionReservation>;
  finish(record: ToolExecutionRecord, token: string): Promise<void>;
  list(projectId?: string): Promise<ToolExecutionRecord[]>;
}
