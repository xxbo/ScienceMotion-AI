import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeHost, CreativeInvocation, CreativePluginFactory, CreativeSession, CreativeSessionGrant } from "../contracts/creative-host";
import type { ProjectDocument } from "../contracts/project";
import type { ArtifactRecord } from "../contracts/artifact";
import { openCreativeHost } from "./creative-host";
import type { ProjectGraphSnapshotRenderer } from "../contracts/renderer";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";

let counter = 0;
const call = (s: CreativeSession, id: string, input: unknown = {}, extra: Partial<CreativeInvocation> = {}) => s.invoke({ toolId: id, toolVersion: "1.0.0", input,
  runId: "integration", callId: `call-${++counter}`, ...extra });
const directory = () => mkdtemp(join(tmpdir(), "science-creative-host-"));
const writer = (host: CreativeHost) => host.createSession({ projectId: "p", permissions: ["project.read", "project.write", "artifact.read", "snapshot.write", "snapshot.read"],
  toolIds: ["project.create", "project.inspect", "project.patch.apply", "project.snapshot.save", "project.snapshot.inspect"] });

test("production host: actual plugin/registry/gateway/workspace create/edit/snapshot/restart/replay", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root }); const s = writer(host);
    assert.ok((await s.discover({ text: "project" })).total >= 4);
    assert.equal((await call(s, "project.create", { name: "Electrical current", episodeId: "approved-electrical-content" })).ok, true);
    const change = { schemaVersion: "1.3.0", projectId: "p", baseRevisionId: "revision-initial", patches: [
      { op: "add-scene", scene: { id: "s", name: "Charges", durationFrames: 120, rootNodeIds: [] } },
      { op: "add-node", sceneId: "s", node: { id: "charge", name: "Charge", type: "shape", transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }, components: [{ kind: "geometry", data: { primitive: "circle", radius: 20 } }] } },
      { op: "add-shot", sequenceId: "sequence-main", shot: { id: "shot", name: "Flow", sceneId: "s", startFrame: 0, durationFrames: 120 } },
      { op: "put-animation-track", track: { id: "move", targetNodeId: "charge", targetProperty: "transform.position", keyframes: [{ frame: 0, value: [0,0,0] }, { frame: 120, value: [400,0,0], interpolation: "bezier", easing: "ease-in-out" }] } },
    ] };
    const results = await Promise.all(Array.from({ length: 12 }, () => call(s, "project.patch.apply", change, { idempotencyKey: "first-scene" })));
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const current = (await call(s, "project.inspect")).output as ProjectDocument;
    assert.equal(current.revisions.length, 2); assert.equal(current.editorial.episodeId, "approved-electrical-content");
    assert.equal((await call(s, "project.snapshot.save", { snapshotId: "initial-layout", revisionId: current.revisions.at(-1)!.id })).ok, true);
    await host.close(); host = await openCreativeHost({ directory: root }); const restarted = writer(host);
    assert.equal((await call(restarted, "project.patch.apply", change, { idempotencyKey: "first-scene" })).ok, true);
    const reopened = (await call(restarted, "project.inspect")).output as ProjectDocument;
    assert.equal(reopened.revisions.length, 2); assert.equal(reopened.animationTracks.length, 1);
    assert.equal((await call(restarted, "project.snapshot.inspect", { snapshotId: "initial-layout" })).ok, true);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("production host: schema rejection, grant filtering and unknown tool version precede effects", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root }); const s = writer(host);
    const read = host.createSession({ projectId: "p", permissions: ["project.read"], toolIds: ["project.inspect", "project.create"] });
    assert.deepEqual((await read.discover()).tools.map((t) => t.id), ["project.inspect"]);
    assert.equal((await call(read, "project.create", { name: "No", episodeId: "e" })).ok, false);
    assert.equal((await call(s, "project.create", { name: "Bad", episodeId: "e", fps: "thirty" })).diagnostics[0].code, "TOOL_INPUT_INVALID");
    assert.equal((await call(s, "project.create", { name: "Bad", episodeId: "e" }, { toolVersion: "2.0.0" })).diagnostics[0].code, "HOST_TOOL_VERSION_MISMATCH");
    assert.equal((await call(s, "project.inspect")).ok, false);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("production host: whole-composition writer lock rejects a second host and is released on close", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root }); await assert.rejects(() => openCreativeHost({ directory: root }), /EEXIST/);
    await host.close(); host = await openCreativeHost({ directory: root }); assert.equal(host.status().state, "ready");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("production host: failed plugin health check closes partial composition without erasing ledgers", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  const plugin: CreativePluginFactory = { id: "test.bad", version: "1.0.0", create: () => ({ manifest: { id: "test.bad", version: "1.0.0", name: "Bad", description: "Failed preflight", toolIds: [] }, tools: [], healthCheck: async () => ({ ok: false, message: "unavailable" }) }) };
  try {
    await assert.rejects(() => openCreativeHost({ directory: root, plugins: [plugin] }), /HEALTH_CHECK_FAILED/);
    assert.equal((await readdir(root)).includes("host.lock"), false);
    host = await openCreativeHost({ directory: root }); assert.equal(host.status().state, "ready");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("production host: corruption fails closed and does not silently reset authoritative project data", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root }); await host.close(); host = undefined;
    const path = join(root, "projects", "workspace.json"); const original = await readFile(path, "utf8");
    await writeFile(path, "corrupt-ledger"); await assert.rejects(() => openCreativeHost({ directory: root }));
    assert.equal(await readFile(path, "utf8"), "corrupt-ledger");
    await writeFile(path, original); host = await openCreativeHost({ directory: root }); assert.equal(host.status().state, "ready");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("production host: plugin artifact, project revision and retained snapshot survive close/reopen/GC", async () => {
  const root = await directory(); let host: CreativeHost | undefined; let artifactId = "";
  const plugin: CreativePluginFactory = { id: "test.assets", version: "1.0.0", create: (services) => ({
    manifest: { id: "test.assets", version: "1.0.0", name: "Assets", description: "Artifact integration fixture", projectSchemaVersions: ["1.1.0"],
      permissions: ["project.read", "project.write", "artifact.write"], toolIds: ["test.assets.attach"] },
    tools: [{ manifest: { id: "test.assets.attach", version: "1.0.0", namespace: "test.assets", name: "Attach", description: "Upload and attach one artifact", category: "test",
      inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object" }, pluginId: "test.assets", projectSchemaVersions: ["1.1.0"],
      execution: { deterministic: true, stateful: true, destructive: false, cost: "low", idempotent: true, permissions: ["project.read", "project.write", "artifact.write"] } },
      execute: async (_input, context) => {
        const artifact = await services.artifacts.put({ bytes: new TextEncoder().encode("reference data"), kind: "document", mediaType: "text/plain" });
        const project = await services.project.read();
        const edit = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: context.projectId, baseRevisionId: project!.revisions.at(-1)!.id,
          patches: [{ op: "add-asset", asset: { id: "research", kind: "data", uri: artifact.uri, contentHash: artifact.contentHash } }] }, "Attach research");
        return { ok: true, output: { artifactId: artifact.id, revisionId: edit.revisionId }, diagnostics: [], artifacts: [artifact] };
      } }],
  }) };
  try {
    host = await openCreativeHost({ directory: root, plugins: [plugin] }); const s = writer(host);
    await call(s, "project.create", { name: "Research", episodeId: "approved" });
    const uploader = host.createSession({ projectId: "p", permissions: ["project.read", "project.write", "artifact.write"], toolIds: ["test.assets.attach"] });
    const result = await call(uploader, "test.assets.attach"); assert.equal(result.ok, true, JSON.stringify(result));
    artifactId = (result.output as { artifactId: string }).artifactId;
    await call(s, "project.snapshot.save", { snapshotId: "research-snapshot", revisionId: (result.output as { revisionId: string }).revisionId });
    await host.close(); host = await openCreativeHost({ directory: root, plugins: [plugin] }); const read = writer(host);
    const snapshot = await call(read, "project.snapshot.inspect", { snapshotId: "research-snapshot" }); assert.equal(snapshot.ok, true);
    const gc = await host.maintenance.collectGarbage(0); assert.equal(gc.deleted.includes(artifactId), false);
    const hash = artifactId.slice(7); assert.equal((await readFile(join(root, "artifacts", "blobs", hash.slice(0,2), hash))).toString(), "reference data");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});


test("production host: real creative tools mutate Project Graph and the generic renderer consumes the result", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root });
    const session = host.createSession({ projectId: "p", permissions: ["project.read", "project.write"],
      toolIds: ["project.create", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create",
        "project.node.transform.set", "animation.keyframes.set", "project.inspect"] });
    assert.equal((await call(session, "project.create", { name: "Water cycle", episodeId: "approved-water-cycle" })).ok, true);
    assert.equal((await call(session, "project.scene.create", { sceneId: "water", name: "Water", durationFrames: 240 })).ok, true);
    assert.equal((await call(session, "graphics.2d.text.create", { sceneId: "water", nodeId: "title", text: "The water cycle", x: 120, y: 80, fontSize: 64, color: "#ffffff" })).ok, true);
    assert.equal((await call(session, "graphics.2d.shape.create", { sceneId: "water", nodeId: "ocean", primitive: "rect", x: 100, y: 650, width: 1200, height: 200, fill: "#167ca6" })).ok, true);
    assert.equal((await call(session, "project.node.transform.set", { nodeId: "ocean", position: [140, 620, 0] })).ok, true);
    assert.equal((await call(session, "animation.keyframes.set", { trackId: "ocean-opacity", targetNodeId: "ocean", targetProperty: "opacity",
      keyframes: [{ frame: 0, value: 0.2 }, { frame: 120, value: 1, interpolation: "bezier", easing: "ease-in-out" }] })).ok, true);
    const project = (await call(session, "project.inspect")).output as ProjectDocument;
    const frame = buildProjectRenderModel(project, 60);
    assert.equal(frame.sceneId, "water");
    assert.ok(frame.elements.some((element) => element.id === "title" && element.text === "The water cycle"));
    assert.ok(frame.elements.some((element) => element.id === "ocean" && element.opacity > 0.2));
    assert.equal(project.revisions.length, 6);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});


test("production host: snapshot preview/video tools return retained, traceable Artifacts", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  const calls: Array<{ mode: string; revisionId: string; snapshotHash: string }> = [];
  const renderer: ProjectGraphSnapshotRenderer = {
    id: "test.project-graph", version: "test-1",
    async renderPreview(request) {
      calls.push({ mode: "preview", revisionId: request.revisionId, snapshotHash: request.snapshotHash });
      return { bytes: new Uint8Array([137,80,78,71,13,10,26,10,1]), mediaType: "image/png", extension: "png", rendererId: this.id, rendererVersion: this.version };
    },
    async renderVideo(request) {
      calls.push({ mode: "video", revisionId: request.revisionId, snapshotHash: request.snapshotHash });
      return { bytes: new Uint8Array([0,0,0,24,102,116,121,112,109,112,52,50]), mediaType: "video/mp4", extension: "mp4", rendererId: this.id, rendererVersion: this.version };
    },
  };
  try {
    host = await openCreativeHost({ directory: root, renderer });
    const session = host.createSession({ projectId: "p", permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write"],
      toolIds: ["project.create", "project.inspect", "project.snapshot.save", "render.preview", "render.video"] });
    assert.equal((await call(session, "project.create", { name: "Snapshot render", episodeId: "render-fixture", durationFrames: 120 })).ok, true);
    const project = (await call(session, "project.inspect")).output as ProjectDocument;
    assert.equal((await call(session, "project.snapshot.save", { snapshotId: "render-source", revisionId: project.revisions.at(-1)!.id })).ok, true);
    const preview = await call(session, "render.preview", { snapshotId: "render-source", frame: 12 });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.artifacts?.[0]?.mediaType, "image/png");
    assert.equal((preview.output as { metadata: Record<string, unknown> }).metadata.snapshotId, "render-source");
    const video = await call(session, "render.video", { snapshotId: "render-source", startFrame: 0, durationFrames: 60 });
    assert.equal(video.ok, true, JSON.stringify(video));
    assert.equal(video.artifacts?.[0]?.mediaType, "video/mp4");
    assert.equal((video.output as { metadata: Record<string, unknown> }).metadata.snapshotHash, calls[0].snapshotHash);
    assert.deepEqual(calls.map((entry) => entry.mode), ["preview", "video"]);
    assert.equal(calls[0].revisionId, project.revisions.at(-1)!.id);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("render tools reject foreign snapshots and out-of-range frames", async () => {
  const root = await directory(); let host: CreativeHost | undefined;
  const renderer: ProjectGraphRenderer = {
    id: "test.project-graph", version: "test-1",
    async renderPreview() { return { bytes: new Uint8Array([137,80,78,71,13,10,26,10,1]), mediaType: "image/png", extension: "png", rendererId: this.id, rendererVersion: this.version }; },
    async renderVideo() { return { bytes: new Uint8Array([0,0,0,24,102,116,121,112,109,112,52,50]), mediaType: "video/mp4", extension: "mp4", rendererId: this.id, rendererVersion: this.version }; },
  };
  try {
    host = await openCreativeHost({ directory: root, renderer });
    const grant: CreativeSessionGrant = { permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write"],
      toolIds: ["project.create", "project.inspect", "project.snapshot.save", "render.preview"] };
    const owner = host.createSession({ ...grant, projectId: "owner" });
    assert.equal((await call(owner, "project.create", { name: "Owner", episodeId: "owner", durationFrames: 30 })).ok, true);
    const ownerProject = (await call(owner, "project.inspect")).output as ProjectDocument;
    await call(owner, "project.snapshot.save", { snapshotId: "owner-snapshot", revisionId: ownerProject.revisions.at(-1)!.id });
    const stranger = host.createSession({ ...grant, projectId: "stranger" });
    assert.equal((await call(stranger, "project.create", { name: "Stranger", episodeId: "stranger", durationFrames: 30 })).ok, true);
    const foreign = await call(stranger, "render.preview", { snapshotId: "owner-snapshot", frame: 0 });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.diagnostics[0].code, "HOST_SNAPSHOT_DENIED");
    const outOfRange = await call(owner, "render.preview", { snapshotId: "owner-snapshot", frame: 30 });
    assert.equal(outOfRange.ok, false);
    assert.equal(outOfRange.diagnostics[0].code, "HOST_RENDER_FRAME_INVALID");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
