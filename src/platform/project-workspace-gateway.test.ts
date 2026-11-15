import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../../projects/cpu-cache/project.json";
import type { ProjectDocument, ProjectAsset } from "../contracts/project";
import type { AgentTool } from "../contracts/agent-tool";
import { FileSystemArtifactStore } from "./artifact-store";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { FileSystemProjectWorkspace } from "./filesystem-project-workspace";
import { FileSystemToolExecutionStore } from "./filesystem-tool-execution-store";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";

test("Gateway retries and a full local store reopen preserve one asset revision and retained snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-gateway-"));
  const artifacts = new FileSystemArtifactStore(join(root, "artifacts"));
  let lifecycle = new LocalArtifactLifecycleManager(artifacts, new FileSystemArtifactReferenceStore(join(root, "refs")));
  let workspace = await FileSystemProjectWorkspace.open(join(root, "projects"), lifecycle);
  let evidence = await FileSystemToolExecutionStore.open(join(root, "executions"));
  const registry = new InMemoryAgentToolRegistry(); let executions = 0;
  let gateway = new LocalAgentToolGateway(registry, { allowedPermissions: ["project.write"], executionStore: evidence });
  try {
    const source = structuredClone(fixture) as unknown as ProjectDocument;
    await workspace.create(source);
    const record = await artifacts.put({ bytes: new TextEncoder().encode("test asset"), kind: "image", mediaType: "image/png" });
    const asset: ProjectAsset = { id: "asset-workspace-test", kind: "image", uri: record.uri, contentHash: record.contentHash };
    const tool: AgentTool = {
      manifest: { id: "project.test.asset.add", version: "1.0.0", namespace: "project.test", name: "Asset add integration fixture", description: "Use the canonical workspace Patch boundary", category: "test",
        inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", required: ["revisionId"], properties: { revisionId: { type: "string" } } },
        execution: { deterministic: true, stateful: true, destructive: false, cost: "low", idempotent: true, permissions: ["project.write"] } },
      execute: async () => {
        executions++;
        const result = await workspace.applyPatch(source.project.id, { schemaVersion: "1.2.0", projectId: source.project.id, baseRevisionId: source.revisions.at(-1)!.id, patches: [{ op: "add-asset", asset }] },
          { newRevisionId: "asset-added-once", createdAt: "2026-11-15T00:00:00.000Z", message: "Add asset through Gateway" });
        return { ok: true, output: { revisionId: result.revisionId }, diagnostics: [] };
      },
    };
    registry.register(tool);
    const context = { projectId: source.project.id, runId: "workspace-test", callId: "initial", idempotencyKey: "asset-once" };
    const calls = await Promise.all(Array.from({ length: 12 }, (_, i) => gateway.invoke(tool.manifest.id, {}, { ...context, callId: `call-${i}` })));
    assert.ok(calls.every((call) => call.ok)); assert.equal(executions, 1);
    await workspace.saveSnapshot(source.project.id, "asset-added-once", { id: "retained", createdAt: "2026-11-15T00:00:00.000Z" });
    await gateway.shutdown(); await evidence.close(); await workspace.close();
    lifecycle = new LocalArtifactLifecycleManager(artifacts, new FileSystemArtifactReferenceStore(join(root, "refs")));
    workspace = await FileSystemProjectWorkspace.open(join(root, "projects"), lifecycle);
    evidence = await FileSystemToolExecutionStore.open(join(root, "executions"));
    gateway = new LocalAgentToolGateway(registry, { allowedPermissions: ["project.write"], executionStore: evidence });
    assert.ok((await gateway.invoke(tool.manifest.id, {}, { ...context, callId: "reopened" })).ok);
    assert.equal(executions, 1);
    const current = (await workspace.get(source.project.id))!;
    assert.equal(current.revisions.length, source.revisions.length + 1);
    assert.equal(current.assets.filter((item) => item.id === asset.id).length, 1);
    await workspace.applyPatch(source.project.id, { schemaVersion: "1.2.0", projectId: source.project.id, baseRevisionId: "asset-added-once", patches: [{ op: "remove-asset", assetId: asset.id }] },
      { newRevisionId: "removed", createdAt: "2026-11-15T00:00:00.000Z", message: "Remove current asset" });
    assert.deepEqual((await workspace.collectGarbage({ olderThanMs: 0 })).deleted, []);
    assert.ok((await workspace.getSnapshot("retained"))!.document.assets.some((item) => item.id === asset.id));
    assert.ok(await artifacts.read(record.id));
  } finally {
    await gateway.shutdown(); await evidence.close(); await workspace.close(); await rm(root, { recursive: true, force: true });
  }
});
