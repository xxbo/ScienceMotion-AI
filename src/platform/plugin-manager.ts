import type { AgentTool } from "../contracts/agent-tool";
import type {
  AgentToolPlugin,
  PluginOperationResult,
  PluginStatus,
} from "../contracts/agent-plugin";
import { InMemoryAgentToolRegistry } from "./tool-registry";

interface InstalledPlugin {
  plugin: AgentToolPlugin;
  status: PluginStatus;
}

/** In-process plugin lifecycle manager. Plugin code is supplied by the host; this is not a sandbox. */
export class InMemoryPluginManager {
  private readonly plugins = new Map<string, InstalledPlugin>();

  constructor(private readonly registry: InMemoryAgentToolRegistry) {}

  install(plugin: AgentToolPlugin, installedAt = new Date().toISOString()): PluginOperationResult {
    const { id, version, toolIds } = plugin.manifest;
    if (!/^[a-z][a-z0-9._-]+$/.test(id)) return this.failure(id, version, "PLUGIN_INVALID_ID", "Invalid plugin ID");
    if (!/^\d+\.\d+\.\d+$/.test(version)) return this.failure(id, version, "PLUGIN_INVALID_VERSION", "Plugin version must be MAJOR.MINOR.PATCH");
    if (this.plugins.has(id)) return this.failure(id, version, "PLUGIN_ALREADY_INSTALLED", `Plugin already installed: ${id}`);
    if (new Set(toolIds).size !== toolIds.length) return this.failure(id, version, "PLUGIN_DUPLICATE_TOOL", "Plugin manifest contains duplicate tool IDs");
    const actualIds = plugin.tools.map((tool) => tool.manifest.id);
    if (actualIds.length !== toolIds.length || toolIds.some((toolId) => !actualIds.includes(toolId))) {
      return this.failure(id, version, "PLUGIN_TOOL_MISMATCH", "Plugin toolIds must exactly match the supplied tool implementations");
    }
    for (const tool of plugin.tools) {
      if (tool.manifest.pluginId && tool.manifest.pluginId !== id) {
        return this.failure(id, version, "PLUGIN_TOOL_OWNER_MISMATCH", `Tool ${tool.manifest.id} declares a different plugin owner`);
      }
    }
    this.plugins.set(id, {
      plugin,
      status: { pluginId: id, version, state: "installed", installedAt },
    });
    return this.success(this.plugins.get(id)!.status);
  }

  enable(pluginId: string, enabledAt = new Date().toISOString()): PluginOperationResult {
    const entry = this.plugins.get(pluginId);
    if (!entry) return this.failure(pluginId, "0.0.0", "PLUGIN_NOT_FOUND", `Plugin not installed: ${pluginId}`);
    if (entry.status.state === "enabled") return this.success(entry.status);
    for (const dependency of entry.plugin.manifest.dependencies ?? []) {
      const installedDependency = this.plugins.get(dependency.pluginId);
      if (!installedDependency || installedDependency.status.state !== "enabled") {
        return this.failure(pluginId, entry.status.version, "PLUGIN_DEPENDENCY_NOT_ENABLED", `Required plugin is not enabled: ${dependency.pluginId}`);
      }
      if (dependency.versionRange && !this.satisfies(installedDependency.status.version, dependency.versionRange)) {
        return this.failure(pluginId, entry.status.version, "PLUGIN_DEPENDENCY_VERSION_MISMATCH", `Plugin ${dependency.pluginId} version ${installedDependency.status.version} does not satisfy ${dependency.versionRange}`);
      }
    }

    const registered: AgentTool[] = [];
    try {
      for (const tool of entry.plugin.tools) {
        this.registry.register(tool);
        registered.push(tool);
      }
      entry.status = { ...entry.status, state: "enabled", enabledAt, error: undefined };
      if (entry.plugin.healthCheck) {
        // Health checks are async in production; the sync lifecycle method records registration health.
        void entry.plugin.healthCheck().then((health) => {
          const current = this.plugins.get(pluginId);
          if (!current || current.status.state !== "enabled") return;
          current.status.lastHealthCheck = { ...health, checkedAt: new Date().toISOString() };
          if (!health.ok) current.status.error = health.message ?? "Plugin health check failed";
        }).catch((error: unknown) => {
          const current = this.plugins.get(pluginId);
          if (current) current.status.lastHealthCheck = {
            ok: false, checkedAt: new Date().toISOString(),
            message: error instanceof Error ? error.message : String(error),
          };
        });
      }
      return this.success(entry.status);
    } catch (error) {
      for (const tool of registered) this.registry.unregister(tool.manifest.id, tool.manifest.version);
      const message = error instanceof Error ? error.message : String(error);
      entry.status = { ...entry.status, state: "failed", error: message };
      return this.failure(pluginId, entry.status.version, "PLUGIN_ENABLE_FAILED", message, entry.status);
    }
  }

  disable(pluginId: string): PluginOperationResult {
    const entry = this.plugins.get(pluginId);
    if (!entry) return this.failure(pluginId, "0.0.0", "PLUGIN_NOT_FOUND", `Plugin not installed: ${pluginId}`);
    const dependents = [...this.plugins.values()].filter((candidate) =>
      candidate.status.state === "enabled" &&
      (candidate.plugin.manifest.dependencies ?? []).some((dependency) => dependency.pluginId === pluginId)
    );
    if (dependents.length) {
      return this.failure(pluginId, entry.status.version, "PLUGIN_HAS_ENABLED_DEPENDENTS",
        `Disable dependent plugins first: ${dependents.map((item) => item.status.pluginId).join(", ")}`);
    }
    for (const tool of entry.plugin.tools) this.registry.unregister(tool.manifest.id, tool.manifest.version);
    entry.status = { ...entry.status, state: "disabled", enabledAt: undefined };
    return this.success(entry.status);
  }

  uninstall(pluginId: string): PluginOperationResult {
    const entry = this.plugins.get(pluginId);
    if (!entry) return this.failure(pluginId, "0.0.0", "PLUGIN_NOT_FOUND", `Plugin not installed: ${pluginId}`);
    if (entry.status.state === "enabled") return this.failure(pluginId, entry.status.version, "PLUGIN_MUST_BE_DISABLED", "Disable plugin before uninstalling");
    const dependents = [...this.plugins.values()].filter((candidate) =>
      (candidate.plugin.manifest.dependencies ?? []).some((dependency) => dependency.pluginId === pluginId)
    );
    if (dependents.length) {
      return this.failure(pluginId, entry.status.version, "PLUGIN_HAS_DEPENDENTS",
        `Uninstall dependent plugins first: ${dependents.map((item) => item.status.pluginId).join(", ")}`);
    }
    this.plugins.delete(pluginId);
    return this.success(entry.status);
  }

  getStatus(pluginId: string): PluginStatus | undefined {
    const status = this.plugins.get(pluginId)?.status;
    return status ? structuredClone(status) : undefined;
  }

  list(): PluginStatus[] {
    return [...this.plugins.values()].map((entry) => structuredClone(entry.status))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  private satisfies(version: string, range: string): boolean {
    if (range === "*" || range === version) return true;
    if (range.startsWith("^")) {
      const [major] = range.slice(1).split(".").map(Number);
      const [actualMajor] = version.split(".").map(Number);
      return major === actualMajor && this.compareVersion(version, range.slice(1)) >= 0;
    }
    return false;
  }

  private compareVersion(a: string, b: string): number {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
    return 0;
  }

  private success(status: PluginStatus): PluginOperationResult {
    return { ok: true, status: structuredClone(status), diagnostics: [] };
  }

  private failure(
    pluginId: string, version: string, code: string, message: string, existing?: PluginStatus
  ): PluginOperationResult {
    return {
      ok: false,
      status: existing ? structuredClone(existing) : {
        pluginId, version, state: "failed", installedAt: new Date(0).toISOString(), error: message,
      },
      diagnostics: [{ code, message }],
    };
  }
}
