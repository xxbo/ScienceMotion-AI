import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { TimelinePatchOperation } from "../src/contracts/project-patch";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";

const output = resolve("out/timeline");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-timeline-"));
const directory = join(root, "workspace");
const store = new FileSystemArtifactStore(join(directory, "artifacts"));
const width = 320, height = 180, fps = 25, durationFrames = 20;
const projectId = "timeline-fixture";
const red = [212, 34, 48], green = [24, 176, 82], blue = [24, 72, 222];
const yellow = [236, 200, 24], white = [240, 240, 240], background = [7, 17, 31];
const editedSnapshot = "after-timeline-edit", originalSnapshot = "before-timeline-edit";
let host: CreativeHost | undefined, callNumber = 0;
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };

function png(color: number[], halfOverlay = false) {
  const image = new PNG({ width: 8, height: 4 });
  for (let i = 0; i < image.width * image.height; i++) {
    const alpha = halfOverlay ? (i % image.width < image.width / 2 ? 128 : 0) : 255;
    image.data.set([...color, alpha], i * 4);
  }
  return PNG.sync.write(image);
}

const actor = () => host!.createSession({ projectId,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.read", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.shape.create", "animation.keyframes.set",
    "assets.import", "timeline.edit", "project.snapshot.save", "render.preview", "render.video"] });
const call = (session: CreativeSession, toolId: string, input: unknown) =>
  session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "timeline-acceptance", callId: String(++callNumber) });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const result = await call(session, toolId, input);
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result.output as T;
}
async function reject(session: CreativeSession, toolId: string, input: unknown, message: RegExp) {
  const result = await call(session, toolId, input);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.diagnostics), message);
  assert.ok(!result.artifacts?.length);
}

type Probe = { x: number; y: number; color: number[] };
const mix = (base: number[]) => base.map((channel, index) => Math.round((127 * channel + 128 * yellow[index]) / 255));
function timelineProbes(frame: number): Probe[] {
  const color = frame < 3 ? background : frame < 9 ? green : frame < 17 ? red : frame < 19 ? blue : background;
  const probes = [{ x: 200, y: 30, color }, { x: 80, y: 30, color: frame === 8 || frame === 18 ? mix(color) : color }];
  if (frame >= 3 && frame < 9) {
    probes.push({ x: 192, y: 100, color: green }, { x: frame >= 7 ? 272 : 240, y: 100, color: white });
  }
  return probes;
}

function checkPixels(bytes: Buffer, channels: number, probes: Probe[], tolerance: number, frame: number) {
  return probes.map(({ x, y, color }) => {
    const offset = (y * width + x) * channels;
    const rgb = [...bytes.subarray(offset, offset + 3)];
    assert.ok(rgb.length === 3 && rgb.every((channel, index) => Math.abs(channel - color[index]) <= tolerance),
      `Frame ${frame} at (${x}, ${y}): expected RGB ${color}, received ${rgb}`);
    return { x, y, rgb };
  });
}

async function artifact(id: string, file: string) {
  const bytes = await store.read(id);
  assert.ok(bytes, "Render artifact must be readable");
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, id);
  await writeFile(join(output, file), bytes);
  return Buffer.from(bytes);
}
async function preview(session: CreativeSession, snapshotId: string, frame: number, file: string, probes: Probe[], sceneId?: string) {
  const { artifactId } = await invoke<{ artifactId: string }>(session, "render.preview",
    { snapshotId, frame, ...(sceneId ? { sceneId } : {}) });
  const decoded = PNG.sync.read(await artifact(artifactId, file));
  assert.deepEqual([decoded.width, decoded.height], [width, height]);
  return { frame, artifactId, file, samples: checkPixels(decoded.data, 4, probes, 1, frame) };
}
async function verifyVideo(artifactId: string, file: string, startFrame: number, frames: number) {
  await artifact(artifactId, file);
  const path = join(output, file);
  const { streams: [stream] } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,avg_frame_rate,duration", "-of", "json", path], { encoding: "utf8", timeout: 15_000 }));
  assert.deepEqual([stream.width, stream.height, stream.avg_frame_rate], [width, height, `${fps}/1`]);
  const seconds = Number(stream.duration);
  assert.ok(Math.abs(seconds - frames / fps) < 0.000001, `Expected duration ${frames / fps}, got ${stream.duration}`);
  const frameBytes = width * height * 3;
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-i", path, "-map", "0:v:0", "-threads", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: (frames + 1) * frameBytes, timeout: 15_000 });
  assert.equal(decoded.length, frames * frameBytes);
  const samples = Array.from({ length: frames }, (_, index) => {
    const frame = startFrame + index;
    return { frame, pixels: checkPixels(decoded.subarray(index * frameBytes, (index + 1) * frameBytes), 3, timelineProbes(frame), 8, frame) };
  });
  return { artifactId, file, startFrame, frames, fps, seconds, samples };
}

try {
  const approved = [
    { projectId, sourceId: "blue", path: join(root, "blue.png") },
    { projectId, sourceId: "yellow", path: join(root, "yellow.png") },
  ];
  await Promise.all([writeFile(approved[0].path, png(blue)), writeFile(approved[1].path, png(yellow, true))]);
  host = await openCreativeHost({ directory, assetImports: approved });
  const editor = actor();
  await invoke(editor, "project.create", { name: "Timeline cuts", episodeId: "timeline-fixture", durationFrames, width, height, fps });
  await invoke(editor, "project.scene.create", { sceneId: "red", name: "Red", startFrame: 0, durationFrames: 8 });
  await invoke(editor, "project.scene.create", { sceneId: "green", name: "Green", startFrame: 8, durationFrames: 10 });
  const rectangle = (sceneId: string, nodeId: string, fill: string, x: number, y: number, width: number, height: number) =>
    invoke(editor, "graphics.2d.shape.create", { sceneId, nodeId, primitive: "rect", fill, x, y, width, height });
  await rectangle("red", "red-background", "#d42230", 0, 0, width, height);
  await rectangle("green", "green-background", "#18b052", 0, 0, width, height);
  await rectangle("green", "source-marker", "#f0f0f0", 176, 84, 32, 32);
  await invoke(editor, "animation.keyframes.set", { trackId: "marker-motion", targetNodeId: "source-marker",
    targetProperty: "transform.position", keyframes: [
      { frame: 0, value: [176, 84, 0] },
      { frame: 3, value: [224, 84, 0], interpolation: "step" },
      { frame: 7, value: [256, 84, 0], interpolation: "step" },
    ] });
  await invoke(editor, "assets.import", { sourceId: "blue", assetId: "blue-still" });
  const original = await invoke<{ revisionId: string }>(editor, "assets.import", { sourceId: "yellow", assetId: "yellow-overlay" });
  const save = (snapshotId: string, revisionId: string) =>
    invoke<{ contentHash: string }>(editor, "project.snapshot.save", { snapshotId, revisionId });
  const before = await save(originalSnapshot, original.revisionId);
  const originalProbes = [{ x: 200, y: 30, color: green }, { x: 192, y: 100, color: white }];
  const oldPreview = await preview(editor, originalSnapshot, 8, "before-frame-08.png", originalProbes);
  const place = (trackId: string, id: string, assetId: string, startFrame: number, durationFrames: number): TimelinePatchOperation =>
    ({ op: "place-clip", trackId, clip: { id, assetId, startFrame, durationFrames } });
  const originalDocument = await invoke<ProjectDocument>(editor, "project.inspect", {});
  await reject(editor, "timeline.edit", { baseRevisionId: original.revisionId, edits: [
    place("plates", "rolled-back", "blue-still", 0, 2),
    { op: "move-shot", shotId: "shot-green", startFrame: 7 },
  ] }, /overlaps/);
  await reject(editor, "timeline.edit", { baseRevisionId: original.revisionId, edits: [
    { op: "trim-shot", shotId: "shot-green", inFrame: 5, durationFrames: 6 },
  ] }, /bounds/);
  await reject(editor, "timeline.edit", { baseRevisionId: original.revisionId, edits: [
    place("plates", "out-of-bounds", "blue-still", 19, 2),
  ] }, /bounds/);
  assert.deepEqual(await invoke(editor, "project.inspect", {}), originalDocument);

  const edit = await invoke<{ revisionId: string; shotIds: string[]; trackIds: string[]; changedClipIds: string[]; changedShotIds: string[] }>(editor,
    "timeline.edit", { baseRevisionId: original.revisionId, edits: [
      { op: "trim-shot", shotId: "shot-green", inFrame: 3, durationFrames: 6 },
      { op: "reorder-shots", shotIds: ["shot-green", "shot-red"], startFrame: 1 },
      { op: "move-shot", shotId: "shot-green", startFrame: 3 },
      { op: "move-shot", shotId: "shot-red", startFrame: 9 },
      place("plates", "blue-hold", "blue-still", 16, 2),
      place("plates", "blue-hold", "blue-still", 17, 2),
      place("accents", "over-scene", "yellow-overlay", 8, 1),
      place("accents", "over-clip", "yellow-overlay", 18, 1),
    ] });
  assert.deepEqual(edit.shotIds, ["shot-green", "shot-red"]);
  assert.deepEqual(edit.changedShotIds, edit.shotIds);
  assert.deepEqual(edit.trackIds, ["plates", "accents"]);
  assert.deepEqual(edit.changedClipIds, ["blue-hold", "over-scene", "over-clip"]);
  const editedDocument = await invoke<ProjectDocument>(editor, "project.inspect", {});
  assert.equal(editedDocument.sequences[0].durationFrames, durationFrames);
  await reject(editor, "timeline.edit", { baseRevisionId: edit.revisionId,
    edits: [place("plates", "overlap", "yellow-overlay", 18, 1)] }, /overlaps/);
  await reject(editor, "timeline.edit", { baseRevisionId: original.revisionId,
    edits: [{ op: "move-shot", shotId: "shot-red", startFrame: 10 }] }, /Revision conflict/);
  assert.deepEqual(await invoke(editor, "project.inspect", {}), editedDocument);

  const after = await save(editedSnapshot, edit.revisionId);
  assert.notEqual(after.contentHash, before.contentHash);
  const previews = [];
  for (const frame of [2, 3, 8, 9, 16, 17, 18, 19]) {
    previews.push(await preview(editor, editedSnapshot, frame, `after-frame-${String(frame).padStart(2, "0")}.png`, timelineProbes(frame)));
  }
  const scenePreview = await preview(editor, editedSnapshot, 0, "green-source-frame-00.png", originalProbes, "green");
  assert.equal(scenePreview.artifactId, oldPreview.artifactId);
  const range = await invoke<{ artifactId: string }>(editor, "render.video", { snapshotId: editedSnapshot, startFrame: 8, durationFrames: 3 });
  const subrangeExport = await verifyVideo(range.artifactId, "cut-subrange.mp4", 8, 3);

  await host.close();
  await Promise.all(approved.map(source => rm(source.path)));
  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = actor();
  const recovered = await preview(reopened, originalSnapshot, 8, "reopened-before-frame-08.png", originalProbes);
  assert.equal(recovered.artifactId, oldPreview.artifactId);
  const { record: admitted } = await reopened.jobs.submit({
    toolId: "render.video", input: { snapshotId: editedSnapshot, startFrame: 0, durationFrames },
    toolVersion: "1.0.0", runId: "timeline-reopen", callId: "full-video", submissionId: "full-video",
  });
  const deadline = Date.now() + 60_000;
  let job = admitted;
  while (["queued", "running", "stopping", "publishing"].includes(job.state)) {
    assert.ok(Date.now() < deadline, "Timeline export job must settle");
    await new Promise(resolve => setTimeout(resolve, 50));
    job = (await reopened.jobs.get(admitted.id))!;
  }
  assert.equal(job.state, "succeeded", JSON.stringify(job.diagnostic));
  assert.deepEqual(job.input.snapshot, { id: editedSnapshot, revisionId: edit.revisionId, contentHash: after.contentHash });
  assert.ok(job.result);
  const fullExport = await verifyVideo(job.result.artifactId, "edited-timeline.mp4", 0, durationFrames);
  Object.assign(evidence, { status: "passed", projectId, original: { snapshotId: originalSnapshot, ...before, preview: oldPreview, recovered },
    edited: { snapshotId: editedSnapshot, ...after, ...edit, shots: editedDocument.shots, tracks: editedDocument.tracks, clips: editedDocument.clips },
    cutFrame: 9, previews, scenePreview, subrangeExport, fullExport: { ...fullExport, jobId: job.id }, sourcesRemovedBeforeReopen: true,
    rejectedAtomically: ["shot-overlap", "clip-overlap", "source-bounds", "sequence-bounds", "stale-revision"] });
  console.log("PASS: timeline edits, adjacent cut, source trim, PNG layers, gaps and every frame of the exported MP4");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
