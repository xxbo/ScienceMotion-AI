import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "../contracts/agent-tool";
import type { AgentToolPlugin, PluginToolRegistry } from "../contracts/agent-plugin";
import { InMemoryPluginManager } from "./plugin-manager";
import { comparePluginVersions, isPluginVersion, isPluginVersionRange, satisfiesPluginVersion } from "./plugin-versions";

/** Contract double; existing plugin-manager.test.ts exercises the real registry in CI. */
class Registry implements PluginToolRegistry {
  private tools = new Map<string, AgentTool>();
  failNextId?: string;
  register(tool: AgentTool): void {
    if (this.failNextId === tool.manifest.id) { this.failNextId = undefined; throw new Error("injected registration failure"); }
    const key = `${tool.manifest.id}@${tool.manifest.version}`;
    if (this.tools.has(key)) throw new Error("duplicate tool");
    this.tools.set(key, tool);
  }
  unregister(id: string, version: string): boolean { return this.tools.delete(`${id}@${version}`); }
  getImplementation(id: string, version?: string): AgentTool | undefined {
    return version ? this.tools.get(`${id}@${version}`) : [...this.tools.values()].find((t) => t.manifest.id === id);
  }
}
const context = { projectId: "p", runId: "r", callId: "c" };
function plugin(id: string, version = "1.0.0", extras: Partial<AgentToolPlugin["manifest"]> = {}, healthCheck?: AgentToolPlugin["healthCheck"]): AgentToolPlugin {
  const tool: AgentTool = {
    manifest: { id: `${id}.run`, version: "1.0.0", namespace: id, name: id, description: id, category: "test", pluginId: id,
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: { deterministic: true, stateful: false, destructive: false, cost: "low" } },
    execute: async () => ({ ok: true, output: { version }, diagnostics: [] }),
  };
  return { manifest: { id, version, name: id, description: id, toolIds: [tool.manifest.id], ...extras }, tools: [tool], healthCheck };
}
const create = () => { const registry = new Registry(); return { registry, manager: new InMemoryPluginManager(registry) }; };

test("version grammar rejects ambiguous, unsafe and unsupported versions/ranges", () => {
  for (const v of ["1.0.0", "0.2.3", "12.34.56"]) assert.ok(isPluginVersion(v));
  for (const v of ["01.2.3", "1.2", "v1.2.3", "1.2.3-beta", "1.2.3+build", "9007199254740992.0.0", "1x2x3"]) assert.equal(isPluginVersion(v), false);
  for (const r of ["*", "1.2.3", "^0.2.3", "~1.2.3"]) assert.ok(isPluginVersionRange(r));
  for (const r of ["^1", ">=1.0.0", "1.x", "1.0.0 || 2.0.0", " ^1.0.0"]) assert.equal(isPluginVersionRange(r), false);
  assert.equal(comparePluginVersions("1.10.0", "1.9.0"), 1);
});

test("caret and tilde ranges enforce zero-major and lower bounds", () => {
  assert.ok(satisfiesPluginVersion("1.9.9", "^1.2.3"));
  assert.equal(satisfiesPluginVersion("2.0.0", "^1.2.3"), false);
  assert.equal(satisfiesPluginVersion("1.2.2", "^1.2.3"), false);
  assert.ok(satisfiesPluginVersion("0.2.9", "^0.2.3"));
  assert.equal(satisfiesPluginVersion("0.3.0", "^0.2.3"), false);
  assert.equal(satisfiesPluginVersion("0.0.4", "^0.0.3"), false);
  assert.ok(satisfiesPluginVersion("0.0.3", "^0.0.3"));
  assert.ok(satisfiesPluginVersion("1.2.9", "~1.2.3"));
  assert.equal(satisfiesPluginVersion("1.3.0", "~1.2.3"), false);
});

test("two versions install without publishing tools; activation selects exactly one", async () => {
  const { registry, manager } = create();
  assert.ok(manager.install(plugin("science.draw")).ok);
  assert.ok(manager.install(plugin("science.draw", "2.0.0")).ok);
  assert.equal(registry.getImplementation("science.draw.run"), undefined);
  assert.equal(manager.list().length, 2);
  assert.ok((await manager.activate("science.draw", "1.0.0")).ok);
  assert.ok((await manager.activate("science.draw", "2.0.0")).ok);
  assert.deepEqual((await registry.getImplementation("science.draw.run")!.execute({}, context)).output, { version: "2.0.0" });
  assert.equal(manager.getStatus("science.draw", "1.0.0")?.state, "disabled");
  assert.ok((await manager.rollback("science.draw")).ok);
  assert.deepEqual((await registry.getImplementation("science.draw.run")!.execute({}, context)).output, { version: "1.0.0" });
});

test("enable preserves the active version and honors pins instead of silently upgrading", async () => {
  const { manager } = create();
  manager.install(plugin("science.draw")); await manager.enable("science.draw");
  manager.install(plugin("science.draw", "2.0.0"));
  assert.equal((await manager.enable("science.draw")).status.version, "1.0.0");
  assert.ok(manager.pin("science.draw", "1.0.0").ok);
  assert.equal((await manager.activate("science.draw", "2.0.0")).diagnostics[0].code, "PLUGIN_VERSION_PINNED");
  manager.disable("science.draw");
  assert.equal(manager.uninstall("science.draw", "1.0.0").diagnostics[0].code, "PLUGIN_VERSION_PINNED");
  manager.unpin("science.draw");
  assert.ok((await manager.activate("science.draw", "2.0.0")).ok);
});

test("failed health preflight never exposes a new version or replaces the old one", async () => {
  const { registry, manager } = create();
  manager.install(plugin("science.draw")); await manager.enable("science.draw");
  const old = registry.getImplementation("science.draw.run");
  manager.install(plugin("science.draw", "2.0.0", {}, async () => ({ ok: false, message: "unhealthy" })));
  const result = await manager.activate("science.draw", "2.0.0");
  assert.equal(result.diagnostics[0].code, "PLUGIN_HEALTH_CHECK_FAILED");
  assert.equal(registry.getImplementation("science.draw.run"), old);
  assert.equal(manager.getStatus("science.draw")?.version, "1.0.0");
});

test("registration failure rolls back both partial new tools and old registration", async () => {
  const { registry, manager } = create();
  manager.install(plugin("science.draw")); await manager.enable("science.draw");
  const old = registry.getImplementation("science.draw.run");
  const next = plugin("science.draw", "2.0.0");
  const second = plugin("science.extra").tools[0];
  second.manifest.pluginId = "science.draw";
  const bundle = { ...next, tools: [...next.tools, second], manifest: { ...next.manifest, toolIds: [...next.manifest.toolIds, second.manifest.id] } };
  manager.install(bundle); registry.failNextId = "science.extra.run";
  assert.equal((await manager.activate("science.draw", "2.0.0")).ok, false);
  assert.equal(registry.getImplementation("science.draw.run"), old);
  assert.equal(registry.getImplementation("science.extra.run"), undefined);
});

test("dependency compatibility blocks a breaking upgrade before switching", async () => {
  const { manager } = create();
  manager.install(plugin("science.base")); manager.install(plugin("science.base", "2.0.0"));
  manager.install(plugin("science.child", "1.0.0", { dependencies: [{ pluginId: "science.base", versionRange: "^1.0.0" }] }));
  await manager.activate("science.base", "1.0.0"); await manager.enable("science.child");
  assert.equal((await manager.activate("science.base", "2.0.0")).diagnostics[0].code, "PLUGIN_BREAKS_DEPENDENT");
  assert.equal(manager.getStatus("science.base")?.version, "1.0.0");
});

test("dependency diagnostics identify missing dependencies, bad ranges and cycles", () => {
  const { manager } = create();
  assert.equal(manager.install(plugin("science.bad", "1.0.0", { dependencies: [{ pluginId: "science.base", versionRange: ">=1.0.0" }] })).diagnostics[0].code, "PLUGIN_INVALID_DEPENDENCY");
  manager.install(plugin("science.a", "1.0.0", { dependencies: [{ pluginId: "science.b" }] }));
  manager.install(plugin("science.b", "1.0.0", { dependencies: [{ pluginId: "science.a" }] }));
  const diagnostics = manager.diagnoseDependencies("science.a");
  assert.ok(diagnostics.some((d) => d.code === "PLUGIN_DEPENDENCY_NOT_ENABLED"));
  assert.ok(diagnostics.some((d) => d.code === "PLUGIN_DEPENDENCY_CYCLE"));
});

test("Project Schema incompatibility is rejected before health checks", async () => {
  const { manager } = create(); let checked = false;
  manager.install(plugin("science.draw", "1.0.0", { projectSchemaVersions: ["9.0.0"] }, async () => { checked = true; return { ok: true }; }));
  assert.equal((await manager.enable("science.draw")).diagnostics[0].code, "PLUGIN_SCHEMA_INCOMPATIBLE");
  assert.equal(checked, false);
});

test("version lock round-trips and failed import leaves existing pins untouched", async () => {
  const { manager } = create(); manager.install(plugin("science.draw")); await manager.enable("science.draw");
  const lock = JSON.parse(JSON.stringify(manager.exportLock()));
  const restored = create().manager; restored.install(plugin("science.draw"));
  assert.ok(restored.importLock(lock).ok);
  assert.equal(restored.getStatus("science.draw")?.pinned, true);
  assert.ok((await restored.enable("science.draw")).ok);
  const before = restored.exportLock();
  assert.equal(restored.importLock({ ...lock, plugins: { "science.draw": "8.0.0" } }).ok, false);
  assert.deepEqual(restored.exportLock(), before);
});

test("lock import validates dependency closure and Project Schema", () => {
  const { manager } = create();
  manager.install(plugin("science.child", "1.0.0", { dependencies: [{ pluginId: "science.base" }] }));
  assert.equal(manager.importLock({ schemaVersion: "1.0.0", projectSchemaVersion: "1.1.0", plugins: { "science.child": "1.0.0" } }).ok, false);
  assert.equal(manager.importLock({ schemaVersion: "1.0.0", projectSchemaVersion: "9.0.0", plugins: {} }).ok, false);
});

test("mutation during health check is rejected and old tools remain callable", async () => {
  const { registry, manager } = create();
  manager.install(plugin("science.draw")); await manager.enable("science.draw");
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  manager.install(plugin("science.draw", "2.0.0", {}, () => new Promise((resolve) => { release = () => resolve({ ok: true }); entered(); })));
  const upgrading = manager.activate("science.draw", "2.0.0"); await started;
  assert.deepEqual((await registry.getImplementation("science.draw.run")!.execute({}, context)).output, { version: "1.0.0" });
  assert.equal(manager.disable("science.draw").diagnostics[0].code, "PLUGIN_BUSY");
  assert.equal((await manager.activate("science.draw", "2.0.0")).diagnostics[0].code, "PLUGIN_BUSY");
  release(); assert.ok((await upgrading).ok);
});

test("health timeout keeps old version registered and releases transition lock", async () => {
  const registry = new Registry(); const manager = new InMemoryPluginManager(registry, { healthCheckTimeoutMs: 10 });
  manager.install(plugin("science.draw")); await manager.enable("science.draw");
  manager.install(plugin("science.draw", "2.0.0", {}, () => new Promise(() => {})));
  assert.equal((await manager.activate("science.draw", "2.0.0")).diagnostics[0].code, "PLUGIN_HEALTH_CHECK_FAILED");
  assert.ok(manager.disable("science.draw").ok);
});

test("disabling a failed colliding plugin does not unregister another owner's tool", async () => {
  const { registry, manager } = create(); const foreign = plugin("science.shared").tools[0];
  registry.register(foreign);
  const collision = plugin("science.shared"); manager.install(collision);
  assert.equal((await manager.enable("science.shared")).ok, false);
  manager.disable("science.shared");
  assert.equal(registry.getImplementation("science.shared.run"), foreign);
});

test("caller mutation cannot change installed dependency policy", async () => {
  const { manager } = create(); const candidate = plugin("science.draw");
  manager.install(candidate); candidate.manifest.dependencies = [{ pluginId: "missing.plugin" }];
  assert.ok((await manager.enable("science.draw")).ok);
});

test("inactive-version uninstall leaves the active version and its tools intact", async () => {
  const { registry, manager } = create(); manager.install(plugin("science.draw")); manager.install(plugin("science.draw", "2.0.0"));
  await manager.activate("science.draw", "2.0.0");
  assert.ok(manager.uninstall("science.draw", "1.0.0").ok);
  assert.equal(manager.getStatus("science.draw")?.version, "2.0.0");
  assert.ok(registry.getImplementation("science.draw.run"));
});


test("an unrelated inactive dependency cycle does not block a healthy plugin", async () => {
  const { manager } = create();
  manager.install(plugin("science.a", "1.0.0", { dependencies: [{ pluginId: "science.b" }] }));
  manager.install(plugin("science.b", "1.0.0", { dependencies: [{ pluginId: "science.a" }] }));
  manager.install(plugin("science.good"));
  assert.ok((await manager.enable("science.good")).ok);
});

test("lock import rejects a selected optional dependency cycle atomically", () => {
  const { manager } = create();
  manager.install(plugin("science.a", "1.0.0", { dependencies: [{ pluginId: "science.b", optional: true }] }));
  manager.install(plugin("science.b", "1.0.0", { dependencies: [{ pluginId: "science.a", optional: true }] }));
  const before = manager.exportLock();
  const result = manager.importLock({ schemaVersion: "1.0.0", projectSchemaVersion: "1.1.0", plugins: { "science.a": "1.0.0", "science.b": "1.0.0" } });
  assert.equal(result.diagnostics[0].code, "PLUGIN_DEPENDENCY_CYCLE");
  assert.deepEqual(manager.exportLock(), before);
});
