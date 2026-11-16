import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRecord } from "../contracts/artifact";
import type { CreativeHost, CreativePluginFactory, CreativeSession } from "../contracts/creative-host";
import type { ProjectDocument } from "../contracts/project";
import type { ProjectGraphSnapshotRenderer } from "../contracts/renderer";
import { openCreativeHost } from "./creative-host";

// Deliberately identical bytes: different invocations may legitimately produce the same pixels.
const renderer: ProjectGraphSnapshotRenderer = {
  id: "test.identical-output", version: "1.0.0",
  async renderPreview() {
    return { bytes: new Uint8Array([137,80,78,71,13,10,26,10,1]), mediaType: "image/png", extension: "png", rendererId: this.id, rendererVersion: this.version };
  },
  async renderVideo() {
    return { bytes: new Uint8Array([0,0,0,24,102,116,121,112,109,112,52,50]), mediaType: "video/mp4", extension: "mp4", rendererId: this.id, rendererVersion: this.version };
  },
};
const receiptPlugin: CreativePluginFactory = {
  id: "test.receipt", version: "1.0.0", create: (services) => ({
    manifest: { id: "test.receipt", version: "1.0.0", name: "Receipt", description: "Expose service receipt for regression checks", toolIds: ["test.receipt.render"], permissions: ["snapshot.read", "artifact.write"], projectSchemaVersions: ["1.1.0"] },
    tools: [{
      manifest: { id: "test.receipt.render", version: "1.0.0", namespace: "test.receipt", name: "Render", description: "Return full render service receipt", category: "test",
        pluginId: "test.receipt", inputSchema: { type: "object" }, outputSchema: { type: "object" }, projectSchemaVersions: ["1.1.0"],
        execution: { deterministic: true, stateful: true, destructive: false, cost: "low", idempotent: true, permissions: ["snapshot.read", "artifact.write"] } },
      execute: async (input: { mode: "preview" | "video"; snapshotId: string; frame: number }) => {
        const artifact = input.mode === "preview"
          ? await services.render.preview(input.snapshotId, input.frame)
          : await services.render.video(input.snapshotId, input.frame, 10);
        return { ok: true, output: artifact, diagnostics: [], artifacts: [artifact] };
      },
    }],
  }),
};

test("render deduplication preserves current snapshot/frame/provenance receipts across edits, projects and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-render-receipts-"));
  let host: CreativeHost | undefined, sequence = 0;
  const session = (projectId: string) => host!.createSession({ projectId,
    permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.read", "artifact.write", "execution.read"],
    toolIds: ["project.create", "project.inspect", "project.patch.apply", "project.snapshot.save", "render.preview", "render.video", "test.receipt.render", "execution.list"] });
  const invoke = async (s: CreativeSession, toolId: string, input: unknown = {}) => {
    const callId = `call-${++sequence}`;
    const result = await s.invoke({ toolId, toolVersion: "1.0.0", input, runId: "receipt-regression", callId });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    return { result, callId };
  };
  const save = async (s: CreativeSession, id: string) => {
    const project = (await invoke(s, "project.inspect")).result.output as ProjectDocument;
    const receipt = (await invoke(s, "project.snapshot.save", { snapshotId: id, revisionId: project.revisions.at(-1)!.id })).result.output as { contentHash: string };
    return { snapshotId: id, snapshotHash: receipt.contentHash, revisionId: project.revisions.at(-1)!.id };
  };
  const recordPath = (id: string) => join(root, "artifacts", "metadata", `${id.slice(7)}.json`);
  try {
    host = await openCreativeHost({ directory: root, renderer, plugins: [receiptPlugin] });
    let owner = session("owner");
    await invoke(owner, "project.create", { name: "Original", episodeId: "receipt", durationFrames: 30 });
    const original = await save(owner, "original");
    const stored = new Map<string, { artifact: ArtifactRecord; json: string }>();
    for (const mode of ["preview", "video"] as const) {
      const artifact = (await invoke(owner, "test.receipt.render", { mode, snapshotId: original.snapshotId, frame: 0 })).result.output as ArtifactRecord;
      stored.set(mode, { artifact, json: await readFile(recordPath(artifact.id), "utf8") });
    }
    await invoke(owner, "project.patch.apply", { schemaVersion: "1.3.0", projectId: "owner", baseRevisionId: original.revisionId,
      patches: [{ op: "add-scene", scene: { id: "new-scene", name: "New scene", durationFrames: 30, rootNodeIds: [] } }] });
    const edited = await save(owner, "edited");
    assert.notEqual(edited.snapshotHash, original.snapshotHash);

    const verify = async (s: CreativeSession, snapshot: typeof original, frame: number) => {
      for (const mode of ["preview", "video"] as const) {
        const { result, callId } = await invoke(s, "test.receipt.render", { mode, snapshotId: snapshot.snapshotId, frame });
        const artifact = result.output as ArtifactRecord, first = stored.get(mode)!;
        assert.equal(artifact.id, first.artifact.id, "The immutable content blob should still be deduplicated");
        for (const [key, value] of Object.entries(snapshot)) assert.equal(artifact.metadata?.[key], value);
        assert.equal(artifact.metadata?.[mode === "preview" ? "frame" : "startFrame"], frame);
        assert.equal(artifact.metadata?.rendererId, renderer.id);
        assert.equal(artifact.provenance?.projectId, s.projectId);
        assert.equal(artifact.provenance?.callId, callId);
        assert.equal(artifact.provenance?.toolId, "test.receipt.render");
        assert.notEqual(artifact.provenance?.parametersHash, first.artifact.provenance?.parametersHash);
        const publicResult = (await invoke(s, `render.${mode}`, { snapshotId: snapshot.snapshotId,
          ...(mode === "preview" ? { frame: frame + 1 } : { startFrame: frame + 1, durationFrames: 9 }) })).result;
        const publicReceipt = publicResult.output as { artifactId: string; metadata: Record<string, unknown> };
        assert.equal(publicReceipt.artifactId, artifact.id);
        assert.equal(publicReceipt.metadata.snapshotHash, snapshot.snapshotHash);
        assert.equal(publicReceipt.metadata[mode === "preview" ? "frame" : "startFrame"], frame + 1);
        assert.equal(await readFile(recordPath(artifact.id), "utf8"), first.json, "Receipts must not overwrite first-writer blob metadata");
      }
    };
    await verify(owner, edited, 5);
    await host.close();
    host = await openCreativeHost({ directory: root, renderer, plugins: [receiptPlugin] });
    owner = session("owner");
    const history = (await invoke(owner, "execution.list")).result.output;
    assert.ok(JSON.stringify(history).includes(edited.snapshotHash), "Current invocation evidence must survive restart");
    await verify(owner, original, 12);
    const stranger = session("stranger");
    await invoke(stranger, "project.create", { name: "Separate project", episodeId: "separate", durationFrames: 30 });
    await verify(stranger, await save(stranger, "stranger-snapshot"), 8);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
