import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { RenderJobRecord } from "../src/contracts/render-job";
import { FileSystemArtifactReferenceStore } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyDeliveryPreview, verifyDeliveryVideo } from "../src/platform/creative-delivery-media";
import { openCreativeHost } from "../src/platform/creative-host";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { ThreeJsProjectGraphRenderer } from "../src/renderers/three/three-project-graph-renderer";
import { measureThreeCameraVideo, projectThreeCameraBounds as predictedAt, retainThreeStaticStudy, threeCameraNodeId as camera,
  threeCameraRange as range, threeCameraTracks as tracks, threeStudyProjectId as projectId, threeStudySource as source } from "./fixtures/three-camera-shot";
import { inspectThreePixels, threeProfile as profile } from "./fixtures/three-scene-pixels";

const output = resolve("out/three-camera-motion");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-three-camera-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const renderer = new ThreeJsProjectGraphRenderer();
const identity = { id: renderer.id, version: renderer.version };
const runId = "p2-2-c-three-camera", previewFrames = [6, 23, 47];
const { width, height } = profile;
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", source, renderer: identity, profile, range, tracks };
let host: CreativeHost | undefined, calls = 0;
const json = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n");

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId, callId: `call-${++calls}` });
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function job(session: CreativeSession, label: string, snapshotId: string, render: RenderJobRecord["input"]["render"]) {
  const submission = render.operation === "preview"
    ? { toolId: "render.preview" as const, input: { snapshotId, frame: render.frame } }
    : { toolId: "render.video" as const, input: { snapshotId, startFrame: render.startFrame, durationFrames: render.durationFrames } };
  const manifest = await session.manifest(submission.toolId);
  assert.ok(manifest);
  const admitted = await session.jobs.submit({ ...submission, runId, submissionId: label, callId: label, toolVersion: manifest.version });
  assert.ok(admitted.created);
  const deadline = AbortSignal.timeout(90_000);
  for (;;) {
    const current = await session.jobs.get(admitted.record.id);
    assert.ok(current && current.inputHash === admitted.record.inputHash);
    if (!["queued", "running", "stopping", "publishing"].includes(current.state)) return current;
    await delay(50, undefined, { signal: deadline });
  }
}

async function saveMedia(record: RenderJobRecord, snapshot: typeof source, request: RenderJobRecord["input"]["render"], name: string) {
  assert.equal(record.state, "succeeded", JSON.stringify(record.diagnostic));
  assert.equal(record.outcomeUnknown, false);
  assert.deepEqual(record.input.snapshot, snapshot);
  assert.deepEqual(record.input.renderer, identity);
  assert.deepEqual(record.input.profile, profile);
  assert.deepEqual(record.input.render, request);
  assert.ok(record.result);
  assert.deepEqual([record.result.rendererId, record.result.rendererVersion], [identity.id, identity.version]);
  const bytes = await readVerifiedJobArtifact(artifacts, record.result);
  assert.ok(bytes);
  const retention = await host!.maintenance.renderJobs.inspect(projectId, record.id);
  assert.ok(retention && "output" in retention && retention.output?.availability === "verified" && retention.output.referenceAttached);
  const file = join(output, name);
  await writeFile(file, bytes);
  return { file, bytes };
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const baseline = await retainThreeStaticStudy(directory, artifacts, references);
  const { document } = baseline;
  host = await openCreativeHost({ directory, renderer });
  const session = host.createSession({ projectId, toolIds: ["render.preview", "render.video", "project.snapshot.inspect", "project.snapshot.save", "animation.keyframes.set"],
    permissions: ["artifact.write", "snapshot.read", "snapshot.write", "project.read", "project.write"] });
  let revisionId = source.revisionId;
  for (const { id: trackId, ...track } of tracks) {
    const receipt = await invoke<{ trackId: string; revisionId: string }>(session, "animation.keyframes.set", { trackId, ...track });
    assert.equal(receipt.trackId, trackId);
    assert.notEqual(receipt.revisionId, revisionId);
    revisionId = receipt.revisionId;
  }
  const saved = await invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId: "three-camera-motion-v1", revisionId });
  const snapshot = { id: saved.id, revisionId, contentHash: saved.contentHash };
  const retained = await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: snapshot.id });
  assert.equal(retained.contentHash, hashProject(retained.document));
  assert.equal(retained.contentHash, snapshot.contentHash);
  assert.notEqual(retained.contentHash, source.contentHash);
  assert.equal(retained.document.revisions.at(-1)?.id, revisionId);
  assert.deepEqual(retained.document.animationTracks, tracks);
  assert.deepEqual({ ...retained.document, animationTracks: document.animationTracks, revisions: document.revisions,
    project: { ...retained.document.project, updatedAt: document.project.updatedAt } }, document);
  evidence.snapshot = snapshot;
  await json("snapshot.json", retained);

  const previews = [];
  for (const frame of previewFrames) {
    const request = { operation: "preview", frame } as const;
    const file = `preview-${frame}.png`;
    const rendered = await job(session, `preview-${frame}`, snapshot.id, request);
    const png = await saveMedia(rendered, snapshot, request, file);
    const decoded = PNG.sync.read(Buffer.from(png.bytes));
    assert.deepEqual([decoded.width, decoded.height], [width, height]);
    const predicted = predictedAt(frame);
    const pixels = inspectThreePixels(decoded.data, 4, frame, predicted);
    const rgbaHash = await verifyDeliveryPreview(png.file, profile, AbortSignal.timeout(20_000));
    previews.push({ job: rendered, file, rgbaHash, predicted, pixels });
  }
  evidence.previews = previews;
  const videoRequest = { operation: "video", ...range } as const;
  const rendered = await job(session, "camera-motion", snapshot.id, videoRequest);
  const video = await saveMedia(rendered, snapshot, videoRequest, "camera-motion.mp4");
  const media = await verifyDeliveryVideo(video.file, profile, range, false, AbortSignal.timeout(20_000));
  assert.deepEqual([media.codec, media.frames, media.durationSeconds, media.audio], ["h264", 42, 1.75, undefined]);
  const { frames, rgbHash } = measureThreeCameraVideo(video.file);
  assert.equal(rgbHash, media.rgbHash);
  for (const preview of previews) {
    const frame = preview.pixels.frame;
    const { pixels } = frames[frame - range.startFrame];
    for (const object of ["box", "sphere"] as const) {
      assert.ok(pixels[object].every((n, k) => Math.abs(n - preview.pixels[object][k]) <= 3), `Encoded ${object} diverged from scene preview ${frame}`);
    }
  }
  const centerX = ([left, , right]: number[]) => (left + right) / 2;
  const boxCenters = previews.map(({ pixels }) => centerX(pixels.box));
  assert.ok(boxCenters[1] < boxCenters[0] - 35 && boxCenters[2] > boxCenters[1] + 70, "Expected the box to slide left and pan back right");
  evidence.video = { job: rendered, file: "camera-motion.mp4", media, frames };

  const unsupported = await invoke<{ revisionId: string }>(session, "animation.keyframes.set", { trackId: "unsupported-camera-scale", targetNodeId: camera,
    targetProperty: "transform.scale", keyframes: [{ frame: 0, value: [1, 1, 1] }, { frame: 47, value: [2, 2, 2] }] });
  const candidate = await invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId: "unsupported-camera-scale", revisionId: unsupported.revisionId });
  const before = await artifacts.list();
  const rejected = await job(session, "unsupported-motion", candidate.id, videoRequest);
  assert.equal(rejected.state, "failed");
  assert.deepEqual(rejected.input.snapshot, { id: candidate.id, revisionId: unsupported.revisionId, contentHash: candidate.contentHash });
  assert.equal(rejected.diagnostic?.code, "THREE_STATIC_UNSUPPORTED_ANIMATION");
  assert.match(rejected.diagnostic?.message ?? "", /view-camera.*\/project\/animationTracks\/2/);
  assert.equal(rejected.publicationStartedAt, undefined);
  assert.equal(rejected.result, undefined);
  assert.equal(rejected.outcomeUnknown, false);
  assert.deepEqual(await artifacts.list(), before);
  assert.deepEqual(await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: source.id }), baseline);
  assert.deepEqual(await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: snapshot.id }), retained);
  evidence.rejection = { job: rejected, unchangedArtifactCount: before.length };
  evidence.status = "passed";
  console.log("Verified three camera previews and all 42 H.264 frames against independent 3D projections. The trimmed video starts at scene frame 6. Camera scale keys failed before publication.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await json("evidence.json", evidence); }
  finally { try { await host?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
