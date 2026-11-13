import Ajv, { type ValidateFunction } from "ajv";
import { InMemoryToolExecutionStore, hashToolInput } from "./tool-execution-store";
import type { ToolExecutionRecord, ToolExecutionStore } from "../contracts/agent-tool";
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
