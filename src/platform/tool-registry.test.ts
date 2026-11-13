import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, AgentToolManifest, ToolCallContext, ToolResult } from "../contracts/agent-tool";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";

const context: ToolCallContext = { projectId: "project-test", runId: "run-test", callId: "call-test" };

function makeTool(
  overrides: Partial<AgentToolManifest> = {},
  execute: (input: unknown, context: ToolCallContext) => Promise<ToolResult<unknown>> =
    async (input) => ({ ok: true, output: input, diagnostics: [] })
): AgentTool<unknown, unknown> {
  const manifest: AgentToolManifest = {
    id: "geometry.primitive.create",
    version: "1.2.0",
    namespace: "geometry",
    name: "Create Primitive",
    description: "Create a primitive geometry node in a project scene.",
    category: "geometry",
    tags: ["3d", "geometry", "create"],
    inputSchema: { type: "object", required: ["kind"], properties: { kind: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["kind"], properties: { kind: { type: "string" } }, additionalProperties: false },
    capabilities: ["project.write", "geometry.primitive"],
    engines: ["threejs", "blender"],
    projectSchemaVersions: ["1.1.0"],
    lifecycle: "stable",
    execution: { deterministic: true, stateful: true, destructive: false, cost: "low", timeoutMs: 500 },
    ...overrides,
  };
  return { manifest, execute };
}

test("registry rejects invalid namespace, non-semver versions, and duplicate registrations", () => {
  const registry = new InMemoryAgentToolRegistry();
  assert.throws(() => registry.register(makeTool({ namespace: "bad namespace" })), /Invalid tool namespace/);
  assert.throws(() => registry.register(makeTool({ version: "v1" })), /Invalid semantic version/);
  registry.register(makeTool());
  assert.throws(() => registry.register(makeTool()), /already registered/);
});

test("registry resolves latest semantic version numerically", async () => {
  const registry = new InMemoryAgentToolRegistry();
  registry.register(makeTool({ version: "1.9.0" }));
  registry.register(makeTool({ version: "1.10.0" }));
  assert.equal((await registry.get("geometry.primitive.create"))?.version, "1.10.0");
  assert.equal((await registry.get("geometry.primitive.create", "1.9.0"))?.version, "1.9.0");
});

test("discovery filters namespace, tags, capabilities, engines and project schema", async () => {
  const registry = new InMemoryAgentToolRegistry();
  registry.register(makeTool());
  registry.register(makeTool({
    id: "graphics.2d.text.create", namespace: "graphics.2d", category: "graphics",
    tags: ["2d", "text"], capabilities: ["graphics.text"], engines: ["remotion"],
  }));
  const result = await registry.discover({
    namespaces: ["geometry"], tags: ["3d"], capabilities: ["geometry.primitive"],
    engines: ["blender"], projectSchemaVersion: "1.1.0",
  });
  assert.equal(result.total, 1);
  assert.equal(result.tools[0].id, "geometry.primitive.create");
  const incompatible = await registry.discover({ projectSchemaVersion: "9.0.0" });
  assert.equal(incompatible.total, 0);
});

test("discovery excludes deprecated tools by default and supports pagination", async () => {
  const registry = new InMemoryAgentToolRegistry();
  registry.register(makeTool({ id: "geometry.a.create", name: "A" }));
  registry.register(makeTool({ id: "geometry.b.create", name: "B" }));
  registry.register(makeTool({ id: "geometry.c.create", name: "C", lifecycle: "deprecated" }));
  const defaultResult = await registry.discover({ limit: 1 });
  assert.equal(defaultResult.total, 2);
  assert.equal(defaultResult.tools.length, 1);
  assert.equal((await registry.discover({ includeDeprecated: true })).total, 3);
  assert.equal((await registry.discover({ offset: 1, limit: 1 })).tools[0].id, "geometry.b.create");
});

test("gateway validates input/output and returns tool execution metadata", async () => {
  const registry = new InMemoryAgentToolRegistry();
  registry.register(makeTool());
  const gateway = new LocalAgentToolGateway(registry);
  const success = await gateway.invoke("geometry.primitive.create", { kind: "box" }, context);
  assert.equal(success.ok, true);
  assert.equal(success.metadata?.toolVersion, "1.2.0");
  const invalid = await gateway.invoke("geometry.primitive.create", { wrong: true }, context);
  assert.equal(invalid.diagnostics[0].code, "TOOL_INPUT_INVALID");
});

test("gateway enforces permissions before executing a tool", async () => {
  const registry = new InMemoryAgentToolRegistry();
  let called = false;
  registry.register(makeTool({ execution: { deterministic: true, stateful: true, destructive: false, cost: "low", permissions: ["project.write"] } }, async () => {
    called = true;
    return { ok: true, output: { kind: "box" }, diagnostics: [] };
  }));
  const gateway = new LocalAgentToolGateway(registry, { allowedPermissions: [] });
  const result = await gateway.invoke("geometry.primitive.create", { kind: "box" }, context);
  assert.equal(result.diagnostics[0].code, "TOOL_PERMISSION_DENIED");
  assert.equal(called, false);
});

test("gateway propagates caller cancellation to cooperative tool execution", async () => {
  const registry = new InMemoryAgentToolRegistry();
  let observedAbort = false;
  registry.register(makeTool({}, async (_input, callContext) => new Promise((resolve) => {
    callContext.signal?.addEventListener("abort", () => {
      observedAbort = true;
      resolve({ ok: false, diagnostics: [{ level: "error", code: "ABORTED", message: "cancelled" }] });
    }, { once: true });
  })));
  const controller = new AbortController();
  const gateway = new LocalAgentToolGateway(registry);
  const pending = gateway.invoke("geometry.primitive.create", { kind: "box" }, { ...context, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(observedAbort, true);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "TOOL_CANCELLED");
});

test("gateway timeout aborts cooperative execution", async () => {
  const registry = new InMemoryAgentToolRegistry();
  let observedAbort = false;
  registry.register(makeTool({ execution: { deterministic: true, stateful: false, destructive: false, cost: "low", timeoutMs: 10 } }, async (_input, callContext) => new Promise((resolve) => {
    callContext.signal?.addEventListener("abort", () => {
      observedAbort = true;
      resolve({ ok: false, diagnostics: [{ level: "error", code: "ABORTED", message: "timeout" }] });
    }, { once: true });
  })));
  const gateway = new LocalAgentToolGateway(registry);
  const result = await gateway.invoke("geometry.primitive.create", { kind: "box" }, context);
  assert.equal(observedAbort, true);
  assert.equal(result.diagnostics[0].code, "TOOL_CANCELLED");
});
