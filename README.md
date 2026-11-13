import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, AgentToolManifest, ToolResult } from "../contracts/agent-tool";
import type { AgentToolPlugin } from "../contracts/agent-plugin";
import { InMemoryAgentToolRegistry } from "./tool-registry";
import { InMemoryPluginManager } from "./plugin-manager";

function tool(id: string, pluginId: string): AgentTool<unknown, unknown> {
  const manifest: AgentToolManifest = {
    id, version: "1.0.0", namespace: id.split(".").slice(0, -1).join("."),
    name: id, description: `Test tool ${id}`, category: "test", pluginId,
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    execution: { deterministic: true, stateful: false, destructive: false, cost: "low" },
  };
  return { manifest, execute: async (): Promise<ToolResult<unknown>> => ({ ok: true, output: {}, diagnostics: [] }) };
}

function plugin(
  id: string,
  tools: AgentTool<unknown, unknown>[] = [tool(`${id}.run`, id)],
  extras: Partial<AgentToolPlugin["manifest"]> = {},
  healthCheck?: AgentToolPlugin["healthCheck"]
): AgentToolPlugin {
  return {
    manifest: { id, version: "1.0.0", name: id, description: `Plugin ${id}`, toolIds: tools.map((item) => item.manifest.id), ...extras },
    tools,
    healthCheck,
  };
}

test("plugin installs disabled and exposes isolated status copies", () => {
  const registry = new InMemoryAgentToolRegistry();
  const manager = new InMemoryPluginManager(registry);
  const installed = manager.install(plugin("science.math"));
  assert.equal(installed.ok, true);
  assert.equal(installed.status.state, "installed");
  assert.equal(registry.getImplementation("science.math.run"), undefined);
  const status = manager.getStatus("science.math")!;
  status.state = "failed";
  assert.equal(manager.getStatus("science.math")?.state, "installed");
});

test("plugin enable registers tools and disable unregisters them", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const manager = new InMemoryPluginManager(registry);
  manager.install(plugin("science.math"));
  assert.equal((await manager.enable("science.math")).status.state, "enabled");
  assert.ok(await registry.get("science.math.run"));
  assert.equal(manager.disable("science.math").status.state, "disabled");
  assert.equal(await registry.get("science.math.run"), undefined);
});

test("plugin dependencies require enabled compatible versions", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const manager = new InMemoryPluginManager(registry);
  manager.install(plugin("science.base"));
  manager.install(plugin("science.advanced", undefined, {
    dependencies: [{ pluginId: "science.base", versionRange: "^1.0.0" }],
  }));
  assert.equal((await manager.enable("science.advanced")).diagnostics[0].code, "PLUGIN_DEPENDENCY_NOT_ENABLED");
  await manager.enable("science.base");
  assert.equal((await manager.enable("science.advanced")).ok, true);
  assert.equal(manager.disable("science.base").diagnostics[0].code, "PLUGIN_HAS_ENABLED_DEPENDENTS");
});

test("plugin enable rolls back partial registration on collision", async () => {
  const registry = new InMemoryAgentToolRegistry();
  registry.register(tool("science.shared.run", "other.plugin"));
  const manager = new InMemoryPluginManager(registry);
  const first = tool("science.first.run", "science.bundle");
  const collision = tool("science.shared.run", "science.bundle");
  manager.install(plugin("science.bundle", [first, collision]));
  const result = await manager.enable("science.bundle");
  assert.equal(result.ok, false);
  assert.equal(result.status.state, "failed");
  assert.equal(await registry.get("science.first.run"), undefined);
  assert.equal((await registry.get("science.shared.run"))?.id, "science.shared.run");
});

test("unhealthy plugin is rolled back and marked failed", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const manager = new InMemoryPluginManager(registry);
  manager.install(plugin("science.unhealthy", undefined, {}, async () => ({ ok: false, message: "dependency unavailable" })));
  const result = await manager.enable("science.unhealthy");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "PLUGIN_HEALTH_CHECK_FAILED");
  assert.equal(result.status.state, "failed");
  assert.equal(await registry.get("science.unhealthy.run"), undefined);
});

test("plugin uninstall requires disabled state and no dependents", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const manager = new InMemoryPluginManager(registry);
  manager.install(plugin("science.base"));
  manager.install(plugin("science.ext", undefined, { dependencies: [{ pluginId: "science.base" }] }));
  assert.equal(manager.uninstall("science.base").diagnostics[0].code, "PLUGIN_HAS_DEPENDENTS");
  await manager.enable("science.base");
  assert.equal(manager.uninstall("science.base").diagnostics[0].code, "PLUGIN_MUST_BE_DISABLED");
  manager.disable("science.base");
  assert.equal(manager.uninstall("science.base").ok, false);
  manager.uninstall("science.ext");
  assert.equal(manager.uninstall("science.base").ok, true);
});
