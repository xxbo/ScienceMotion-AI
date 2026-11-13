import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, AgentToolManifest, ToolCallContext, ToolResult } from "../contracts/agent-tool";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";
import { InMemoryToolExecutionStore } from "./tool-execution-store";
import { InMemoryArtifactStore } from "./artifact-store";

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
  await new Promise((resolve) => setImmediate(resolve));
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


test("gateway replays successful idempotent calls and rejects key reuse with different input", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const store = new InMemoryToolExecutionStore();
  let executions = 0;
  registry.register(makeTool({
    execution: { deterministic: true, stateful: true, destructive: false, cost: "low", idempotent: true },
  }, async (input) => {
    executions++;
    return { ok: true, output: input, diagnostics: [] };
  }));
  const gateway = new LocalAgentToolGateway(registry, { executionStore: store });
  const callContext = { ...context, idempotencyKey: "create-once" };
  const first = await gateway.invoke("geometry.primitive.create", { kind: "box" }, callContext);
  const replay = await gateway.invoke("geometry.primitive.create", { kind: "box" }, { ...callContext, callId: "call-replay" });
  const conflict = await gateway.invoke("geometry.primitive.create", { kind: "sphere" }, callContext);
  assert.equal(first.ok, true);
  assert.deepEqual(replay.output, first.output);
  assert.equal(conflict.diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
  assert.equal(executions, 1);
  const records = await store.list(context.projectId);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "succeeded");
});

test("gateway enforces per-tool concurrency limits", async () => {
  const registry = new InMemoryAgentToolRegistry();
  let release: (() => void) | undefined;
  registry.register(makeTool({
    execution: { deterministic: true, stateful: false, destructive: false, cost: "low", maxConcurrency: 1 },
  }, async () => new Promise((resolve) => {
    release = () => resolve({ ok: true, output: { kind: "box" }, diagnostics: [] });
  })));
  const gateway = new LocalAgentToolGateway(registry);
  const first = gateway.invoke("geometry.primitive.create", { kind: "box" }, context);
  await Promise.resolve();
  const second = await gateway.invoke("geometry.primitive.create", { kind: "box" }, { ...context, callId: "call-2" });
  assert.equal(second.diagnostics[0].code, "TOOL_CONCURRENCY_LIMIT");
  release?.();
  assert.equal((await first).ok, true);
});

test("gateway retries only explicitly retryable idempotent results and persists attempts", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const store = new InMemoryToolExecutionStore();
  let attempts = 0;
  registry.register(makeTool({
    execution: { deterministic: true, stateful: false, destructive: false, cost: "low", idempotent: true },
  }, async () => {
    attempts++;
    if (attempts === 1) return {
      ok: false,
      diagnostics: [{ level: "warning", code: "TEMPORARY", message: "try again" }],
      metadata: { retryable: true },
    };
    return { ok: true, output: { kind: "box" }, diagnostics: [] };
  }));
  const gateway = new LocalAgentToolGateway(registry, { executionStore: store, maxAttempts: 3 });
  const result = await gateway.invoke("geometry.primitive.create", { kind: "box" }, context);
  assert.equal(result.ok, true);
  assert.equal(result.metadata?.attempt, 2);
  assert.equal(attempts, 2);
  const records = await store.list(context.projectId);
  assert.equal(records[0].status, "succeeded");
  assert.equal(records[0].result?.metadata?.attempt, 2);
});

test("gateway records failed executions and does not retry non-idempotent tools", async () => {
  const registry = new InMemoryAgentToolRegistry();
  const store = new InMemoryToolExecutionStore();
  let attempts = 0;
  registry.register(makeTool({}, async () => {
    attempts++;
    return { ok: false, diagnostics: [{ level: "error", code: "BAD", message: "permanent" }], metadata: { retryable: true } };
  }));
  const gateway = new LocalAgentToolGateway(registry, { executionStore: store, maxAttempts: 4 });
  const result = await gateway.invoke("geometry.primitive.create", { kind: "box" }, context);
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.equal((await store.list(context.projectId))[0].status, "failed");
});


test("gateway validates artifact references returned by tools", async () => {
  const artifacts = new InMemoryArtifactStore();
  const stored = await artifacts.put({
    bytes: new TextEncoder().encode("generated image"),
    kind: "image",
    mediaType: "image/png",
    provenance: { projectId: context.projectId, toolId: "geometry.primitive.create" },
  });
  const registry = new InMemoryAgentToolRegistry();
  registry.register(makeTool({}, async () => ({
    ok: true,
    output: { kind: "box" },
    diagnostics: [],
    artifacts: [{ id: stored.id, uri: stored.uri, mediaType: stored.mediaType, contentHash: stored.contentHash }],
  })));
  const gateway = new LocalAgentToolGateway(registry, { artifactStore: artifacts });
  assert.equal((await gateway.invoke("geometry.primitive.create", { kind: "box" }, context)).ok, true);

  const badRegistry = new InMemoryAgentToolRegistry();
  badRegistry.register(makeTool({}, async () => ({
    ok: true,
    output: { kind: "box" },
    diagnostics: [],
    artifacts: [{ id: "sha256:" + "0".repeat(64), uri: "artifact://missing", mediaType: "image/png" }],
  })));
  const badGateway = new LocalAgentToolGateway(badRegistry, { artifactStore: artifacts });
  const rejected = await badGateway.invoke("geometry.primitive.create", { kind: "box" }, { ...context, callId: "artifact-bad" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.diagnostics[0].code, "TOOL_EXECUTION_FAILED");
});
