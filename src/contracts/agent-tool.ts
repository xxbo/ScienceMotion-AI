export type ToolCost = "low" | "medium" | "high";

export interface AgentToolManifest<TInput = unknown, TOutput = unknown> {
  id: string;
  version: string;
  name: string;
  description: string;
  category: string;
  examples?: Array<{ input: TInput; description?: string }>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  capabilities?: string[];
  engines?: string[];
  execution: {
    deterministic: boolean;
    stateful: boolean;
    destructive: boolean;
    cost: ToolCost;
    timeoutMs?: number;
    permissions?: string[];
  };
  artifacts?: string[];
}

export interface ToolCallContext {
  projectId: string;
  runId: string;
  callId: string;
  signal?: AbortSignal;
}

export interface ToolResult<TOutput = unknown> {
  ok: boolean;
  output?: TOutput;
  diagnostics: Array<{
    level: "info" | "warning" | "error";
    code: string;
    message: string;
  }>;
  artifacts?: Array<{
    id: string;
    mediaType: string;
    uri: string;
    contentHash?: string;
  }>;
}

/**
 * Tool implementations expose bounded creative capabilities to an AI agent.
 * The registry owns discovery and schema validation; the gateway owns execution
 * limits, permissions, logging, and artifact persistence.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly manifest: AgentToolManifest<TInput, TOutput>;
  execute(input: TInput, context: ToolCallContext): Promise<ToolResult<TOutput>>;
}

export interface AgentToolRegistry {
  search(query: string, categories?: string[]): Promise<AgentToolManifest[]>;
  get(toolId: string, version?: string): Promise<AgentToolManifest | undefined>;
  list(categories?: string[]): Promise<AgentToolManifest[]>;
}

export interface AgentToolGateway {
  invoke<TInput = unknown, TOutput = unknown>(
    toolId: string,
    input: TInput,
    context: ToolCallContext
  ): Promise<ToolResult<TOutput>>;
}
