import type { AgentTool } from "./agent-tool";

export interface PluginDependency {
  pluginId: string;
  /** Supported: *, exact MAJOR.MINOR.PATCH, ^MAJOR.MINOR.PATCH, ~MAJOR.MINOR.PATCH. */
  versionRange?: string;
  optional?: boolean;
}

export interface AgentToolPluginManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  author?: string;
  dependencies?: PluginDependency[];
  toolIds: string[];
  permissions?: string[];
  lifecycle?: "stable" | "beta" | "deprecated";
  projectSchemaVersions?: string[];
}

export interface AgentToolPlugin {
  readonly manifest: AgentToolPluginManifest;
  readonly tools: AgentTool[];
  /** Read-only preflight; tools are not published until this succeeds. */
  healthCheck?: () => Promise<{ ok: boolean; message?: string }>;
}

export type PluginState = "installed" | "enabled" | "disabled" | "failed";
export interface PluginStatus {
  pluginId: string;
  version: string;
  state: PluginState;
  installedAt: string;
  enabledAt?: string;
  lastHealthCheck?: { ok: boolean; checkedAt: string; message?: string };
  error?: string;
  pinned?: boolean;
}
export interface PluginDiagnostic { code: string; message: string }
export interface PluginOperationResult {
  ok: boolean;
  status: PluginStatus;
  diagnostics: PluginDiagnostic[];
}

/** Registry operations must be synchronous and must not invoke plugin code. */
export interface PluginToolRegistry {
  register(tool: AgentTool): void;
  unregister(toolId: string, version: string): boolean;
  getImplementation(toolId: string, version?: string): AgentTool | undefined;
}

/** Host-serialized version choices, not a bundle of executable plugin code. */
export interface PluginLockDocument {
  schemaVersion: "1.0.0";
  projectSchemaVersion: string;
  plugins: Record<string, string>;
}
export interface PluginLockResult {
  ok: boolean;
  diagnostics: PluginDiagnostic[];
}
export interface PluginManagerOptions {
  projectSchemaVersion?: string;
  healthCheckTimeoutMs?: number;
}
