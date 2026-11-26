import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeDeliveryReport } from "../src/contracts/creative-delivery";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import { FileSystemArtifactReferenceStore } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyCreativeDelivery, verifyCreativeDeliveryRecovery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import type { KeyframeEdit } from "../src/platform/keyframe-edits";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { ThreeJsProjectGraphRenderer } from "../src/renderers/three/three-project-graph-renderer";
import { measureThreeCameraVideo, projectThreeCameraBounds, retainThreeStaticStudy, threeCameraOriginalYaw as originalYaw,
  threeCameraPanTrackId, threeCameraRange as range, threeCameraTracks as tracks, threeStudyProjectId as projectId,
  threeStudySource as source } from "./fixtures/three-camera-shot";
import { inspectThreePixels, threeProfile as profile } from "./fixtures/three-scene-pixels";

const output = resolve("out/three-host-delivery");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-three-delivery-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const identity = { id: "three-js-project-graph", version: "1.1.0" };
const editedYaw = 6, previewFrames = [6, 26, 47];
const finalFrame = range.startFrame + range.durationFrames - 1;
const edit: KeyframeEdit = { op: "update", trackId: threeCameraPanTrackId, frame: finalFrame, changes: { value: [-14, editedYaw, 0] } };
const phases: string[] = [], calls: Array<{ toolId: string; input: unknown }> = [];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", source, renderer: identity, range, profile, previewFrames,
  tracks, edit, finalYawDegrees: { original: originalYaw, edited: editedYaw, restored: originalYaw }, phases, calls };
type Stage = "original" | "edited" | "restored";
const revision = (document: ProjectDocument) => document.revisions.at(-1)!;
const approve = (snapshot: ProjectSnapshot) => ({ id: snapshot.id, revisionId: revision(snapshot.document).id, contentHash: snapshot.contentHash });
const jobsOf = (report: CreativeDeliveryReport) => [...report.previews.map(item => item.job), report.video.job];

async function save(file: string, value: unknown) {
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n");
}

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, toolId);
  calls.push({ toolId, input });
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "p2-2-d-three-delivery", callId: `call-${calls.length}` });
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function withHost<T>(phase: string, work: (host: CreativeHost, delivery: CreativeSession) => Promise<T>) {
  const renderer = new ThreeJsProjectGraphRenderer();
  assert.deepEqual({ id: renderer.id, version: renderer.version }, identity);
  const host = await openCreativeHost({ directory, renderer });
  phases.push(phase);
  try {
    const delivery = host.createSession({ projectId, toolIds: ["project.snapshot.inspect", "render.preview", "render.video"],
      permissions: ["snapshot.read", "artifact.write"] });
    return await work(host, delivery);
  } finally { await host.close(); }
}

async function retain(session: CreativeSession, stage: Stage, snapshotId: string, revisionId: string) {
  const receipt = await invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId, revisionId });
  const snapshot = await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId });
  const { document, ...metadata } = snapshot;
  assert.deepEqual(receipt, metadata);
  assert.equal(snapshot.id, snapshotId);
  assert.equal(revision(document).id, revisionId);
  assert.equal(snapshot.contentHash, hashProject(document));
  await save(`${stage}/snapshot.json`, snapshot);
  return snapshot;
}

async function retainedBytes(host: CreativeHost, session: CreativeSession, job: RenderJobRecord) {
  assert.deepEqual(await session.jobs.get(job.id), job);
  const status = await host.maintenance.renderJobs.inspect(projectId, job.id);
  assert.ok(status && "input" in status && status.input.retained && status.output?.availability === "verified" &&
    status.output.retainedByJob && status.output.referenceAttached);
  assert.ok(job.result);
  assert.deepEqual(status.output.receipt, job.result);
  const bytes = await readVerifiedJobArtifact(artifacts, job.result);
  assert.ok(bytes);
  return bytes;
}

async function preserve(host: CreativeHost, session: CreativeSession, stage: Stage, snapshot: ProjectSnapshot, report: CreativeDeliveryReport, finalYaw: number) {
  assert.equal(report.projectId, projectId);
  assert.deepEqual([report.snapshot, report.profile, report.range], [approve(snapshot), profile, range]);
  assert.deepEqual(report.selection.frames.map(item => item.frame), previewFrames);
  assert.deepEqual(report.previews.map(item => item.frame), previewFrames);
  assert.deepEqual([report.video.decoded.codec, report.video.decoded.frames, report.video.decoded.durationSeconds, report.video.decoded.audio],
    ["h264", 42, 1.75, undefined]);
  const files = [...report.previews.map(({ frame, job, rgbaHash }) => ({ frame, job, rgbaHash, name: `preview-${frame}.png` })),
    { job: report.video.job, frame: undefined, rgbaHash: undefined, name: "camera-motion.mp4" }];
  await save(`${stage}/delivery.json`, report);
  const previews = [];
  for (const { frame, job, rgbaHash, name } of files) {
    const request = frame === undefined ? { operation: "video", ...range } : { operation: "preview", frame };
    assert.deepEqual([job.state, job.outcomeUnknown, job.input.projectId], ["succeeded", false, projectId]);
    assert.deepEqual([job.input.snapshot, job.input.renderer, job.input.profile, job.input.render], [approve(snapshot), identity, profile, request]);
    assert.ok(job.result);
    assert.deepEqual([job.result.jobId, job.result.inputHash, job.result.rendererId, job.result.rendererVersion, job.result.mediaType],
      [job.id, job.inputHash, identity.id, identity.version, frame === undefined ? "video/mp4" : "image/png"]);
    const bytes = await retainedBytes(host, session, job);
    await writeFile(join(output, stage, name), bytes);
    if (frame === undefined) continue;
    const png = PNG.sync.read(Buffer.from(bytes)), predicted = projectThreeCameraBounds(frame, finalYaw);
    assert.deepEqual([png.width, png.height], [profile.width, profile.height]);
    assert.equal(createHash("sha256").update(png.data).digest("hex"), rgbaHash);
    previews.push({ predicted, pixels: inspectThreePixels(png.data, 4, frame, predicted) });
  }
  const { frames, rgbHash } = measureThreeCameraVideo(join(output, stage, "camera-motion.mp4"), finalYaw);
  assert.equal(rgbHash, report.video.decoded.rgbHash);
  for (const { pixels } of previews) {
    const encoded = frames[pixels.frame - range.startFrame].pixels;
    for (const object of ["box", "sphere"] as const) {
      assert.ok(encoded[object].every((n, k) => Math.abs(n - pixels[object][k]) <= 3), `${stage} ${object} differs between preview and video at ${pixels.frame}`);
    }
  }
  await save(`${stage}/motion.json`, { finalYawDegrees: finalYaw, previews, frames, rgbHash });
  return { previews, frames };
}

async function rejectsWithoutRendering(session: CreativeSession, code: string, attempt: () => Promise<unknown>) {
  const before = await session.jobs.list(), inventory = await artifacts.list();
  await assert.rejects(attempt, { code });
  assert.deepEqual(await session.jobs.list(), before);
  assert.deepEqual(await artifacts.list(), inventory);
  return { code, jobCount: before.total, artifactCount: inventory.length };
}

async function verifyReopen(host: CreativeHost, session: CreativeSession, snapshots: ProjectSnapshot[], reports: CreativeDeliveryReport[]) {
  for (const snapshot of snapshots)
    assert.deepEqual(await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: snapshot.id }), snapshot);
  const jobs = reports.flatMap(jobsOf), ids = jobs.map(job => job.id);
  assert.equal(new Set(ids).size, jobs.length);
  assert.deepEqual((await session.jobs.list({ limit: 24 })).jobs.map(job => job.id).sort(), [...ids].sort());
  for (const job of jobs) await retainedBytes(host, session, job);
  return ids;
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const baseline = await retainThreeStaticStudy(directory, artifacts, references);
  const { original, edited, beforeReport, editedReport, beforeMotion } = await withHost("author-and-deliver", async (host, delivery) => {
    const editor = host.createSession({ projectId,
      toolIds: ["animation.keyframes.set", "animation.keyframes.edit", "project.inspect", "project.snapshot.inspect", "project.snapshot.save"],
      permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write"] });
    let revisionId = source.revisionId;
    for (const { id: trackId, ...track } of tracks) {
      const saved = await invoke<{ trackId: string; revisionId: string }>(editor, "animation.keyframes.set", { trackId, ...track });
      assert.equal(saved.trackId, trackId);
      assert.notEqual(saved.revisionId, revisionId);
      revisionId = saved.revisionId;
    }
    const original = await retain(editor, "original", "three-camera-motion-v1", revisionId);
    assert.deepEqual(original.document, { ...baseline.document, animationTracks: tracks, revisions: original.document.revisions,
      project: { ...baseline.document.project, updatedAt: original.document.project.updatedAt } });
    const changed = await invoke<{ revisionId: string; changedAnimationTrackIds: string[] }>(editor, "animation.keyframes.edit",
      { baseRevisionId: revisionId, edits: [edit] });
    assert.deepEqual(changed.changedAnimationTrackIds, [threeCameraPanTrackId]);
    const edited = await retain(editor, "edited", "three-camera-edited-v1", changed.revisionId);
    assert.deepEqual(edited.document.revisions.slice(0, -1), original.document.revisions);
    assert.equal(revision(edited.document).parentRevisionId, revisionId);
    assert.notEqual(edited.contentHash, original.contentHash);
    const expected = structuredClone(original.document);
    expected.revisions = edited.document.revisions;
    expected.project.updatedAt = edited.document.project.updatedAt;
    expected.animationTracks.find(track => track.id === edit.trackId)!.keyframes.at(-1)!.value = edit.changes.value;
    assert.deepEqual(edited.document, expected);
    assert.deepEqual(await invoke<ProjectDocument>(editor, "project.inspect", {}), edited.document);

    evidence.approvalRejection = await rejectsWithoutRendering(delivery, "DELIVERY_SNAPSHOT_MISMATCH", () =>
      verifyCreativeDelivery(delivery, artifacts, { approved: { ...approve(original), contentHash: edited.contentHash }, range }));
    // The live project is already edited when we ask for the original approved shot.
    evidence.workingRevisionDuringOriginalDelivery = changed.revisionId;
    const beforeReport = await verifyCreativeDelivery(delivery, artifacts, { approved: approve(original), range, maxPreviewFrames: 3 });
    const beforeMotion = await preserve(host, delivery, "original", original, beforeReport, originalYaw);
    const editedReport = await verifyCreativeDelivery(delivery, artifacts, { approved: approve(edited), range, maxPreviewFrames: 3 });
    const editedMotion = await preserve(host, delivery, "edited", edited, editedReport, editedYaw);
    assert.deepEqual(editedReport.selection, beforeReport.selection);
    assert.notEqual(editedReport.renderContentHash, beforeReport.renderContentHash);
    assert.notEqual(editedReport.video.decoded.rgbHash, beforeReport.video.decoded.rgbHash);
    assert.equal(editedReport.previews[0].rgbaHash, beforeReport.previews[0].rgbaHash);
    const boxCenterX = ({ frames }: typeof beforeMotion) => {
      const [left, , right] = frames.at(-1)!.pixels.box;
      return (left + right) / 2;
    };
    const originalX = boxCenterX(beforeMotion), editedX = boxCenterX(editedMotion);
    assert.ok(originalX - editedX >= 60, `Edited yaw must clearly move the box left at scene frame ${finalFrame}`);
    evidence.motionEdit = { frame: finalFrame, originalBoxCenterX: originalX, editedBoxCenterX: editedX, firstPreviewMatches: true };
    return { original, edited, beforeReport, editedReport, beforeMotion };
  });

  const { restored, recovery } = await withHost("reopen-and-restore", async (host, delivery) => {
    const restorer = host.createSession({ projectId, allowDestructive: true,
      toolIds: ["project.inspect", "project.snapshot.inspect", "project.snapshot.restore", "project.snapshot.save"],
      permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "snapshot.restore"] });
    assert.deepEqual(await invoke<ProjectDocument>(restorer, "project.inspect", {}), edited.document);
    const priorJobs = await verifyReopen(host, delivery, [baseline, original, edited], [beforeReport, editedReport]);
    evidence.reopenedJobIds = priorJobs;
    evidence.restoreRejection = await rejectsWithoutRendering(delivery, "DELIVERY_RESTORE_MISMATCH", () =>
      verifyCreativeDeliveryRecovery(delivery, artifacts, { reference: beforeReport, restored: approve(edited) }));
    const restoredDocument = await invoke<ProjectDocument>(restorer, "project.snapshot.restore", { snapshotId: original.id,
      baseRevisionId: revision(edited.document).id, message: "Restore the original camera move after reopening" });
    assert.deepEqual(restoredDocument.revisions.slice(0, -1), edited.document.revisions);
    const latest = revision(restoredDocument);
    assert.equal(latest.parentRevisionId, revision(edited.document).id);
    assert.equal(latest.snapshotHash, original.contentHash);
    assert.deepEqual(restoredDocument, { ...original.document, revisions: restoredDocument.revisions,
      project: { ...original.document.project, updatedAt: restoredDocument.project.updatedAt } });
    const restored = await retain(restorer, "restored", "three-camera-restored-v1", latest.id);
    assert.deepEqual(restored.document, restoredDocument);
    assert.notEqual(restored.contentHash, original.contentHash);
    assert.notEqual(restored.contentHash, edited.contentHash);
    const recovery = await verifyCreativeDeliveryRecovery(delivery, artifacts, { reference: beforeReport, restored: approve(restored) });
    const recoveredMotion = await preserve(host, delivery, "restored", restored, recovery.restored, originalYaw);
    assert.deepEqual(recoveredMotion, beforeMotion);
    assert.deepEqual(recovery.sourceSnapshot, approve(original));
    assert.equal(recovery.restored.renderContentHash, beforeReport.renderContentHash);
    assert.deepEqual(recovery.comparison, { previewFrames, rgbHash: beforeReport.video.decoded.rgbHash });
    const restoredJobIds = jobsOf(recovery.restored).map(job => job.id);
    assert.ok(restoredJobIds.every(id => !priorJobs.includes(id)));
    evidence.restoration = { ...recovery.comparison, source: recovery.sourceSnapshot, restored: recovery.restored.snapshot, revision: latest, restoredJobIds };
    await save("recovery.json", recovery);
    return { restored, recovery };
  });

  await withHost("reopen-and-confirm", async (host, delivery) => {
    const reader = host.createSession({ projectId, toolIds: ["project.inspect"], permissions: ["project.read"] });
    assert.deepEqual(await invoke<ProjectDocument>(reader, "project.inspect", {}), restored.document);
    evidence.finalRetainedJobIds = await verifyReopen(host, delivery, [baseline, original, edited, restored], [beforeReport, editedReport, recovery.restored]);
  });
  evidence.status = "passed";
  console.log("Verified original, edited and restored Three.js deliveries. All 126 video poses matched, and restored PNG and video pixels match the original exactly after reopen.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await save("evidence.json", evidence); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
