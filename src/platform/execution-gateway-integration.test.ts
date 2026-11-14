import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../../projects/cpu-cache/project.json";
import type { ProjectDocument } from "../contracts/project";
import type { AgentTool } from "../contracts/agent-tool";
import { InMemoryProjectRepository } from "./project-repository";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";
import { FileSystemToolExecutionStore } from "./filesystem-tool-execution-store";

function makeTool(execute: AgentTool["execute"], overrides: Partial<AgentTool["manifest"]> = {}): AgentTool {
  return { manifest: { id: "project.test.rename", version: "1.0.0", namespace: "project.test", name: "Rename fixture", description: "Exercise revisioned project editing", category: "project",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["revisionId"], properties: { revisionId: { type: "string" } } },
    execution: { deterministic: true, stateful: true, destructive: false, cost: "low", idempotent: true, permissions: ["project.write"] }, ...overrides }, execute };
}

test("real Gateway plus durable evidence admits one revisioned project mutation across duplicates and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-execution-integration-"));
  let store = await FileSystemToolExecutionStore.open(root);
  try {
    const repository = new InMemoryProjectRepository();
    const source = structuredClone(fixture) as unknown as ProjectDocument;
    await repository.create(source);
    const registry = new InMemoryAgentToolRegistry(); let calls = 0;
    registry.register(makeTool(async (input) => {
      calls++;
      const result = await repository.applyPatch(source.project.id, {
        schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: source.revisions.at(-1)!.id,
        patches: [{ op: "update-node", nodeId: source.nodes[0].id, changes: { name: (input as { name: string }).name } }],
      }, { newRevisionId: "execution-once", createdAt: "2026-11-14T00:00:00.000Z", message: "Idempotent test rename" });
      return { ok: true, output: { revisionId: result.revisionId }, diagnostics: [] };
    }));
    const context = { projectId: source.project.id, runId: "execution-test", callId: "first", idempotencyKey: "rename-once" };
    let gateway = new LocalAgentToolGateway(registry, { executionStore: store, allowedPermissions: ["project.write"] });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => gateway.invoke("project.test.rename", { name: "Renamed by tool" }, { ...context, callId: `c${i}` })));
    assert.ok(results.every((result) => result.ok)); assert.equal(calls, 1);
    const current = (await repository.get(source.project.id))!;
    assert.equal(current.revisions.length, source.revisions.length + 1);
    assert.equal(current.nodes[0].name, "Renamed by tool");
    await store.close(); store = await FileSystemToolExecutionStore.open(root);
    gateway = new LocalAgentToolGateway(registry, { executionStore: store, allowedPermissions: ["project.write"] });
    assert.ok((await gateway.invoke("project.test.rename", { name: "Renamed by tool" }, { ...context, callId: "after-restart" })).ok);
    assert.equal((await gateway.invoke("project.test.rename", { name: "Wrong reuse" }, { ...context, callId: "conflict" })).diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
    assert.equal(calls, 1); assert.equal((await store.list()).length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("gateway is least-privilege by default and blocks destructive/high-cost execution", async () => {
  for (const extra of [{}, { destructive: true }, { cost: "high" as const }]) {
    const registry = new InMemoryAgentToolRegistry(); let calls = 0;
    const operation = makeTool(async () => { calls++; return { ok: true, output: { revisionId: "x" }, diagnostics: [] }; });
    Object.assign(operation.manifest.execution, extra); registry.register(operation);
    const gateway = new LocalAgentToolGateway(registry, Object.keys(extra).length ? { allowedPermissions: ["project.write"] } : {});
    const result = await gateway.invoke(operation.manifest.id, { name: "x" }, { projectId: "p", runId: "r", callId: "c" });
    assert.equal(result.diagnostics[0].code, Object.keys(extra).length ? "TOOL_APPROVAL_REQUIRED" : "TOOL_PERMISSION_DENIED");
    assert.equal(calls, 0);
  }
});

test("gateway rejects invalid schemas and missing successful outputs without unhandled throws", async () => {
  const registry = new InMemoryAgentToolRegistry();
  registry.register(makeTool(async () => ({ ok: true, diagnostics: [] })));
  const gateway = new LocalAgentToolGateway(registry, { allowedPermissions: ["project.write"] });
  const context = { projectId: "p", runId: "r", callId: "c" };
  assert.equal((await gateway.invoke("project.test.rename", { name: "x" }, context)).ok, false);
  const invalid = new InMemoryAgentToolRegistry();
  invalid.register(makeTool(async () => { throw new Error("must not run"); }, { inputSchema: { type: "not-a-json-schema-type" } }));
  assert.equal((await new LocalAgentToolGateway(invalid, { allowedPermissions: ["project.write"] }).invoke("project.test.rename", { name: "x" }, context)).diagnostics[0].code, "TOOL_SCHEMA_INVALID");
});
