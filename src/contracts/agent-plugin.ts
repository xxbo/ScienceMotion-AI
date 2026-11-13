import type { AgentTool, AgentToolManifest } from "../contracts/agent-tool";

export interface PluginDependency {
  pluginId: string;
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
}

export interface AgentToolPlugin {
  readonly manifest: AgentToolPluginManifest;
  readonly tools: AgentTool[];
  healthCheck?: () => Promise<{ ok: boolean; message?: string }>;
}

export type PluginState = "installed" | "enabled" | "disabled" | "failed";

export interface PluginStatus {
  pluginId: string;
  version: string;
  state: PluginState;
  installedAt: string;
  enabledAt?: string;
  lastHealthCheck?: {
    ok: boolean;
    checkedAt: string;
    message?: string;
  };
  error?: string;
}

export interface PluginOperationResult {
  ok: boolean;
  status: PluginStatus;
  diagnostics: Array<{ code: string; message: string }>;
}
