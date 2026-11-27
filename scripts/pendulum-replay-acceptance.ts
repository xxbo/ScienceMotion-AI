import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { ProjectGraphSnapshotRenderer } from "../src/contracts/renderer";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyCreativeDelivery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { decodePendulumTrajectory } from "../src/platform/pendulum-trajectory-artifact";
import type { ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { RemotionPendulumReplayRenderer } from "../src/renderers/remotion/remotion-project-graph-renderer";
import { ThreeJsPendulumReplayRenderer } from "../src/renderers/three/three-project-graph-renderer";
import { createPendulumReplayProject, replayProfile as profile, replayProjectId as projectId, replayRange as range, replaySnapshotId } from "./fixtures/pendulum-replay-project";
import { readRetainedLongPendulum } from "./fixtures/pendulum-retained-source";

const output = resolve("out/pendulum-replay");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-pendulum-replay-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", profile, range };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const write = async (file: string, bytes: Uint8Array | string) => {
  const path = join(output, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
};
const save = (file: string, value: unknown) => write(file, JSON.stringify(value, null, 2) + "\n");
const previewFrames = [7, 51, 95];
const { width, height, fps } = profile;
const pixelsPerRod = 0.32 * Math.min(width, height), pivot = [width / 2, 0.42 * height] as const;
const tolerance = 2;
type Point = readonly [number, number];
type Expected = { sceneFrame: number; timeSeconds: number; center: Point };
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Linear interpolation of B's stored positions is independent of the replay's Hermite interpolation.
// At the retained sample rate the two agree to within a small fraction of a pixel.
function expectedAt(trajectory: ReturnType<typeof decodePendulumTrajectory>, sceneFrame: number): Expected {
  const timeSeconds = sceneFrame / fps, index = Math.floor(timeSeconds / trajectory.timeStepSeconds);
  const left = trajectory.samples[index], right = trajectory.samples[index + 1];
  const u = (timeSeconds - left.timeSeconds) / (right.timeSeconds - left.timeSeconds);
  const meter = (axis: number) => left.bobPositionMeters[axis] + u * (right.bobPositionMeters[axis] - left.bobPositionMeters[axis]);
  const scale = pixelsPerRod / trajectory.model.lengthMeters;
  return { sceneFrame, timeSeconds, center: [pivot[0] + scale * meter(0), pivot[1] - scale * meter(1)] };
}

function inspectPixels(bytes: Uint8Array, channels: 3 | 4, expected: Expected, label: string) {
  let left = width, right = -1, top = height, bottom = -1, count = 0;
  for (let i = 0, pixel = 0; i < bytes.length; i += channels, pixel++) {
    const r = bytes[i], g = bytes[i + 1], b = bytes[i + 2];
    if (r > 95 && r - g > 25 && g - b > 22) {
      const x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
    }
  }
  assert.ok(count >= 300 && count <= 600 && right - left >= 18 && right - left <= 27 && bottom - top >= 18 && bottom - top <= 27,
    `${label} frame ${expected.sceneFrame} does not contain one complete orange bob (${count} pixels, ${right - left + 1}×${bottom - top + 1})`);
  const center: Point = [(left + right + 1) / 2, (top + bottom + 1) / 2], errorPixels = distance(center, expected.center);
  assert.ok(errorPixels <= tolerance, `${label} frame ${expected.sceneFrame} misses the retained pose by ${errorPixels} px`);
  const brightNear = (x: number, y: number, threshold: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((Math.floor(y) + dy) * width + Math.floor(x) + dx) * channels;
      if (Math.min(bytes[i], bytes[i + 1], bytes[i + 2]) >= threshold) return true;
    }
    return false;
  };
  assert.ok(brightNear(...pivot, 115), `${label} frame ${expected.sceneFrame} is missing the fixed pivot`);
  assert.ok(brightNear((pivot[0] + expected.center[0]) / 2, (pivot[1] + expected.center[1]) / 2, 70),
    `${label} frame ${expected.sceneFrame} is missing the aligned rod`);
  return { sceneFrame: expected.sceneFrame, center, errorPixels, bobPixels: count };
}

function inspectVideo(path: string, expected: Expected[], label: string, rgbHash: string) {
  const frameBytes = width * height * 3;
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe",
    "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { timeout: 25_000, maxBuffer: frameBytes * range.durationFrames + 1024 });
  assert.equal(rgb.byteLength, frameBytes * range.durationFrames);
  assert.equal(sha(rgb), rgbHash);
  return expected.map((target, i) => inspectPixels(rgb.subarray(i * frameBytes, (i + 1) * frameBytes), 3, target, label));
}

async function render(label: string, renderer: ProjectGraphSnapshotRenderer, snapshot: ProjectSnapshot, expected: Expected[]) {
  const host = await openCreativeHost({ directory, renderer, renderJobs: { timeoutMs: 60_000 } });
  try {
    const session = host.createSession({ projectId, toolIds: ["project.snapshot.inspect", "render.preview", "render.video"],
      permissions: ["snapshot.read", "artifact.write"] });
    const approved = { id: snapshot.id, revisionId: snapshot.document.revisions.at(-1)!.id, contentHash: snapshot.contentHash };
    const report = await verifyCreativeDelivery(session, artifacts, { approved, range, maxPreviewFrames: 3, timeoutMs: 120_000 });
    assert.deepEqual([report.snapshot, report.profile, report.range], [approved, profile, range]);
    assert.deepEqual(report.previews.map(item => item.frame), previewFrames);
    assert.deepEqual([report.video.decoded.codec, report.video.decoded.frames, report.video.decoded.durationSeconds, report.video.decoded.audio],
      ["h264", range.durationFrames, range.durationFrames / fps, undefined]);
    const read = async (job: typeof report.video.job) => {
      assert.deepEqual(job.input.renderer, { id: renderer.id, version: renderer.version });
      assert.deepEqual(job.input.snapshot, approved);
      const retention = await host.maintenance.renderJobs.inspect(projectId, job.id);
      assert.ok(retention && "output" in retention && retention.input.retained && retention.output?.availability === "verified" && retention.output.referenceAttached);
      assert.ok(job.result);
      const bytes = await readVerifiedJobArtifact(artifacts, job.result);
      assert.ok(bytes);
      return bytes;
    };
    const previews = [];
    for (const { frame, job, rgbaHash } of report.previews) {
      const bytes = await read(job);
      await write(`${label}/preview-${frame}.png`, bytes);
      const png = PNG.sync.read(Buffer.from(bytes));
      assert.deepEqual([png.width, png.height, sha(png.data)], [width, height, rgbaHash]);
      previews.push(inspectPixels(png.data, 4, expected[frame - range.startFrame], label));
    }
    const path = await write(`${label}/replay.mp4`, await read(report.video.job));
    const frames = inspectVideo(path, expected, label, report.video.decoded.rgbHash);
    for (const preview of previews)
      assert.ok(distance(preview.center, frames[preview.sceneFrame - range.startFrame].center) <= tolerance);
    await save(`${label}/delivery.json`, report);
    console.log(`${label} verified ${previews.length} previews and ${frames.length} decoded frames.`);
    return { id: renderer.id, version: renderer.version, previews, frames, rgbHash: report.video.decoded.rgbHash };
  } finally { await host.close(); }
}

try {
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.checkout = checkout;
  const { bytes: trajectoryBytes, identity } = await readRetainedLongPendulum(checkout);
  const { artifactId, contentHash } = identity;
  const saved = await artifacts.put({ bytes: trajectoryBytes, kind: "data", mediaType: "application/json", provenance: { projectId } });
  assert.equal(saved.id, artifactId);
  evidence.source = identity;
  await write("trajectory.json", trajectoryBytes);

  const project = createPendulumReplayProject(contentHash);
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"),
    new LocalArtifactLifecycleManager(artifacts, new FileSystemArtifactReferenceStore(join(directory, "references"))));
  let snapshot: ProjectSnapshot;
  try {
    await workspace.create(project);
    snapshot = await workspace.saveSnapshot(projectId, project.revisions[0].id,
      { id: replaySnapshotId, createdAt: project.project.createdAt });
  } finally { await workspace.close(); }
  await save("snapshot.json", snapshot);
  evidence.snapshot = { id: snapshot.id, contentHash: snapshot.contentHash };
  const trajectory = decodePendulumTrajectory(trajectoryBytes);
  const expected = Array.from({ length: range.durationFrames }, (_, i) => expectedAt(trajectory, range.startFrame + i));
  assert.ok(distance(expectedAt(trajectory, 0).center, expected[0].center) > 6, "The nonzero trim must differ visibly from release");
  const remotion = await render("remotion", new RemotionPendulumReplayRenderer(), snapshot, expected);
  evidence.remotion = remotion;
  const three = await render("three", new ThreeJsPendulumReplayRenderer(), snapshot, expected);
  evidence.three = three;
  const comparison = expected.map((target, i) => ({ ...target, rendererDeltaPixels: distance(remotion.frames[i].center, three.frames[i].center) }));
  const maxCrossRendererDeltaPixels = Math.max(...comparison.map(item => item.rendererDeltaPixels));
  assert.ok(maxCrossRendererDeltaPixels <= tolerance);
  assert.notEqual(remotion.rgbHash, three.rgbHash, "The two views must be separate renders");
  await save("frames.json", comparison);
  evidence.comparison = { framesPerRenderer: range.durationFrames, maxCrossRendererDeltaPixels,
    maxRemotionErrorPixels: Math.max(...remotion.frames.map(item => item.errorPixels)),
    maxThreeErrorPixels: Math.max(...three.frames.map(item => item.errorPixels)) };
  evidence.status = "passed";
  console.log(`Verified ${range.durationFrames} matched frame pairs from retained trajectory ${artifactId}. Maximum 2D/3D bob delta ${maxCrossRendererDeltaPixels.toFixed(3)} px.`);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await save("evidence.json", evidence); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
