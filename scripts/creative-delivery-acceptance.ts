import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeDeliveryReport, DeliveryVisualReviewer } from "../src/contracts/creative-delivery";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativeRepairPlanner } from "../src/contracts/creative-repair";
import type { ProjectDocument } from "../src/contracts/project";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyCreativeDelivery, verifyCreativeDeliveryRecovery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import { repairCreativeSnapshot } from "../src/platform/creative-repair";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";

const output = resolve("out/creative-delivery");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-creative-delivery-"));
const directory = join(root, "workspace"), voice = join(root, "narration.wav");
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const projectId = "cache-delivery", profile = { width: 640, height: 360, fps: 10 }, durationFrames = 80;
const approvalTools = ["project.inspect", "project.snapshot.save", "project.snapshot.restore"];
const deliveryTools = ["project.snapshot.inspect", "render.preview", "render.video"];
const editTools = ["project.create", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create", "animation.keyframes.set",
  "animation.keyframes.edit", "assets.import", "timeline.edit", "inspect.snapshot", "project.inspect", "project.snapshot.save", "project.snapshot.inspect"];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", newModelCalls: 0 };
let host: CreativeHost | undefined, calls = 0;
const save = (name: string, data: unknown) => writeFile(join(output, name), JSON.stringify(data, null, 2) + "\n");
const revision = (document: ProjectDocument) => document.revisions.at(-1)!.id;

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown = {}) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, `Expected the ${toolId} manifest for this session`);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "verify-creative-delivery", callId: `call-${++calls}` });
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

const repairer: CreativeRepairPlanner = { async propose({ catalogue, repair }) {
  assert.ok(repair.findings.some(item => item.nodeId === "marker" && item.code === "INSPECT_NODE_OUTSIDE_FRAME"));
  const tool = catalogue.tools.find(item => item.id === "animation.keyframes.edit");
  assert.ok(tool);
  return JSON.stringify({ kind: "invoke", toolId: tool.id, toolVersion: tool.version, input: { baseRevisionId: repair.revisionId,
    edits: [{ op: "update", trackId: "data-motion", frame: 20, changes: { value: [322, 185, 0] } }] } });
} };

const reviewer: DeliveryVisualReviewer = { id: "local-png-check", async review({ previews }) {
  return previews.map(({ frame, artifactId, png }) => {
    assert.equal(`sha256:${createHash("sha256").update(png).digest("hex")}`, artifactId);
    const { width, height, data } = PNG.sync.read(Buffer.from(png));
    assert.deepEqual([width, height, data[3]], [profile.width, profile.height, 255]);
    return { frame, level: "info", message: `Decoded ${width}×${height} preview with an opaque background.` };
  });
} };

const deliverySession = (host: CreativeHost) => host.createSession({ projectId, toolIds: deliveryTools, permissions: ["snapshot.read", "artifact.write"] });

async function preserve(label: string, report: CreativeDeliveryReport) {
  const files = [
    ...report.previews.map(item => ({ job: item.job, name: `preview-${item.frame}.png` })),
    { job: report.video.job, name: "delivery.mp4" },
  ];
  const target = join(output, label);
  await mkdir(target, { recursive: true });
  for (const { job, name } of files) {
    assert.equal(job.state, "succeeded");
    assert.deepEqual(job.input.snapshot, report.snapshot);
    assert.ok(job.result);
    const bytes = await readVerifiedJobArtifact(artifacts, job.result);
    assert.ok(bytes);
    await writeFile(join(target, name), bytes);
  }
  await save(`${label}.json`, report);
}

try {
  execFileSync("ffmpeg", ["-v", "error", "-i", "docs/showcase/cpu-cache-30s.mp4", "-map", "0:a:0", "-t", "6",
    "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", voice], { timeout: 15_000 });
  host = await openCreativeHost({ directory, assetImports: [{ projectId, sourceId: "voice", path: voice, mediaType: "audio/wav" }] });
  const editor = host.createSession({ projectId, toolIds: editTools,
    permissions: ["project.read", "project.write", "artifact.write", "snapshot.read", "snapshot.write"] });
  await invoke(editor, "project.create", { name: "CPU cache delivery", episodeId: "cache-delivery", ...profile, durationFrames });
  const shots = [
    { id: "wait", title: "CPU 算得快，数据要等", start: 0, color: "#111d31", bar: "#f5b944" },
    { id: "near", title: "缓存，让数据更近", start: 40, color: "#173746", bar: "#5bd9cd" },
  ];
  for (const { id, title, start, color, bar } of shots) {
    await invoke(editor, "project.scene.create", { sceneId: id, name: title, startFrame: start, durationFrames: 40 });
    await invoke(editor, "graphics.2d.shape.create", { sceneId: id, nodeId: `${id}-background`, primitive: "rect", x: 0, y: 0,
      width: profile.width, height: profile.height, fill: color });
    await invoke(editor, "graphics.2d.text.create", { sceneId: id, nodeId: `${id}-title`, text: title, x: 54, y: 48,
      width: 530, height: 66, fontSize: 36 });
    await invoke(editor, "graphics.2d.shape.create", { sceneId: id, nodeId: `${id}-link`, primitive: "rect", x: 80, y: 198,
      width: id === "wait" ? 470 : 185, height: 4, fill: bar });
  }
  await invoke(editor, "graphics.2d.shape.create", { sceneId: "wait", nodeId: "marker", primitive: "rect", x: 80, y: 185,
    width: 46, height: 30, fill: "#f5b944" });
  await invoke(editor, "animation.keyframes.set", { trackId: "data-motion", targetNodeId: "marker", targetProperty: "transform.position",
    keyframes: [{ frame: 0, value: [80, 185, 0] }, { frame: 20, value: [720, 185, 0] }, { frame: 39, value: [480, 185, 0] }] });
  const imported = await invoke<{ revisionId: string }>(editor, "assets.import", { sourceId: "voice", assetId: "narration", mediaType: "audio/wav" });
  await invoke(editor, "timeline.edit", { baseRevisionId: imported.revisionId, edits: [
    { op: "set-transition", fromShotId: "shot-wait", toShotId: "shot-near", transition: { type: "crossfade", durationFrames: 5 } },
    { op: "place-clip", trackId: "voice", clip: { id: "voice-clip", assetId: "narration", startFrame: 10, durationFrames: 55 } },
    { op: "set-caption", captionId: "spoken-cue", caption: { text: "CPU 算得快，却常常要等数据。\n缓存，把常用数据放得更近。", startFrame: 10, durationFrames: 55 } },
  ] });
  const draft = await invoke<ProjectDocument>(editor, "project.inspect");
  const before = await invoke<SnapshotReceipt>(editor, "project.snapshot.save", { snapshotId: "before-repair", revisionId: revision(draft) });
  const repair = await repairCreativeSnapshot(editor, repairer, { snapshotId: before.id, brief: "Fix the offscreen marker in the approved cache explanation.",
    checks: { model: { frames: [0, 10, 16, 20, 30, 39, 42, 79] } } });
  await save("repair.json", repair);
  assert.equal(repair.stop, "verified", JSON.stringify(repair.run.stop));
  assert.equal(repair.repairsVerified, 1);
  assert.ok(repair.lastVerified);
  const { snapshotId: id, revisionId, snapshotHash: contentHash } = repair.lastVerified;
  const approved = { id, revisionId, contentHash };
  const original = await verifyCreativeDelivery(deliverySession(host), artifacts, { approved, repair, reviewer, timeoutMs: 180_000 });
  await preserve("approved", original);
  assert.deepEqual(original.range, { startFrame: 0, durationFrames });
  assert.deepEqual(original.profile, profile);
  assert.equal(original.previews.length, 8);
  assert.deepEqual(original.selection.frames.map(item => item.frame), original.previews.map(item => item.frame));
  assert.deepEqual(new Set(original.selection.frames.flatMap(item => item.reasons)),
    new Set(["repair-finding", "shot-boundary", "crossfade", "caption-boundary", "export-range"]));
  assert.equal(original.video.decoded.durationSeconds, 8);
  assert.equal(original.video.decoded.frames, durationFrames);
  const audio = original.video.decoded.audio;
  assert.ok(audio && audio.samples > 0);
  assert.notEqual(audio.pcmHash, createHash("sha256").update(Buffer.alloc(audio.samples * audio.channels * 2)).digest("hex"));
  assert.deepEqual(original.review?.snapshot, approved);
  assert.deepEqual(original.review?.observations.map(item => item.artifactId), original.previews.map(item => item.job.result?.artifactId));

  await host.close();
  await rm(voice);
  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = deliverySession(host);
  for (const job of [...original.previews.map(item => item.job), original.video.job]) assert.deepEqual(await reopened.jobs.get(job.id), job);
  const approver = host.createSession({ projectId, toolIds: approvalTools, allowDestructive: true,
    permissions: ["project.read", "project.write", "snapshot.write", "snapshot.restore"] });
  const rolledBack = await invoke<ProjectDocument>(approver, "project.snapshot.restore", { snapshotId: before.id, baseRevisionId: approved.revisionId,
    message: "Recover the pre-repair draft after reopening" });
  const restoredDocument = await invoke<ProjectDocument>(approver, "project.snapshot.restore", { snapshotId: approved.id,
    baseRevisionId: revision(rolledBack), message: "Restore the approved snapshot after reopening" });
  assert.equal(restoredDocument.revisions.at(-1)?.snapshotHash, approved.contentHash);
  const restoredRevisionId = revision(restoredDocument);
  const { id: restoredId, contentHash: restoredHash } = await invoke<SnapshotReceipt>(approver,
    "project.snapshot.save", { snapshotId: "recovered-delivery", revisionId: restoredRevisionId });
  const restored = { id: restoredId, revisionId: restoredRevisionId, contentHash: restoredHash };
  assert.notEqual(restored.contentHash, approved.contentHash);
  await assert.rejects(verifyCreativeDeliveryRecovery(reopened, artifacts, { reference: original, restored: approved }), { code: "DELIVERY_RESTORE_MISMATCH" });
  const recovery = await verifyCreativeDeliveryRecovery(reopened, artifacts, { reference: original, restored, timeoutMs: 180_000 });
  await preserve("restored", recovery.restored);
  await save("recovery.json", recovery);
  assert.deepEqual(recovery.comparison, { previewFrames: original.previews.map(item => item.frame),
    rgbHash: original.video.decoded.rgbHash, pcmHash: audio.pcmHash });
  Object.assign(evidence, { status: "passed", projectId, approved, restored, profile, selection: original.selection,
    export: original.video.decoded, review: original.review, recovery: recovery.comparison });
  console.log("PASS: approved previews and MP4 verified with matching decoded media after reopening and restore");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    try { await save("evidence.json", evidence); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
