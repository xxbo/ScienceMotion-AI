import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { verifyCreativeDelivery } from "../../src/platform/creative-delivery";
import type { PendulumMathShot } from "../../src/platform/pendulum-math-shot";
import { decodePendulumTrajectory } from "../../src/platform/pendulum-trajectory-artifact";
import { hashProject, type ProjectSnapshot } from "../../src/platform/project-snapshots";
import { createPendulumReplayProject, replayAssetId, replayProfile, replayRange, replaySnapshotId } from "./pendulum-replay-project";

export const pendulumAlignmentRenderers = {
  remotion: "remotion.pendulum-replay", three: "three-js-pendulum-replay", manim: "manim.pendulum-math",
} as const;
export type PendulumAlignmentView = keyof typeof pendulumAlignmentRenderers;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Source = { artifactId: string; bSnapshotHash: string; contentHash: string };
type SnapshotBinding = { id: string; revisionId: string; contentHash: string };
type Report = { schemaVersion: string; checkout: string; status: string; source: Source; snapshot: Omit<SnapshotBinding, "revisionId">;
  profile: typeof replayProfile; range: typeof replayRange };
type MathReport = Report & { snapshot: SnapshotBinding; inputHash: string; renderer: { id: string; version: string };
  media: { file: string; sha256: string; sizeBytes: number; frameCount: number; durationSeconds: number; codec: string; silent: boolean } };
type MotionReport = Awaited<ReturnType<typeof verifyCreativeDelivery>>;
const version = "1.0.0";

async function json<T>(path: string) {
  const bytes = await readFile(path);
  return { bytes, obj: JSON.parse(bytes.toString("utf8")) as T };
}

/** Verify declared provenance before any video bytes are sent to the decoder. */
export async function readPendulumAlignmentInputs(checkout: string, directory = resolve("out")) {
  const c = join(directory, "pendulum-replay"), d = join(directory, "pendulum-math");
  const [cReport, dReport, cSnapshot, dSnapshot, rawSource, dSource, mathInput] = await Promise.all([
    json<Report>(join(c, "evidence.json")), json<MathReport>(join(d, "evidence.json")),
    json<ProjectSnapshot>(join(c, "snapshot.json")), json<ProjectSnapshot>(join(d, "snapshot.json")),
    readFile(join(c, "trajectory.json")), readFile(join(d, "trajectory.json")), json<PendulumMathShot>(join(d, "manim-input.json")),
  ]);
  for (const { obj } of [cReport, dReport])
    assert.deepEqual([obj.schemaVersion, obj.checkout, obj.status, obj.profile, obj.range],
      [version, checkout, "passed", replayProfile, replayRange], "Use passing C and D evidence from this exact checkout.");
  assert.ok(rawSource.equals(dSource), "The three deliveries must use the same retained trajectory bytes.");
  const contentHash = sha256(rawSource), artifactId = "sha256:" + contentHash, uri = "artifact://sha256/" + contentHash;
  const source = cReport.obj.source;
  assert.match(source.bSnapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(source, { contentHash, artifactId, bSnapshotHash: source.bSnapshotHash });
  assert.deepEqual(dReport.obj.source, source);

  const snapshot = cSnapshot.obj, project = createPendulumReplayProject(contentHash);
  const binding = { id: replaySnapshotId, contentHash: hashProject(project), revisionId: project.revisions.at(-1)!.id };
  assert.deepEqual(snapshot, dSnapshot.obj);
  assert.deepEqual([snapshot.id, snapshot.contentHash, snapshot.projectId, hashProject(snapshot.document)],
    [binding.id, binding.contentHash, project.project.id, binding.contentHash]);
  assert.deepEqual(snapshot.document.assets, [{ id: replayAssetId, kind: "data", contentHash, uri }]);
  assert.deepEqual(cReport.obj.snapshot, { id: binding.id, contentHash: binding.contentHash });
  assert.deepEqual(dReport.obj.snapshot, binding);
  assert.deepEqual([sha256(mathInput.bytes), mathInput.obj.source, mathInput.obj.profile, mathInput.obj.range, mathInput.obj.renderer],
    [dReport.obj.inputHash, { artifactId, snapshotHash: binding.contentHash, revisionId: binding.revisionId }, replayProfile, replayRange,
      { id: pendulumAlignmentRenderers.manim, version }]);

  const durationSeconds = replayRange.durationFrames / replayProfile.fps;
  const motion = await Promise.all((["remotion", "three"] as const).map(async view => {
    const path = join(c, view, "replay.mp4"), renderer = { id: pendulumAlignmentRenderers[view], version };
    const [delivery, bytes] = await Promise.all([json<MotionReport>(join(c, view, "delivery.json")), readFile(path)]);
    const { job, decoded } = delivery.obj.video, hash = sha256(bytes);
    assert.deepEqual([delivery.obj.snapshot, delivery.obj.profile, delivery.obj.range, job.state, job.outcomeUnknown,
      job.input.snapshot, job.input.profile, job.input.render, job.input.renderer],
    [binding, replayProfile, replayRange, "succeeded", false, binding, replayProfile, { operation: "video", ...replayRange }, renderer]);
    assert.deepEqual(job.result, { jobId: job.id, inputHash: job.inputHash, artifactId: "sha256:" + hash, contentHash: hash,
      sizeBytes: bytes.length, mediaType: "video/mp4", rendererId: renderer.id, rendererVersion: renderer.version });
    assert.deepEqual([decoded.codec, decoded.frames, decoded.durationSeconds, decoded.audio], ["h264", replayRange.durationFrames, durationSeconds, undefined]);
    return { view, bytes, sha256: hash, renderer, receipt: { jobId: job.id, sha256: sha256(delivery.bytes) } };
  }));
  const path = join(d, "pendulum-math.mp4"), bytes = await readFile(path), hash = sha256(bytes), dm = dReport.obj;
  const manim = { id: pendulumAlignmentRenderers.manim, version };
  assert.deepEqual([dm.renderer.id, dm.renderer.version, dm.media.file, dm.media.codec, dm.media.silent, dm.media.sha256,
    dm.media.sizeBytes, dm.media.frameCount, dm.media.durationSeconds],
  [manim.id, manim.version, "pendulum-math.mp4", "h264", true, hash, bytes.length, replayRange.durationFrames, durationSeconds]);
  const media = [...motion, { view: "manim" as const, bytes, sha256: hash, renderer: manim, receipt: { inputHash: dm.inputHash,
    sha256: sha256(dReport.bytes) } }];
  assert.equal(new Set(media.map(item => item.sha256)).size, 3, "Require three distinct rendered videos.");
  return { source, binding, snapshotBytes: cSnapshot.bytes, trajectoryBytes: rawSource, trajectory: decodePendulumTrajectory(rawSource), media,
    upstreamReports: { replay: sha256(cReport.bytes), mathematics: sha256(dReport.bytes) } };
}
