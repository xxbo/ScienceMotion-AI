import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeDeliveryReport } from "../src/contracts/creative-delivery";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { SnapshotInspectionReport } from "../src/contracts/inspection";
import type { FollowPathParameters, ProjectDocument } from "../src/contracts/project";
import type { ProjectPatchDocument, ProjectPatchResult } from "../src/contracts/project-patch";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyCreativeDelivery, verifyCreativeDeliveryRecovery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { artwork, bobRadius, colors, crop, editedSwing, expectedCenter, motion, motionInputs, originalSwing, pivot, profile, projectId,
  radius, range, release, sceneId, title, type Swing } from "./fixtures/pendulum-delivery";

const output = resolve("out/pendulum-delivery");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-pendulum-delivery-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const authorTools = ["project.create", "project.inspect", "project.scene.create", "project.patch.apply", "graphics.2d.shape.create",
  "graphics.2d.text.create", "graphics.2d.path.create", "animation.keyframes.set", "animation.path.bind", "project.snapshot.save", "project.snapshot.inspect"];
const deliveryTools = ["project.snapshot.inspect", "inspect.snapshot", "render.preview", "render.video"];
const deliverySession = (host: CreativeHost) => host.createSession({ projectId, toolIds: deliveryTools, permissions: ["snapshot.read", "artifact.write"] });
const auditRun = "p2-1-d-pendulum-delivery";
const calls: Array<{ toolId: string; toolVersion: string; runId: string; callId: string; input: unknown }> = [];
const model = { pivot, radius, bobRadius, release, crop, colors };
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", projectId, profile, range, model, newModelCalls: 0 };
const run = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const revision = (project: ProjectDocument) => project.revisions.at(-1)!.id;
const approve = (snapshot: ProjectSnapshot) => ({ id: snapshot.id, revisionId: revision(snapshot.document), contentHash: snapshot.contentHash });
const save = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n");
let host: CreativeHost | undefined;

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown = {}): Promise<T> {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, `No manifest for ${toolId} in the scoped session`);
  const call = { toolId, toolVersion: manifest.version, input, runId: auditRun, callId: `call-${calls.length + 1}` };
  calls.push(call);
  const result = await session.invoke(call);
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function retain(session: CreativeSession, label: string, revisionId: string) {
  await mkdir(join(output, label), { recursive: true });
  const snapshotId = `pendulum-${label}`;
  const receipt = await invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId, revisionId });
  const snapshot = await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId });
  const { document, ...manifest } = snapshot;
  assert.deepEqual(receipt, manifest);
  assert.equal(receipt.contentHash, hashProject(document));
  assert.equal(revision(document), revisionId);
  await save(`${label}/snapshot.json`, snapshot);
  return snapshot;
}

/** Check the painted pivot, the rod along its span, and the measured center of a single visible bob. */
function measurePose(pixels: Buffer, frame: number, swing: Swing, channels: 3 | 4) {
  const png = channels === 4;
  const at = (x: number, y: number) => png ? (y * profile.width + x) * 4 : ((y - crop.y) * crop.width + x - crop.x) * 3;
  const match = (offset: number, color: readonly number[], tolerance: number) =>
    (!png || pixels[offset + 3] === 255) && color.every((c, i) => Math.abs(c - pixels[offset + i]) <= tolerance);
  const expected = expectedCenter(swing, frame);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, count = 0;
  for (let y = crop.y; y < crop.y + crop.height; y++) for (let x = crop.x; x < crop.x + crop.width; x++) {
    if (!match(at(x, y), colors.bob, png ? 0 : 12)) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
  }
  const area = Math.PI * bobRadius ** 2;
  assert.ok(count >= 0.48 * area && count <= 1.12 * area && right - left <= 2 * bobRadius + 2 && bottom - top <= 2 * bobRadius + 2,
    `Frame ${frame} must contain one complete teal bob, got ${count} core pixels`);
  const center = [(left + right + 1) / 2, (top + bottom + 1) / 2];
  const centerErrorPx = Math.hypot(center[0] - expected[0], center[1] - expected[1]);
  const radiusErrorPx = Math.abs(Math.hypot(center[0] - pivot[0], center[1] - pivot[1]) - radius);
  assert.ok(centerErrorPx <= (png ? 1 : 2) && radiusErrorPx <= (png ? 1 : 2),
    `Frame ${frame} bob ${center} differs from ${expected} by ${centerErrorPx.toFixed(3)} px`);
  assert.ok(match(at(pivot[0], pivot[1]), colors.pin, png ? 0 : 14), `Frame ${frame} moved or obscured the pivot`);
  for (const length of [0.45, 0.82]) {
    const x = Math.floor(pivot[0] + (expected[0] - pivot[0]) * length);
    const y = Math.floor(pivot[1] + (expected[1] - pivot[1]) * length);
    let found = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      found ||= match(at(x + dx, y + dy), colors.rod, png ? 8 : 24);
    }
    assert.ok(found, `Frame ${frame} rod did not align between the pivot and bob at (${x}, ${y})`);
  }
  return { frame, center, expected, centerErrorPx, radiusErrorPx };
}

// Preview pixels outside the sweep region should be byte-identical when the motion is edited.
function unchangedOutside(before: Buffer, after: Buffer) {
  const rowBytes = profile.width * 4;
  for (let y = 0; y < profile.height; y++) {
    const start = y * rowBytes, end = start + rowBytes;
    const left = start + 4 * crop.x, right = left + 4 * crop.width;
    const segments = y < crop.y || y >= crop.y + crop.height ? [[start, end]] : [[start, left], [right, end]];
    assert.ok(segments.every(([a, b]) => before.subarray(a, b).equals(after.subarray(a, b))), `Unrelated PNG pixels changed on row ${y}`);
  }
}

const jobsOf = (report: CreativeDeliveryReport) => [...report.previews.map(item => item.job), report.video.job];
async function preserve(label: string, report: CreativeDeliveryReport, snapshot: ProjectSnapshot, swing: Swing) {
  assert.deepEqual(report.snapshot, approve(snapshot));
  assert.deepEqual(report.profile, profile);
  assert.deepEqual(report.range, range);
  assert.deepEqual(report.previews.map(item => item.frame), [0, 59, 119]);
  assert.equal(report.video.decoded.codec, "h264");
  assert.equal(report.video.decoded.audio, undefined);
  assert.equal(report.video.decoded.frames, range.durationFrames);
  assert.equal(report.video.decoded.durationSeconds, 6);
  for (const job of jobsOf(report)) {
    assert.deepEqual(job.input.snapshot, approve(snapshot));
    assert.deepEqual(job.input.renderer, { id: "remotion.project-graph", version: "1.0.0" });
    assert.equal(job.state, "succeeded");
    assert.equal(job.outcomeUnknown, false);
  }
  await save(`${label}/delivery.json`, report);
  const pngs = [];
  for (const { frame, job, rgbaHash } of report.previews) {
    assert.ok(job.result);
    const bytes = await readVerifiedJobArtifact(artifacts, job.result);
    assert.ok(bytes);
    await writeFile(join(output, label, `preview-${frame}.png`), bytes);
    const png = PNG.sync.read(Buffer.from(bytes));
    assert.deepEqual([png.width, png.height], [profile.width, profile.height]);
    assert.equal(sha(png.data), rgbaHash);
    measurePose(png.data, frame, swing, 4);
    pngs.push(png.data);
  }
  assert.ok(report.video.job.result);
  const bytes = await readVerifiedJobArtifact(artifacts, report.video.job.result);
  assert.ok(bytes);
  const file = join(output, label, "pendulum.mp4");
  await writeFile(file, bytes);
  const frameBytes = crop.width * crop.height * 3;
  const { stdout: rgb } = await run("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe",
    "-i", file, "-map", "0:v:0", "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, "-fps_mode", "passthrough", "-threads", "1",
    "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { encoding: "buffer", maxBuffer: range.durationFrames * frameBytes + 1024, timeout: 20_000 });
  assert.equal(rgb.byteLength, range.durationFrames * frameBytes);
  const poses = Array.from({ length: range.durationFrames }, (_, i) => measurePose(rgb.subarray(i * frameBytes, (i + 1) * frameBytes), i, swing, 3));
  const checkpoints = [0, ...[0, 1, 2, 3, 4].map(i => release + i * swing.quarterFrames), range.durationFrames - 1];
  const summary = { swing, cycleFrames: 4 * swing.quarterFrames, decodedFrames: poses.length,
    maxCenterErrorPx: Math.max(...poses.map(pose => pose.centerErrorPx)), maxRadiusErrorPx: Math.max(...poses.map(pose => pose.radiusErrorPx)),
    checkpoints: checkpoints.map(frame => poses[frame]) };
  await save(`${label}/motion.json`, { ...summary, poses });
  return { pngs, poses, summary };
}

async function inspect(session: CreativeSession, label: string, snapshot: ProjectSnapshot) {
  const report = await invoke<SnapshotInspectionReport>(session, "inspect.snapshot", { snapshotId: snapshot.id });
  assert.deepEqual([report.snapshotId, report.revisionId, report.snapshotHash], [snapshot.id, revision(snapshot.document), snapshot.contentHash]);
  assert.equal(report.outcome, "no-issues-detected", JSON.stringify(report.issues));
  assert.deepEqual(report.coverage.checkedFrames, Array.from({ length: range.durationFrames }, (_, i) => i));
  assert.ok(report.frames.every(frame => frame.sceneId === sceneId));
  await save(`${label}/inspection.json`, report);
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  host = await openCreativeHost({ directory });
  const author = host.createSession({ projectId, toolIds: authorTools,
    permissions: ["project.read", "project.write", "artifact.read", "snapshot.read", "snapshot.write"] });
  const catalogue = await author.discover({ limit: 100 });
  assert.deepEqual(catalogue.tools.map(tool => tool.id).sort(), [...authorTools].sort());
  await save("catalogue.json", catalogue);
  await invoke(author, "project.create", { name: title, episodeId: sceneId, ...profile, durationFrames: range.durationFrames });
  const empty = await invoke<ProjectDocument>(author, "project.inspect");
  assert.deepEqual([empty.nodes, empty.scenes, empty.constraints, empty.animationTracks], [[], [], [], []]);
  await invoke(author, "project.scene.create", { sceneId, name: title, ...range });
  for (const { toolId, input } of artwork) await invoke(author, toolId, input);
  const draft = motionInputs(originalSwing), change = motionInputs(editedSwing);
  const base = await invoke<{ revisionId: string }>(author, "animation.keyframes.set", { trackId: draft.rod.id, targetNodeId: draft.rod.targetNodeId,
    targetProperty: draft.rod.targetProperty, keyframes: draft.rod.keyframes });
  const { revisionId: beforeRevision } = await invoke<{ revisionId: string }>(author, "animation.path.bind", {
    baseRevisionId: base.revisionId, ...motion, keyframes: draft.keyframes, anchor: [bobRadius, bobRadius],
  });
  const before = await retain(author, "before", beforeRevision);
  assert.deepEqual(before.document.animationTracks, [draft.rod]); // The bob has no separately authored position animation.
  assert.deepEqual(before.document.constraints, [{ id: motion.constraintId, type: "follow-path", enabled: true,
    sourceNodeId: motion.followerNodeId, targetNodeId: motion.guideNodeId,
    parameters: { pathNodeId: motion.guideNodeId, anchor: [bobRadius, bobRadius], progress: { keyframes: draft.keyframes } } }]);
  const delivery = deliverySession(host);
  await inspect(delivery, "before", before);
  const original = await verifyCreativeDelivery(delivery, artifacts, { approved: approve(before) });
  const beforeMedia = await preserve("before", original, before, originalSwing);

  // One canonical revision updates the path, progress keys and the aligned rod together.
  const batch: ProjectPatchDocument = { schemaVersion: "1.3.0", projectId, baseRevisionId: beforeRevision, patches: [
    { op: "edit-follow-path", constraintId: motion.constraintId, changes: { pathData: change.pathData, keyframes: change.keyframes } },
    { op: "put-animation-track", track: change.rod },
  ] };
  const mutation = await invoke<ProjectPatchResult>(author, "project.patch.apply", batch);
  assert.deepEqual(mutation.changedConstraintIds, [motion.constraintId]);
  assert.deepEqual(mutation.changedNodeIds, [motion.guideNodeId]);
  assert.deepEqual(mutation.changedAnimationTrackIds, [change.rod.id]);
  const edited = await retain(author, "edited", mutation.revisionId);
  const expected = structuredClone(before.document);
  assert.deepEqual(edited.document.revisions.slice(0, -1), expected.revisions);
  assert.equal(edited.document.revisions.at(-1)?.parentRevisionId, beforeRevision);
  expected.revisions = edited.document.revisions;
  expected.project.updatedAt = edited.document.project.updatedAt;
  expected.nodes.find(node => node.id === motion.guideNodeId)!.components[0].data.pathData = change.pathData;
  (expected.constraints[0].parameters as FollowPathParameters).progress.keyframes = change.keyframes;
  expected.animationTracks = [change.rod];
  assert.deepEqual(edited.document, expected);
  await inspect(delivery, "edited", edited);
  const updated = await verifyCreativeDelivery(delivery, artifacts, { approved: approve(edited) });
  const editedMedia = await preserve("edited", updated, edited, editedSwing);
  assert.notEqual(updated.video.decoded.rgbHash, original.video.decoded.rgbHash);
  const rightwardCrossingBefore = release + originalSwing.quarterFrames;
  const beforeX = beforeMedia.poses[rightwardCrossingBefore].center[0], editedX = editedMedia.poses[rightwardCrossingBefore].center[0];
  assert.ok(beforeX - editedX >= 20, "At the original crossing frame the edit must visibly lag to its left");
  beforeMedia.pngs.forEach((png, index) => unchangedOutside(png, editedMedia.pngs[index]));
  evidence.motionEdit = { before: beforeMedia.summary, edited: editedMedia.summary, outsidePreviewRegionIdentical: true,
    crossingComparison: { frame: rightwardCrossingBefore, beforeX, editedX } };

  await host.close();
  host = await openCreativeHost({ directory });
  const reopened = deliverySession(host);
  const restorer = host.createSession({ projectId, allowDestructive: true,
    toolIds: ["project.inspect", "project.snapshot.inspect", "project.snapshot.restore", "project.snapshot.save", "execution.list"],
    permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "snapshot.restore", "execution.read"] });
  assert.deepEqual(await invoke<ProjectDocument>(restorer, "project.inspect"), edited.document);
  for (const snapshot of [before, edited]) assert.deepEqual(await invoke<ProjectSnapshot>(restorer, "project.snapshot.inspect", { snapshotId: snapshot.id }), snapshot);
  const priorJobs = [...jobsOf(original), ...jobsOf(updated)];
  for (const job of priorJobs) {
    assert.deepEqual(await reopened.jobs.get(job.id), job);
    assert.ok(job.result && await readVerifiedJobArtifact(artifacts, job.result));
  }
  const restoredDocument = await invoke<ProjectDocument>(restorer, "project.snapshot.restore", { snapshotId: before.id,
    baseRevisionId: revision(edited.document), message: "Restore the original authored pendulum after reopening" });
  assert.deepEqual(restoredDocument.revisions.slice(0, -1), edited.document.revisions);
  assert.equal(restoredDocument.revisions.at(-1)?.parentRevisionId, revision(edited.document));
  assert.equal(restoredDocument.revisions.at(-1)?.snapshotHash, before.contentHash);
  assert.deepEqual({ ...restoredDocument, project: { ...restoredDocument.project, updatedAt: before.document.project.updatedAt },
    revisions: before.document.revisions }, before.document);
  const restored = await retain(restorer, "restored", revision(restoredDocument));
  assert.deepEqual(restored.document, restoredDocument);
  assert.notEqual(restored.contentHash, before.contentHash);
  const recovery = await verifyCreativeDeliveryRecovery(reopened, artifacts, { reference: original, restored: approve(restored) });
  const restoredMedia = await preserve("restored", recovery.restored, restored, originalSwing);
  assert.deepEqual(restoredMedia.poses, beforeMedia.poses);
  assert.ok(jobsOf(recovery.restored).every(job => !priorJobs.some(prior => prior.id === job.id)));
  assert.deepEqual(await invoke<ProjectSnapshot>(restorer, "project.snapshot.inspect", { snapshotId: edited.id }), edited);
  await save("recovery.json", recovery);
  evidence.recovery = { source: recovery.sourceSnapshot, restored: recovery.restored.snapshot, verifiedPriorJobs: priorJobs.map(job => job.id),
    restoredJobs: jobsOf(recovery.restored).map(job => job.id), comparison: recovery.comparison, decodedVideoMatches: true };

  const ledger = await invoke<ToolExecutionRecord[]>(restorer, "execution.list");
  const verified = calls.filter(call => call.toolId !== "execution.list").map(call => {
    const entry = ledger.find(item => item.runId === call.runId && item.callId === call.callId);
    assert.ok(entry && entry.status === "succeeded" && entry.toolId === call.toolId && entry.toolVersion === call.toolVersion && entry.projectId === projectId);
    return { ...call, executionId: entry.id, inputHash: entry.inputHash, status: entry.status };
  });
  await save("tool-invocations.json", verified);
  await rm(join(output, "attempted-invocations.json"), { force: true });
  evidence.toolAuthorship = { emptyAtCreation: true, verifiedInvocations: verified.length };
  evidence.status = "passed";
  console.log("Verified three tool-authored pendulum deliveries. All 360 decoded poses match the authored motion, and the restored video and PNG pixels match the original exactly.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  await save("attempted-invocations.json", calls);
  throw error;
} finally {
  try { await save("evidence.json", evidence); }
  finally {
    try { await host?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
