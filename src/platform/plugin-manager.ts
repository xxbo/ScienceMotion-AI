import type { AgentTool } from "../contracts/agent-tool";
import type {
  AgentToolPlugin, PluginDiagnostic, PluginLockDocument, PluginLockResult,
  PluginManagerOptions, PluginOperationResult, PluginStatus, PluginToolRegistry,
} from "../contracts/agent-plugin";
import { comparePluginVersions, isPluginVersion, isPluginVersionRange, satisfiesPluginVersion } from "./plugin-versions";

interface InstalledPlugin { plugin: AgentToolPlugin; status: PluginStatus }
const validId = (id: string): boolean => typeof id === "string" && /^[a-z][a-z0-9._-]+$/.test(id);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const diagnostic = (code: string, message: string): PluginDiagnostic => ({ code, message });

/** Trusted in-process plugins. Multiple versions installed; one active version per ID. */
export class InMemoryPluginManager {
  private readonly plugins = new Map<string, Map<string, InstalledPlugin>>();
  private readonly active = new Map<string, string>();
  private readonly pins = new Map<string, string>();
  private readonly previous = new Map<string, string>();
  private busy = false;
  private readonly projectSchemaVersion: string;
  private readonly healthCheckTimeoutMs: number;

  constructor(private readonly registry: PluginToolRegistry, options: PluginManagerOptions = {}) {
    this.projectSchemaVersion = options.projectSchemaVersion ?? "1.1.0";
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 5000;
    if (!isPluginVersion(this.projectSchemaVersion)) throw new Error("Invalid project schema version");
    if (!Number.isSafeInteger(this.healthCheckTimeoutMs) || this.healthCheckTimeoutMs < 1 || this.healthCheckTimeoutMs > 2147483647) {
      throw new Error("Health check timeout must be a positive timer-safe integer");
    }
  }

  install(plugin: AgentToolPlugin, installedAt = new Date().toISOString()): PluginOperationResult {
    const { id, version, toolIds } = plugin.manifest;
    if (this.busy) return this.failure(id, version, "PLUGIN_BUSY", "A version transition is in progress");
    if (!validId(id)) return this.failure(id, version, "PLUGIN_INVALID_ID", "Invalid plugin ID");
    if (!isPluginVersion(version)) return this.failure(id, version, "PLUGIN_INVALID_VERSION", "Expected a stable MAJOR.MINOR.PATCH version");
    if (this.plugins.get(id)?.has(version)) return this.failure(id, version, "PLUGIN_ALREADY_INSTALLED", `Already installed: ${id}@${version}`);
    if (!plugin.manifest.name?.trim() || !plugin.manifest.description?.trim()) return this.failure(id, version, "PLUGIN_INVALID_MANIFEST", "Name and description are required");
    if (!Array.isArray(toolIds) || new Set(toolIds).size !== toolIds.length) return this.failure(id, version, "PLUGIN_DUPLICATE_TOOL", "Duplicate or invalid tool IDs");
    const actualIds = plugin.tools.map((tool) => tool.manifest.id);
    if (actualIds.length !== toolIds.length || new Set(actualIds).size !== actualIds.length || toolIds.some((toolId) => !actualIds.includes(toolId))) {
      return this.failure(id, version, "PLUGIN_TOOL_MISMATCH", "toolIds must exactly match unique tool implementations");
    }
    const dependencyIds = new Set<string>();
    for (const dependency of plugin.manifest.dependencies ?? []) {
      if (!validId(dependency.pluginId) || dependencyIds.has(dependency.pluginId) || !isPluginVersionRange(dependency.versionRange ?? "*")) {
        return this.failure(id, version, "PLUGIN_INVALID_DEPENDENCY", "Duplicate dependency, invalid ID, or unsupported version range");
      }
      dependencyIds.add(dependency.pluginId);
    }
    if (plugin.manifest.projectSchemaVersions?.some((v) => !isPluginVersion(v))) return this.failure(id, version, "PLUGIN_INVALID_COMPATIBILITY", "Invalid project schema version");
    for (const tool of plugin.tools) {
      if (tool.manifest.pluginId && tool.manifest.pluginId !== id) return this.failure(id, version, "PLUGIN_TOOL_OWNER_MISMATCH", `Different owner for ${tool.manifest.id}`);
      if (typeof tool.execute !== "function") return this.failure(id, version, "PLUGIN_INVALID_TOOL", "Tool execute must be a function");
    }
    // Retain bound code, but detach/freeze metadata so callers cannot alter installed policy.
    const owned: AgentToolPlugin = {
      manifest: freeze(structuredClone(plugin.manifest)),
      tools: plugin.tools.map((tool) => Object.freeze({
        manifest: freeze(structuredClone(tool.manifest)), execute: tool.execute.bind(tool),
      })),
      healthCheck: plugin.healthCheck?.bind(plugin),
    };
    Object.freeze(owned.tools);
    const entry = { plugin: owned, status: { pluginId: id, version, state: "installed" as const, installedAt } };
    if (!this.plugins.has(id)) this.plugins.set(id, new Map());
    this.plugins.get(id)!.set(version, entry);
    return this.success(entry.status);
  }

  /** Existing API: enable the active/pinned version, otherwise the latest installed version. */
  async enable(pluginId: string, enabledAt = new Date().toISOString()): Promise<PluginOperationResult> {
    const entry = this.select(pluginId);
    if (!entry) return this.failure(pluginId, "0.0.0", "PLUGIN_NOT_FOUND", "Plugin not installed");
    return this.activate(pluginId, entry.status.version, enabledAt);
  }

  async activate(pluginId: string, version: string, enabledAt = new Date().toISOString()): Promise<PluginOperationResult> {
    const entry = this.select(pluginId, version);
    if (!entry) return this.failure(pluginId, version, "PLUGIN_NOT_FOUND", "Requested version is not installed");
    if (this.busy) return this.failure(pluginId, version, "PLUGIN_BUSY", "A version transition is in progress");
    const pin = this.pins.get(pluginId);
    if (pin && pin !== version) return this.failure(pluginId, version, "PLUGIN_VERSION_PINNED", `Unpin ${pluginId}@${pin} before switching`);
    if (this.active.get(pluginId) === version) return this.success(entry.status);
    const problems = this.diagnoseDependencies(pluginId, version);
    if (problems.length) return { ok: false, status: this.copyStatus(entry.status), diagnostics: problems };
    const old = this.select(pluginId, this.active.get(pluginId), true);
    this.busy = true;
    try {
      // Keep old tools available during asynchronous preflight; never expose unhealthy candidates.
      if (entry.plugin.healthCheck) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const health = await Promise.race([
            Promise.resolve().then(() => entry.plugin.healthCheck!()),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Plugin health check timed out")), this.healthCheckTimeoutMs); }),
          ]);
          entry.status.lastHealthCheck = { ...health, checkedAt: new Date().toISOString() };
          if (!health.ok) throw new Error(health.message ?? "Plugin health check failed");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          entry.status = { ...entry.status, state: "failed", error: message };
          return this.failure(pluginId, version, "PLUGIN_HEALTH_CHECK_FAILED", message);
        } finally { if (timer) clearTimeout(timer); }
      }
      // Recheck ownership after awaiting host code. Never remove a foreign registration.
      for (const tool of old?.plugin.tools ?? []) {
        if (this.registry.getImplementation(tool.manifest.id, tool.manifest.version) !== tool) throw new Error(`Registry ownership changed: ${tool.manifest.id}`);
      }
      for (const tool of entry.plugin.tools) {
        const existing = this.registry.getImplementation(tool.manifest.id, tool.manifest.version);
        if (existing && !old?.plugin.tools.includes(existing)) throw new Error(`Tool already registered: ${tool.manifest.id}@${tool.manifest.version}`);
      }
      const registered: AgentTool[] = [];
      // Synchronous publication: no await or plugin callback inside the replacement window.
      for (const tool of old?.plugin.tools ?? []) this.registry.unregister(tool.manifest.id, tool.manifest.version);
      try {
        for (const tool of entry.plugin.tools) { this.registry.register(tool); registered.push(tool); }
      } catch (error) {
        for (const tool of registered) this.registry.unregister(tool.manifest.id, tool.manifest.version);
        for (const tool of old?.plugin.tools ?? []) this.registry.register(tool);
        throw error;
      }
      if (old) {
        old.status = { ...old.status, state: "disabled", enabledAt: undefined };
        this.previous.set(pluginId, old.status.version);
      }
      entry.status = { ...entry.status, state: "enabled", enabledAt, error: undefined };
      this.active.set(pluginId, version);
      return this.success(entry.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.status = { ...entry.status, state: "failed", error: message };
      return this.failure(pluginId, version, "PLUGIN_ENABLE_FAILED", message);
    } finally { this.busy = false; }
  }

  async rollback(pluginId: string): Promise<PluginOperationResult> {
    const version = this.previous.get(pluginId);
    return version ? this.activate(pluginId, version) : this.failure(pluginId, "0.0.0", "PLUGIN_NO_PREVIOUS_VERSION", "No previous active version");
  }

  disable(pluginId: string): PluginOperationResult {
    const entry = this.select(pluginId);
    if (!entry) return this.failure(pluginId, "0.0.0", "PLUGIN_NOT_FOUND", "Plugin not installed");
    if (this.busy) return this.failure(pluginId, entry.status.version, "PLUGIN_BUSY", "A version transition is in progress");
    for (const [id, version] of this.active) {
      if (id !== pluginId && this.select(id, version)!.plugin.manifest.dependencies?.some((d) => d.pluginId === pluginId && !d.optional)) {
        return this.failure(pluginId, entry.status.version, "PLUGIN_HAS_ENABLED_DEPENDENTS", `Disable ${id} first`);
      }
    }
    if (this.active.has(pluginId)) {
      for (const tool of entry.plugin.tools) {
        if (this.registry.getImplementation(tool.manifest.id, tool.manifest.version) !== tool) return this.failure(pluginId, entry.status.version, "PLUGIN_REGISTRY_OWNERSHIP", "Registry ownership changed");
      }
      for (const tool of entry.plugin.tools) this.registry.unregister(tool.manifest.id, tool.manifest.version);
      this.active.delete(pluginId);
    }
    entry.status = { ...entry.status, state: "disabled", enabledAt: undefined };
    return this.success(entry.status);
  }

  uninstall(pluginId: string, version?: string): PluginOperationResult {
    const entry = this.select(pluginId, version);
    if (!entry) return this.failure(pluginId, version ?? "0.0.0", "PLUGIN_NOT_FOUND", "Plugin not installed");
    const selected = entry.status.version;
    if (this.busy) return this.failure(pluginId, selected, "PLUGIN_BUSY", "A version transition is in progress");
    if (this.active.get(pluginId) === selected) return this.failure(pluginId, selected, "PLUGIN_MUST_BE_DISABLED", "Disable plugin before uninstalling");
    if (this.pins.get(pluginId) === selected) return this.failure(pluginId, selected, "PLUGIN_VERSION_PINNED", "Unpin this version before uninstalling");
    if (this.plugins.get(pluginId)!.size === 1) {
      for (const [id, versions] of this.plugins) {
        for (const other of versions.values()) {
          if (id !== pluginId && other.plugin.manifest.dependencies?.some((d) => d.pluginId === pluginId && !d.optional)) return this.failure(pluginId, selected, "PLUGIN_HAS_DEPENDENTS", `Uninstall dependent ${id} first`);
        }
      }
    }
    this.plugins.get(pluginId)!.delete(selected);
    if (!this.plugins.get(pluginId)!.size) this.plugins.delete(pluginId);
    if (this.previous.get(pluginId) === selected) this.previous.delete(pluginId);
    return this.success(entry.status);
  }

  pin(pluginId: string, version: string): PluginOperationResult {
    const entry = this.select(pluginId, version);
    if (!entry) return this.failure(pluginId, version, "PLUGIN_NOT_FOUND", "Requested version is not installed");
    if (this.busy) return this.failure(pluginId, version, "PLUGIN_BUSY", "A version transition is in progress");
    if (this.active.has(pluginId) && this.active.get(pluginId) !== version) return this.failure(pluginId, version, "PLUGIN_LOCK_CONFLICT", "Pin must match the active version");
    this.pins.set(pluginId, version);
    return this.success(entry.status);
  }

  unpin(pluginId: string): PluginOperationResult {
    const entry = this.select(pluginId);
    if (!entry) return this.failure(pluginId, "0.0.0", "PLUGIN_NOT_FOUND", "Plugin not installed");
    if (this.busy) return this.failure(pluginId, entry.status.version, "PLUGIN_BUSY", "A version transition is in progress");
    this.pins.delete(pluginId);
    return this.success(entry.status);
  }

  getStatus(pluginId: string, version?: string): PluginStatus | undefined {
    const entry = this.select(pluginId, version);
    return entry ? this.copyStatus(entry.status) : undefined;
  }

  list(): PluginStatus[] {
    return [...this.plugins.values()].flatMap((versions) => [...versions.values()].map((e) => this.copyStatus(e.status)))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId) || comparePluginVersions(b.version, a.version));
  }

  /** Diagnostics are read-only. No automatic download, installation or activation. */
  diagnoseDependencies(pluginId: string, version?: string): PluginDiagnostic[] {
    const entry = this.select(pluginId, version);
    if (!entry) return [diagnostic("PLUGIN_NOT_FOUND", "Plugin not installed")];
    const errors = this.compatibility(entry);
    for (const dependency of entry.plugin.manifest.dependencies ?? []) {
      const activeVersion = this.active.get(dependency.pluginId);
      if (!activeVersion) {
        if (!dependency.optional) errors.push(diagnostic("PLUGIN_DEPENDENCY_NOT_ENABLED", `Required plugin is not enabled: ${dependency.pluginId}`));
      } else if (!satisfiesPluginVersion(activeVersion, dependency.versionRange)) {
        errors.push(diagnostic("PLUGIN_DEPENDENCY_VERSION_MISMATCH", `${dependency.pluginId}@${activeVersion} does not satisfy ${dependency.versionRange}`));
      }
    }
    for (const [id, activeVersion] of this.active) {
      if (id === pluginId) continue;
      for (const dependency of this.select(id, activeVersion)!.plugin.manifest.dependencies ?? []) {
        if (dependency.pluginId === pluginId && !satisfiesPluginVersion(entry.status.version, dependency.versionRange)) {
          errors.push(diagnostic("PLUGIN_BREAKS_DEPENDENT", `${id}@${activeVersion} requires ${dependency.pluginId} ${dependency.versionRange ?? "*"}`));
        }
      }
    }
    const selected = new Map<string, InstalledPlugin>();
    for (const id of this.plugins.keys()) selected.set(id, this.select(id)!);
    selected.set(pluginId, entry);
    errors.push(...this.cycles(selected, [pluginId]));
    return errors;
  }

  exportLock(): PluginLockDocument {
    const choices = new Map([...this.active, ...this.pins]);
    return { schemaVersion: "1.0.0", projectSchemaVersion: this.projectSchemaVersion,
      plugins: Object.fromEntries([...choices].sort(([a], [b]) => a.localeCompare(b))) };
  }

  /** Atomically pins installed versions. Does not install or activate plugin code. */
  importLock(lock: PluginLockDocument): PluginLockResult {
    const fail = (message: string): PluginLockResult => ({ ok: false, diagnostics: [diagnostic("PLUGIN_LOCK_INVALID", message)] });
    if (this.busy) return fail("A version transition is in progress");
    if (!lock || lock.schemaVersion !== "1.0.0" || lock.projectSchemaVersion !== this.projectSchemaVersion || !lock.plugins || typeof lock.plugins !== "object" || Array.isArray(lock.plugins)) return fail("Unsupported lock schema or project compatibility");
    const selected = new Map<string, InstalledPlugin>();
    for (const [id, version] of Object.entries(lock.plugins)) {
      if (!validId(id) || !isPluginVersion(version)) return fail("Invalid plugin ID or version");
      const entry = this.select(id, version);
      if (!entry) return fail(`Install ${id}@${version} before importing this lock`);
      if (this.active.has(id) && this.active.get(id) !== version) return fail(`Active version conflicts with lock: ${id}`);
      if (this.compatibility(entry).length) return fail(`Incompatible plugin: ${id}`);
      selected.set(id, entry);
    }
    for (const id of this.active.keys()) if (!selected.has(id)) return fail(`Lock omits active plugin: ${id}`);
    for (const entry of selected.values()) {
      for (const d of entry.plugin.manifest.dependencies ?? []) {
        const dependency = selected.get(d.pluginId);
        if (!dependency && d.optional) continue;
        if (!dependency || !satisfiesPluginVersion(dependency.status.version, d.versionRange)) return fail(`Unsatisfied locked dependency: ${d.pluginId}`);
      }
    }
    const cycles = this.cycles(selected, [...selected.keys()], true);
    if (cycles.length) return { ok: false, diagnostics: cycles };
    this.pins.clear();
    for (const [id, entry] of selected) this.pins.set(id, entry.status.version);
    return { ok: true, diagnostics: [] };
  }

  private select(id: string, version?: string, activeOnly = false): InstalledPlugin | undefined {
    const versions = this.plugins.get(id);
    if (!versions || (activeOnly && !version)) return undefined;
    const chosen = version ?? this.active.get(id) ?? this.pins.get(id) ?? [...versions.keys()].sort(comparePluginVersions).at(-1);
    return chosen ? versions.get(chosen) : undefined;
  }

  private compatibility(entry: InstalledPlugin): PluginDiagnostic[] {
    const manifests = [entry.plugin.manifest, ...entry.plugin.tools.map((tool) => tool.manifest)];
    return manifests.some((m) => m.projectSchemaVersions?.length && !m.projectSchemaVersions.includes(this.projectSchemaVersion))
      ? [diagnostic("PLUGIN_SCHEMA_INCOMPATIBLE", `Requires a different Project Schema than ${this.projectSchemaVersion}`)] : [];
  }

  private cycles(selected: Map<string, InstalledPlugin>, roots = [...selected.keys()], includeOptional = false): PluginDiagnostic[] {
    const done = new Set<string>();
    const visiting: string[] = [];
    const errors: PluginDiagnostic[] = [];
    const visit = (id: string): void => {
      const index = visiting.indexOf(id);
      if (index >= 0) { errors.push(diagnostic("PLUGIN_DEPENDENCY_CYCLE", [...visiting.slice(index), id].join(" -> "))); return; }
      if (done.has(id)) return;
      visiting.push(id);
      for (const d of selected.get(id)?.plugin.manifest.dependencies ?? []) if (selected.has(d.pluginId) && (!d.optional || includeOptional || this.active.has(d.pluginId))) visit(d.pluginId);
      visiting.pop(); done.add(id);
    };
    for (const id of roots) visit(id);
    return errors;
  }

  private copyStatus(status: PluginStatus): PluginStatus {
    return { ...structuredClone(status), pinned: this.pins.get(status.pluginId) === status.version };
  }
  private success(status: PluginStatus): PluginOperationResult { return { ok: true, status: this.copyStatus(status), diagnostics: [] }; }
  private failure(id: string, version: string, code: string, message: string): PluginOperationResult {
    const entry = this.select(id, version);
    return { ok: false, status: entry ? this.copyStatus(entry.status) : { pluginId: id, version, state: "failed", installedAt: new Date(0).toISOString(), error: message }, diagnostics: [diagnostic(code, message)] };
  }
}
