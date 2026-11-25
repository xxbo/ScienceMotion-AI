import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativeJobSubmission } from "../src/contracts/creative-jobs";
import type { SnapshotInspectionReport, TimelineInspectionReport } from "../src/contracts/inspection";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyDeliveryPreview, verifyDeliveryVideo } from "../src/platform/creative-delivery-media";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { SvgFfmpegProjectGraphRenderer } from "../src/renderers/svg-ffmpeg/svg-ffmpeg-project-graph-renderer";
import type { WaterMotionBaseline } from "./fixtures/water-motion-baseline";

const fixture = JSON.parse(await readFile("examples/water-motion-baseline.json", "utf8")) as WaterMotionBaseline;
const { snapshot, workload } = fixture;
const { projectId, id: snapshotId, contentHash, document } = snapshot;
const { width, height, fps, durationFrames, shotIds } = document.sequences[0];
const { previewFrame, video: range, markerSamples, swatches, markerRgb, videoColorTolerance } = workload;
const expectedSnapshot = { id: snapshotId, revisionId: document.revisions.at(-1)!.id, contentHash };
const profile = { width, height, fps };
const renderer = new SvgFfmpegProjectGraphRenderer();
const identity = { id: renderer.id, version: renderer.version };
const output = resolve("out/svg-ffmpeg-renderer");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-svg-acceptance-"));
const artifacts = new FileSystemArtifactStore(join(root, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(root, "references"));
const runId = "p1-5-c-shared-water-motion";
const evidence: Record<string, unknown> = {
  schemaVersion: "1.0.0", status: "running", snapshot: expectedSnapshot, profile, renderer: identity,
};
let host: CreativeHost | undefined, calls = 0;

async function invoke(session: CreativeSession, toolId: string, input: unknown = {}) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest);
  return session.invoke({ toolId, toolVersion: manifest.version, input, runId, callId: `call-${++calls}` });
}
async function ok<T>(session: CreativeSession, toolId: string, input?: unknown) {
  const result = await invoke(session, toolId, input);
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}
type JobRequest = CreativeJobSubmission extends infer T ? T extends CreativeJobSubmission ? Pick<T, "toolId" | "input"> : never : never;
async function job(session: CreativeSession, label: string, request: JobRequest) {
  const manifest = await session.manifest(request.toolId);
  assert.ok(manifest);
  const { record, created } = await session.jobs.submit({ ...request, runId, submissionId: label, callId: label, toolVersion: manifest.version });
  assert.ok(created);
  const deadline = AbortSignal.timeout(35_000);
  for (;;) {
    const current = await session.jobs.get(record.id);
    assert.ok(current);
    if (!["queued", "running", "stopping", "publishing"].includes(current.state)) return current;
    await delay(25, undefined, { signal: deadline });
  }
}
async function preserve(job: RenderJobRecord, render: RenderJobRecord["input"]["render"], name: string) {
  assert.equal(job.state, "succeeded", JSON.stringify(job.diagnostic));
  assert.deepEqual(job.input.snapshot, expectedSnapshot);
  assert.deepEqual(job.input.profile, profile);
  assert.deepEqual(job.input.renderer, identity);
  assert.deepEqual(job.input.render, render);
  assert.ok(job.result);
  assert.equal(job.result.inputHash, job.inputHash);
  assert.equal(job.result.rendererId, identity.id);
  assert.equal(job.result.rendererVersion, identity.version);
  const bytes = await readVerifiedJobArtifact(artifacts, job.result);
  assert.ok(bytes);
  const retention = await host!.maintenance.renderJobs.inspect(projectId, job.id);
  assert.ok(retention && "output" in retention && retention.output?.availability === "verified" && retention.output.referenceAttached);
  const file = join(output, name);
  await writeFile(file, bytes);
  return { file, bytes, receipt: job.result };
}

function checkFrame(data: Uint8Array, channels: 3 | 4, frame: number) {
  const marker = markerSamples.find(point => point.frame === frame);
  const background = swatches.find(point => point.name === "background");
  assert.ok(marker && background);
  const points = [...swatches, { ...marker, name: "marker", rgb: markerRgb },
    ...markerSamples.filter(point => point.frame !== frame).map(point => ({ ...point, name: "absent marker", rgb: background.rgb }))];
  const tolerance = channels === 3 ? videoColorTolerance : 0;
  return points.map(({ name, x, y, rgb }) => {
    const start = (y * width + x) * channels;
    const actual = [...data.subarray(start, start + channels)];
    const expected = channels === 4 ? [...rgb, 255] : rgb;
    assert.equal(actual.length, channels);
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance),
      `Frame ${frame} ${name} at (${x}, ${y}) was ${actual}, expected ${expected} ± ${tolerance}`);
    return { frame, name, x, y, expected, actual, tolerance };
  });
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.ffmpeg = execFileSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 10_000 }).split("\n")[0];
  assert.equal(hashProject(document), contentHash);
  // A trusted fixture import preserves the original receipt instead of creating an edited lookalike.
  const workspace = await FileSystemProjectWorkspace.open(join(root, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  try {
    await workspace.create(document);
    assert.deepEqual(await workspace.saveSnapshot(projectId, expectedSnapshot.revisionId, { id: snapshotId, createdAt: snapshot.createdAt }), snapshot);
  } finally { await workspace.close(); }
  host = await openCreativeHost({ directory: root, renderer });
  const session = host.createSession({ projectId, permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.write"],
    toolIds: ["project.inspect", "project.snapshot.save", "project.snapshot.inspect", "inspect.snapshot", "inspect.timeline", "inspect.layout",
      "graphics.2d.text.create", "render.preview", "render.video"] });
  assert.deepEqual(await ok<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId }), snapshot);
  const [model, timeline] = await Promise.all([
    ok<SnapshotInspectionReport>(session, "inspect.snapshot", { snapshotId, frames: markerSamples.map(item => item.frame) }),
    ok<TimelineInspectionReport>(session, "inspect.timeline", { snapshotId, range }),
  ]);
  for (const report of [model, timeline]) {
    assert.deepEqual({ id: report.snapshotId, revisionId: report.revisionId, contentHash: report.snapshotHash }, expectedSnapshot);
    assert.equal(report.outcome, "no-issues-detected");
  }
  assert.deepEqual(model.coverage.checkedFrames, markerSamples.map(item => item.frame));
  assert.ok(model.frames.every(frame => frame.sceneId === fixture.source.sceneId && frame.projectedElements === document.nodes.length));
  assert.equal(timeline.sequenceFrames, durationFrames);
  const clipped = { startFrame: range.startFrame, endFrame: range.startFrame + range.durationFrames };
  assert.deepEqual(timeline.range, clipped);
  assert.deepEqual(timeline.intervals, [{ kind: "shot", sceneId: fixture.source.sceneId, shotId: shotIds[0],
    ...clipped, sourceStartFrame: range.startFrame }]);
  const layout = await invoke(session, "inspect.layout", { snapshotId, frames: [previewFrame] });
  assert.equal(layout.ok, false);
  assert.equal(layout.diagnostics[0]?.code, "HOST_LAYOUT_UNAVAILABLE");
  evidence.inspection = { model, timeline, layout: layout.diagnostics };

  const previewJob = await job(session, "preview", { toolId: "render.preview", input: { snapshotId, frame: previewFrame } });
  const preview = await preserve(previewJob, { operation: "preview", frame: previewFrame }, "preview.png");
  const videoJob = await job(session, "export", { toolId: "render.video", input: { snapshotId, ...range } });
  const video = await preserve(videoJob, { operation: "video", ...range }, "export.mp4");
  const decode = AbortSignal.timeout(20_000);
  const [rgbaHash, videoMedia] = await Promise.all([
    verifyDeliveryPreview(preview.file, profile, decode), verifyDeliveryVideo(video.file, profile, range, false, decode),
  ]);
  assert.equal(videoMedia.codec, "h264");
  assert.equal(videoMedia.audio, undefined);
  const png = PNG.sync.read(Buffer.from(preview.bytes));
  assert.deepEqual([png.width, png.height], [width, height]);
  const previewPixels = checkFrame(png.data, 4, previewFrame);
  const select = markerSamples.map(({ frame }) => `eq(n\\,${frame - range.startFrame})`).join("+");
  const frameBytes = width * height * 3;
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-i", video.file,
    "-vf", "select=" + select, "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { timeout: 10_000, maxBuffer: markerSamples.length * frameBytes + 1024 });
  assert.equal(rgb.byteLength, frameBytes * markerSamples.length);
  const videoPixels = markerSamples.flatMap(({ frame }, i) => checkFrame(rgb.subarray(i * frameBytes, (i + 1) * frameBytes), 3, frame));
  evidence.preview = { job: previewJob, file: "preview.png", rgbaHash, pixels: previewPixels };
  evidence.video = { job: videoJob, file: "export.mp4", media: videoMedia, pixels: videoPixels };

  const added = await ok<{ revisionId: string }>(session, "graphics.2d.text.create",
    { sceneId: fixture.source.sceneId, nodeId: "unsupported-title", x: 20, y: 20, text: "Requires text layout" });
  const candidate = await ok<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId: "with-text", revisionId: added.revisionId });
  const before = await artifacts.list();
  const failure = await invoke(session, "render.preview", { snapshotId: candidate.id, frame: previewFrame });
  assert.equal(failure.ok, false);
  assert.equal(failure.artifacts?.length ?? 0, 0);
  assert.equal(failure.metadata?.outcomeUnknown, undefined);
  const rejected = await job(session, "unsupported-export", { toolId: "render.video", input: { snapshotId: candidate.id, ...range } });
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.outcomeUnknown, false);
  assert.equal(rejected.publicationStartedAt, undefined);
  assert.equal(rejected.result, undefined);
  assert.deepEqual(rejected.input.snapshot, { id: candidate.id, revisionId: added.revisionId, contentHash: candidate.contentHash });
  for (const diagnostic of [failure.diagnostics[0], rejected.diagnostic]) {
    assert.equal(diagnostic?.code, "SVG_FFMPEG_UNSUPPORTED");
    assert.match(diagnostic.message, /unsupported-title.*type text/);
  }
  assert.deepEqual(await artifacts.list(), before);
  const head = await ok<ProjectDocument>(session, "project.inspect");
  assert.equal(head.revisions.at(-1)?.id, added.revisionId);
  assert.equal(hashProject(head), candidate.contentHash);
  assert.deepEqual(await ok<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId }), snapshot);
  const repeated = await ok<{ artifactId: string; contentHash: string; metadata: Record<string, unknown> }>(
    session, "render.preview", { snapshotId, frame: previewFrame });
  assert.equal(repeated.artifactId, preview.receipt.artifactId);
  assert.equal(repeated.contentHash, preview.receipt.contentHash);
  assert.deepEqual(repeated.metadata, { snapshotId, revisionId: expectedSnapshot.revisionId, snapshotHash: contentHash, frame: previewFrame,
    ...profile, rendererId: identity.id, rendererVersion: identity.version });
  evidence.rejection = { candidate, foreground: failure.diagnostics, job: rejected, unchangedArtifactCount: before.length, repeatedPreview: repeated };
  evidence.status = "passed";
  console.log(`Verified ${identity.id} on ${snapshotId}: PNG frame ${previewFrame}, ${videoMedia.frames} H.264 frames, and no output for unsupported text.`);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  } finally {
    try { await host?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
