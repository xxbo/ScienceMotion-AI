import Ajv, { type ValidateFunction } from "ajv";
import type {
  AgentTool,
  AgentToolGateway,
  AgentToolManifest,
  AgentToolRegistry,
  ToolCallContext,
  ToolResult,
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
  /** If provided, every permission declared by a tool must be present here. */
  allowedPermissions?: string[];
  onEvent?: (event: ToolExecutionEvent) => void;
}

type RegisteredTool = AgentTool<unknown, unknown>;

export class InMemoryAgentToolRegistry implements AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const key = this.key(tool.manifest.id, tool.manifest.version);
    if (this.tools.has(key)) {
      throw new Error(`Tool already registered: ${key}`);
    }
    this.tools.set(key, tool);
  }

  unregister(toolId: string, version: string): boolean {
    return this.tools.delete(this.key(toolId, version));
  }

  async search(query: string, categories: string[] = []): Promise<AgentToolManifest[]> {
    const normalized = query.trim().toLowerCase();
    return this.list(categories).then((items) =>
      items.filter((item) => {
        if (!normalized) return true;
        const haystack = [
          item.id,
          item.name,
          item.description,
          item.category,
          ...(item.capabilities ?? []),
        ].join(" ").toLowerCase();
        return haystack.includes(normalized);
      })
    );
  }

  async get(toolId: string, version?: string): Promise<AgentToolManifest | undefined> {
    if (version) return this.tools.get(this.key(toolId, version))?.manifest;
    const candidates = [...this.tools.values()].filter((tool) => tool.manifest.id === toolId);
    candidates.sort((a, b) => b.manifest.version.localeCompare(a.manifest.version, undefined, { numeric: true }));
    return candidates[0]?.manifest;
  }

  async list(categories: string[] = []): Promise<AgentToolManifest[]> {
    const allowed = new Set(categories);
    return [...this.tools.values()]
      .map((tool) => tool.manifest)
      .filter((manifest) => allowed.size === 0 || allowed.has(manifest.category))
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  getImplementation(toolId: string, version?: string): RegisteredTool | undefined {
    if (version) return this.tools.get(this.key(toolId, version));
    const candidates = [...this.tools.values()].filter((tool) => tool.manifest.id === toolId);
    candidates.sort((a, b) => b.manifest.version.localeCompare(a.manifest.version, undefined, { numeric: true }));
    return candidates[0];
  }

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}

export class LocalAgentToolGateway implements AgentToolGateway {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly options: ToolGatewayOptions;

  constructor(
    private readonly registry: InMemoryAgentToolRegistry,
    options: ToolGatewayOptions = {}
  ) {
    this.options = options;
  }

  async invoke<TInput = unknown, TOutput = unknown>(
    toolId: string,
    input: TInput,
    context: ToolCallContext
  ): Promise<ToolResult<TOutput>> {
    const tool = this.registry.getImplementation(toolId);
    if (!tool) {
      return this.failure("TOOL_NOT_FOUND", `No registered tool matches ${toolId}`);
    }

    const manifest = tool.manifest;
    const required = manifest.execution.permissions ?? [];
    const allowed = this.options.allowedPermissions;
    if (allowed && required.some((permission) => !allowed.includes(permission))) {
      return this.failure("TOOL_PERMISSION_DENIED", `Missing permission for tool ${toolId}`);
    }

    const validateInput = this.compile(manifest.inputSchema);
    if (!validateInput(input)) {
      return this.failure("TOOL_INPUT_INVALID", this.formatErrors(validateInput));
    }

    const started = Date.now();
    this.options.onEvent?.({
      phase: "started",
      toolId,
      toolVersion: manifest.version,
      projectId: context.projectId,
      runId: context.runId,
      callId: context.callId,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = manifest.execution.timeoutMs ?? 30_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const execution = tool.execute(input, context);
      const result = await Promise.race([execution, timeoutPromise]);
      const validateOutput = this.compile(manifest.outputSchema);
      if (result.ok && result.output !== undefined && !validateOutput(result.output)) {
        throw new Error(`Tool output does not match its declared schema: ${this.formatErrors(validateOutput)}`);
      }
      this.options.onEvent?.({
        phase: "completed",
        toolId,
        toolVersion: manifest.version,
        projectId: context.projectId,
        runId: context.runId,
        callId: context.callId,
        durationMs: Date.now() - started,
      });
      return result as ToolResult<TOutput>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onEvent?.({
        phase: "failed",
        toolId,
        toolVersion: manifest.version,
        projectId: context.projectId,
        runId: context.runId,
        callId: context.callId,
        durationMs: Date.now() - started,
        message,
      });
      return this.failure("TOOL_EXECUTION_FAILED", message);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private compile(schema: Record<string, unknown>): ValidateFunction {
    return this.ajv.compile(schema);
  }

  private formatErrors(validate: ValidateFunction): string {
    return (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
  }

  private failure(code: string, message: string): ToolResult<never> {
    return {
      ok: false,
      diagnostics: [{ level: "error", code, message }],
    };
  }
}
