import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import type { CreativeHost } from "../src/contracts/creative-host";
import type { SnapshotInspectionReport } from "../src/contracts/inspection";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyDeliveryPreview, verifyDeliveryVideo } from "../src/platform/creative-delivery-media";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import type { PendulumReference } from "./fixtures/pendulum-reference";
import { derivePendulumPathReference } from "./fixtures/pendulum-path-reference";

type Point = [number, number];
type Receipt = { artifactId: string; contentHash: string; mediaType: string; metadata: Record<string, unknown> };
const source = await readFile("examples/pendulum-motion-reference.json", "utf8");
const [mode, extra] = process.argv.slice(2);
assert.ok((mode === undefined || mode === "--path-follow") && extra === undefined);
const reference = JSON.parse(source) as PendulumReference;
const variant = mode === "--path-follow" ? derivePendulumPathReference(reference) : undefined;
const { workload } = reference, snapshot = variant?.snapshot ?? reference.snapshot;
const { id: snapshotId, document, contentHash: snapshotHash, projectId } = snapshot;
const revisionId = document.revisions.at(-1)!.id;
const { profile, video: range, motion, checkpoints, searchWindow: crop, tolerances } = workload;
const { width, height } = profile;
const sceneId = document.scenes[0].id;
const renderer = { id: "remotion.project-graph", version: "1.0.0" };
const output = resolve(variant ? "out/pendulum-path-following" : "out/pendulum-reference");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-pendulum-reference-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const evidence: Record<string, unknown> = {
  schemaVersion: "1.0.0", status: "running", snapshot: { id: snapshotId, revisionId, contentHash: snapshotHash }, profile, range, renderer,
  ...(variant ? { referenceSnapshot: { id: reference.snapshot.id, contentHash: reference.snapshot.contentHash }, projection: variant.projection } : {}),
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
let host: CreativeHost | undefined;

function trackBob(pixels: Uint8Array, channels: 3 | 4, frame: number, cropped = false) {
  const stride = cropped ? crop.width : width;
  const xOrigin = cropped ? 0 : crop.x, yOrigin = cropped ? 0 : crop.y;
  const tolerance = channels === 4 ? tolerances.pngChannel : tolerances.videoChannel;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, samples = 0;
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const offset = ((yOrigin + y) * stride + xOrigin + x) * channels;
      if ((channels === 4 && pixels[offset + 3] !== 255) ||
          !workload.bobRgb.every((value, channel) => Math.abs(pixels[offset + channel] - value) <= tolerance)) continue;
      samples++;
      x0 = Math.min(x, x0); x1 = Math.max(x, x1);
      y0 = Math.min(y, y0); y1 = Math.max(y, y1);
    }
  }
  const idealArea = Math.PI * motion.bobRadiusPx ** 2;
  assert.ok(samples >= 0.55 * idealArea && samples <= 1.15 * idealArea, `Frame ${frame} did not contain one visible teal bob (${samples} pixels)`);
  assert.ok(x1 - x0 < 2 * motion.bobRadiusPx + 3 && y1 - y0 < 2 * motion.bobRadiusPx + 3,
    `Frame ${frame} contained separated or oversized bob pixels`);
  // Pixel centers are half a pixel from the edge of the canvas coordinate grid.
  const center: Point = [crop.x + (x0 + x1 + 1) / 2, crop.y + (y0 + y1 + 1) / 2];
  return { frame, center, samples };
}

function within(actual: Point, expected: Point, tolerance: number, label: string) {
  const error = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  assert.ok(error <= tolerance, `${label}: center ${actual} differed from ${expected} by ${error.toFixed(3)} px`);
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(hashProject(document), snapshotHash);
  await writeFile(join(output, "reference.json"), source);
  if (variant) await writeFile(join(output, "path-snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
  // Trusted fixture import retains the exact project revision and snapshot hash.
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  try {
    await workspace.create(document);
    assert.deepEqual(await workspace.saveSnapshot(projectId, revisionId, { id: snapshotId, createdAt: snapshot.createdAt }), snapshot);
  } finally { await workspace.close(); }
  host = await openCreativeHost({ directory });
  const session = host.createSession({ projectId, permissions: ["snapshot.read", "artifact.write"],
    toolIds: ["project.snapshot.inspect", "inspect.snapshot", "render.preview", "render.video"] });
  let calls = 0;
  async function invoke<T>(toolId: string, input: object): Promise<T> {
    const tool = await session.manifest(toolId);
    assert.ok(tool);
    const result = await session.invoke({ toolId, toolVersion: tool.version, input, runId: "p2-1-a-pendulum", callId: `call-${++calls}` });
    assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
    return result.output as T;
  }
  async function preserve(name: string, input: { frame: number } | typeof range) {
    const preview = "frame" in input;
    const receipt = await invoke<Receipt>(preview ? "render.preview" : "render.video", { snapshotId, ...input });
    assert.equal(receipt.mediaType, preview ? "image/png" : "video/mp4");
    assert.deepEqual(receipt.metadata, { snapshotId, snapshotHash, revisionId, ...profile, ...input, rendererId: renderer.id, rendererVersion: renderer.version });
    const bytes = await artifacts.read(receipt.artifactId);
    assert.ok(bytes);
    assert.equal(digest(bytes), receipt.contentHash);
    assert.equal(receipt.artifactId, `sha256:${receipt.contentHash}`);
    const file = join(output, name);
    await writeFile(file, bytes);
    return { file, bytes, receipt };
  }

  assert.deepEqual(await invoke<ProjectSnapshot>("project.snapshot.inspect", { snapshotId }), snapshot);
  const inspection = await invoke<SnapshotInspectionReport>("inspect.snapshot", { snapshotId });
  assert.deepEqual([inspection.snapshotId, inspection.snapshotHash, inspection.revisionId], [snapshotId, snapshotHash, revisionId]);
  assert.equal(inspection.outcome, "no-issues-detected", JSON.stringify(inspection.issues));
  assert.equal(inspection.coverage.mode, "all-frames");
  assert.deepEqual(inspection.coverage.checkedFrames, Array.from({ length: range.durationFrames }, (_, i) => range.startFrame + i));
  assert.ok(inspection.frames.every(frame => frame.sceneId === sceneId));
  evidence.inspection = inspection;

  const previews = [];
  for (const frame of workload.previews) {
    const name = `preview-${frame}.png`;
    const { file, bytes, receipt } = await preserve(name, { frame });
    const rgbaHash = await verifyDeliveryPreview(file, profile, AbortSignal.timeout(20_000));
    const { data } = PNG.sync.read(Buffer.from(bytes));
    const pinOffset = (motion.pivot[1] * width + motion.pivot[0]) * 4;
    assert.deepEqual([...data.subarray(pinOffset, pinOffset + 4)], [...workload.pinRgb, 255], "The suspension point must stay fixed");
    const observed = trackBob(data, 4, frame);
    within(observed.center, checkpoints.find(probe => probe.frame === frame)!.center, tolerances.pngPositionPx, `Preview ${frame}`);
    previews.push({ file: name, receipt, rgbaHash, ...observed });
  }
  evidence.previews = previews;

  const { file, receipt } = await preserve("pendulum.mp4", range);
  const media = await verifyDeliveryVideo(file, profile, range, false, AbortSignal.timeout(20_000));
  assert.equal(media.codec, "h264");
  assert.equal(media.audio, undefined);
  const frameBytes = crop.width * crop.height * 3;
  const { stdout: rgb } = await execute("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-i", file, "-map", "0:v:0",
    "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, "-fps_mode", "passthrough",
    "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { encoding: "buffer", timeout: 20_000, maxBuffer: range.durationFrames * frameBytes + 1024 });
  assert.equal(rgb.byteLength, frameBytes * range.durationFrames);

  const observations = Array.from({ length: range.durationFrames }, (_, i) => {
    const observed = trackBob(rgb.subarray(i * frameBytes, (i + 1) * frameBytes), 3, range.startFrame + i, true);
    const radiusErrorPx = Math.abs(Math.hypot(observed.center[0] - motion.pivot[0], observed.center[1] - motion.pivot[1]) - motion.radiusPx);
    assert.ok(radiusErrorPx <= tolerances.videoPositionPx, `Frame ${observed.frame} left the reference arc by ${radiusErrorPx.toFixed(3)} px`);
    return { ...observed, radiusErrorPx };
  });
  const at = (frame: number) => observations[frame - range.startFrame].center;
  const samples = checkpoints.map(({ frame, phase, center }) => {
    within(at(frame), center, tolerances.videoPositionPx, `Export ${phase} at ${frame}`);
    return { frame, phase, expected: center, observed: at(frame) };
  });
  const freeze = motion.releaseFrame + motion.cycleFrames * motion.cycles;
  for (const { frame, center } of observations.filter(item => item.frame <= motion.releaseFrame || item.frame >= freeze))
    within(center, checkpoints[0].center, tolerances.videoPositionPx, `Hold at ${frame}`);
  const crossings = workload.directionChecks.map(check => {
    const beforeX = at(check.beforeFrame)[0], afterX = at(check.afterFrame)[0], [pivotX] = motion.pivot;
    const side = check.direction === "right" ? 1 : -1;
    assert.ok(side * (pivotX - beforeX) >= tolerances.minCrossingOffsetPx && side * (afterX - pivotX) >= tolerances.minCrossingOffsetPx,
      `Frame ${check.crossingFrame} crossed in the wrong direction`);
    return { ...check, beforeX, afterX };
  });
  evidence.video = { file: "pendulum.mp4", receipt, media, checkedFrames: observations.length,
    maxRadiusErrorPx: Math.max(...observations.map(item => item.radiusErrorPx)), checkpoints: samples, crossings };
  assert.deepEqual(await invoke<ProjectSnapshot>("project.snapshot.inspect", { snapshotId }), snapshot);
  evidence.status = "passed";
  console.log(`Verified ${snapshotId}: ${previews.length} PNGs and ${media.frames} video frames. Arc, holds and all ${crossings.length} crossings matched.`);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n"); }
  finally { try { await host?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
