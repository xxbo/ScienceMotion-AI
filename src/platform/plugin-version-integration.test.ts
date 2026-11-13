import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import type { AgentToolPlugin } from "../contracts/agent-plugin";
import { InMemoryPluginManager } from "./plugin-manager";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";
import pluginSchema from "../../schemas/plugin-manifest.schema.json";
import lockSchema from "../../schemas/plugin-lock.schema.json";

function plugin(version: string): AgentToolPlugin {
  return {
    manifest: { id: "science.versioned", version, name: "Versioned", description: "Integration fixture", toolIds: ["science.versioned.run"] },
    tools: [{
      manifest: { id: "science.versioned.run", version: "1.0.0", namespace: "science.versioned", name: "Run", description: "Return implementation version", category: "test", pluginId: "science.versioned",
        inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["version"], properties: { version: { type: "string" } } },
        execution: { deterministic: true, stateful: false, destructive: false, cost: "low" } },
      execute: async () => ({ ok: true, output: { version }, diagnostics: [] }),
    }],
  };
}

test("real registry and gateway use the selected plugin before and after upgrade and rollback", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const manager = new InMemoryPluginManager(registry);
  const gateway = new LocalAgentToolGateway(registry);
  assert.ok(manager.install(plugin("1.0.0")).ok);
  assert.ok(manager.install(plugin("2.0.0")).ok);
  const invoke = (callId: string) => gateway.invoke("science.versioned.run", {}, { projectId: "p-version", runId: "r-version", callId });
  assert.ok((await manager.activate("science.versioned", "1.0.0")).ok);
  assert.deepEqual((await invoke("old")).output, { version: "1.0.0" });
  assert.ok((await manager.activate("science.versioned", "2.0.0")).ok);
  assert.deepEqual((await invoke("new")).output, { version: "2.0.0" });
  assert.equal((await registry.discover({ namespaces: ["science.versioned"] })).total, 1);
  assert.ok((await manager.rollback("science.versioned")).ok);
  assert.deepEqual((await invoke("rollback")).output, { version: "1.0.0" });
});

test("plugin manifest and lock schemas accept runtime output and reject unsupported ranges", async () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const manifest = plugin("1.0.0").manifest;
  const validatePlugin = ajv.compile(pluginSchema);
  for (const range of ["*", "1.2.3", "^0.2.3", "~1.2.3"]) {
    assert.ok(validatePlugin({ ...manifest, dependencies: [{ pluginId: "science.base", versionRange: range }], projectSchemaVersions: ["1.1.0"] }), JSON.stringify(validatePlugin.errors));
  }
  for (const range of ["^1", ">=1.0.0", "01.0.0", "1x2x3"]) assert.equal(validatePlugin({ ...manifest, dependencies: [{ pluginId: "science.base", versionRange: range }] }), false);
  const manager = new InMemoryPluginManager(new InMemoryAgentToolRegistry());
  manager.install(plugin("1.0.0")); await manager.enable("science.versioned");
  const validateLock = ajv.compile(lockSchema);
  assert.ok(validateLock(manager.exportLock()), JSON.stringify(validateLock.errors));
  assert.equal(validateLock({ ...manager.exportLock(), plugins: { "science.versioned": "^1.0.0" } }), false);
});
