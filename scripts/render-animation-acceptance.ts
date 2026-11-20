import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { SnapshotLayoutInspectionReport } from "../src/contracts/layout-inspection";
import type { ProjectDocument } from "../src/contracts/project";
import type { TimelinePatchOperation } from "../src/contracts/project-patch";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import type { KeyframeEdit } from "../src/platform/keyframe-edits";
import type { ProjectSnapshot } from "../src/platform/project-snapshots";

const width = 320, height = 180, fps = 25, durationFrames = 32;
const cut = 16, fadeFrames = 5, red = [212, 34, 48], green = [24, 176, 82];
const white = [240, 240, 240], yellow = [232, 188, 58], blue = [20, 70, 230], canvas = [7, 17, 31];
const output = resolve("out/animation");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-animation-"));
const directory = join(root, "workspace"), store = new FileSystemArtifactStore(join(directory, "artifacts"));
const projectId = "animation-fixture", sourcePath = join(root, "corner.png");
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };
let host: CreativeHost | undefined, callCount = 0;

const actor = () => host!.createSession({ projectId, permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "project.snapshot.save", "project.snapshot.inspect",
    "graphics.2d.shape.create", "animation.keyframes.set", "animation.keyframes.edit", "assets.import", "timeline.edit",
    "inspect.layout", "render.preview", "render.video"] });
const call = (session: CreativeSession, toolId: string, input: unknown) =>
  session.invoke({ runId: "animation-acceptance", callId: String(++callCount), toolVersion: "1.0.0", toolId, input });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const result = await call(session, toolId, input);
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}
async function rejectUnchanged(session: CreativeSession, toolId: string, input: unknown, expected: RegExp, before: ProjectDocument) {
  const result = await call(session, toolId, input);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.diagnostics), expected);
  assert.deepEqual(await invoke(session, "project.inspect", {}), before);
}

type Probe = [x: number, y: number, color: number[]];
const blend = (from: number[], to: number[], progress: number) =>
  from.map((channel, index) => Math.round((1 - progress) * channel + progress * to[index]));
function expectedAt(frame: number): Probe[] {
  const progress = Math.max(0, Math.min(1, (frame - cut) / (fadeFrames - 1)));
  const color = frame < 26 ? blend(red, green, progress) : canvas;
  const probes: Probe[] = [[30, 30, color], [288, 16, frame === 17 || frame === 18 ? blue : color]];
  if (frame === 4) probes.push([86, 86, white], [112, 86, red]); // CSS ease-in gives x ≈ 74.46, linear gives 104.
  if (frame === 10 || frame === 11) probes.push([192, 86, white], [216, 86, red]);
  if (frame === 12 || frame === 14) probes.push([192, 86, red], [216, 86, white]);
  if (frame >= 15 && frame <= 20) probes.push([252, 86, blend(white, green, progress)]);
  if (frame === 17) probes.push([76, 126, blend(red, yellow, progress)]);
  if (frame === 18 || frame === 19) probes.push([172, 126, blend(red, yellow, progress)]);
  if (frame >= 20 && frame < 26) probes.push([236, 126, yellow]);
  return probes;
}
function pixels(bytes: Buffer, channels: number, probes: Probe[], tolerance: number, frame: number) {
  return probes.map(([x, y, expected]) => {
    const offset = (y * width + x) * channels;
    const rgb = [...bytes.subarray(offset, offset + 3)];
    assert.ok(rgb.length === 3 && rgb.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance),
      `Frame ${frame} at (${x}, ${y}): expected ${expected}, got ${rgb}`);
    return { x, y, rgb };
  });
}
async function artifact(id: string, file: string) {
  const data = await store.read(id);
  assert.ok(data);
  assert.equal(`sha256:${createHash("sha256").update(data).digest("hex")}`, id);
  await writeFile(join(output, file), data);
  return Buffer.from(data);
}
async function preview(session: CreativeSession, snapshotId: string, frame: number, file: string, probes: Probe[], sceneId?: string) {
  const { artifactId } = await invoke<{ artifactId: string }>(session, "render.preview", { snapshotId, frame, ...(sceneId ? { sceneId } : {}) });
  const png = PNG.sync.read(await artifact(artifactId, file));
  assert.deepEqual([png.width, png.height], [width, height]);
  return { file, artifactId, frame, pixels: pixels(png.data, 4, probes, 2, frame) };
}
const snapshot = (session: CreativeSession, snapshotId: string, revisionId: string) =>
  invoke<Omit<ProjectSnapshot, "document">>(session, "project.snapshot.save", { snapshotId, revisionId });
const crossfade = { op: "set-transition", fromShotId: "shot-red", toShotId: "shot-green", transition: { type: "crossfade", durationFrames: fadeFrames } } as const;

try {
  const corner = new PNG({ width: 8, height: 8 });
  for (let y = 0; y < 2; y++) for (let x = 6; x < 8; x++) corner.data.set([...blue, 255], (y * 8 + x) * 4);
  await writeFile(sourcePath, PNG.sync.write(corner));
  host = await openCreativeHost({ directory, assetImports: [{ projectId, sourceId: "corner", path: sourcePath }] });
  const editor = actor();
  await invoke(editor, "project.create", { name: "Keyframes and crossfade", episodeId: "animation-fixture", durationFrames, width, height, fps });
  await invoke(editor, "project.scene.create", { sceneId: "red", name: "Red", startFrame: 0, durationFrames: 18 });
  await invoke(editor, "project.scene.create", { sceneId: "green", name: "Green", startFrame: 18, durationFrames: 12 });
  const shape = (sceneId: string, nodeId: string, fill: string, x: number, y: number, width: number, height: number) =>
    invoke(editor, "graphics.2d.shape.create", { sceneId, nodeId, primitive: "rect", x, y, width, height, fill });
  await shape("red", "red-background", "#d42230", 0, 0, width, height);
  await shape("red", "red-marker", "#f0f0f0", 24, 76, 24, 20);
  await shape("green", "green-background", "#18b052", 0, 0, width, height);
  await shape("green", "green-marker", "#e8bc3a", 64, 116, 24, 20);
  await invoke(editor, "animation.keyframes.set", { trackId: "red-motion", targetNodeId: "red-marker", targetProperty: "transform.position", keyframes: [
    { frame: 0, value: [24, 76, 0] }, { frame: 6, value: [140, 76, 0], interpolation: "step" },
    { frame: 14, value: [184, 76, 0] }, { frame: 17, value: [240, 76, 0], interpolation: "step" },
  ] });
  await invoke(editor, "animation.keyframes.set", { trackId: "green-motion", targetNodeId: "green-marker", targetProperty: "transform.position", keyframes: [
    { frame: 1, value: [64, 116, 0] }, { frame: 3, value: [160, 116, 0], interpolation: "step" },
    { frame: 5, value: [224, 116, 0], interpolation: "step" },
  ] });
  const imported = await invoke<{ revisionId: string }>(editor, "assets.import", { sourceId: "corner", assetId: "corner" });
  const timeline = (baseRevisionId: string, edits: TimelinePatchOperation[]) => ({ baseRevisionId, edits });
  const prepared = await invoke<{ revisionId: string }>(editor, "timeline.edit", timeline(imported.revisionId, [
    { op: "trim-shot", shotId: "shot-red", inFrame: 2, durationFrames: cut },
    { op: "trim-shot", shotId: "shot-green", inFrame: 1, durationFrames: 10 },
    { op: "move-shot", shotId: "shot-green", startFrame: cut },
    { op: "place-clip", trackId: "overlay", clip: { id: "corner-overlay", assetId: "corner", startFrame: 17, durationFrames: 2 } },
  ]));
  const initial = await invoke<ProjectDocument>(editor, "project.inspect", {});
  const before = await snapshot(editor, "animation-before", prepared.revisionId);
  const oldMotion = await preview(editor, before.id, 4, "before-motion.png", [[86, 86, red], [150, 86, white]]);
  const oldCut = await preview(editor, before.id, cut, "before-cut.png", [[30, 30, green], [252, 86, green]]);

  const keyEdits: KeyframeEdit[] = [
    { op: "remove", trackId: "red-motion", frame: 6 },
    { op: "update", trackId: "red-motion", frame: 14, changes: { frame: 12, interpolation: "bezier", easing: "ease-in" } },
    { op: "insert", trackId: "red-motion", keyframe: { frame: 14, value: [200, 76, 0], interpolation: "step" } },
  ];
  const keys = (edits: KeyframeEdit[]) => ({ baseRevisionId: prepared.revisionId, edits });
  await rejectUnchanged(editor, "animation.keyframes.edit", keys([keyEdits[0],
    { op: "update", trackId: "red-motion", frame: 14, changes: { frame: 17 } },
  ]), /already has a key/, initial);
  await rejectUnchanged(editor, "animation.keyframes.edit", keys([
    { op: "update", trackId: "red-motion", frame: 14, changes: { easing: "cubic-bezier(2,0,1,1)" } },
  ]), /Invalid cubic-bezier/, initial);
  await rejectUnchanged(editor, "animation.keyframes.edit", keys([
    { op: "update", trackId: "red-motion", frame: 17, changes: { frame: 19 } },
  ]), /exceeds scene duration/, initial);
  const edited = await invoke<{ revisionId: string; changedAnimationTrackIds: string[] }>(editor, "animation.keyframes.edit", keys(keyEdits));
  assert.deepEqual(edited.changedAnimationTrackIds, ["red-motion"]);
  const animated = await invoke<ProjectDocument>(editor, "project.inspect", {});
  assert.deepEqual(animated.animationTracks[0].keyframes.map(key => key.frame), [0, 12, 14, 17]);
  assert.deepEqual(animated.animationTracks[1], initial.animationTracks[1]);
  await rejectUnchanged(editor, "animation.keyframes.edit", keys(keyEdits), /Revision conflict/, animated);
  await rejectUnchanged(editor, "timeline.edit", timeline(edited.revisionId, [
    { op: "move-shot", shotId: "shot-green", startFrame: 17 }, crossfade,
  ]), /requires adjacent shots/, animated);
  await rejectUnchanged(editor, "timeline.edit", timeline(edited.revisionId, [
    { ...crossfade, transition: { type: "crossfade", durationFrames: 11 } },
  ]), /Crossfade duration/, animated);
  const afterEdit = await invoke<{ revisionId: string; durationFrames: number; changedShotIds: string[] }>(
    editor, "timeline.edit", timeline(edited.revisionId, [crossfade]));
  assert.equal(afterEdit.durationFrames, durationFrames);
  assert.deepEqual(afterEdit.changedShotIds, ["shot-red", "shot-green"]);
  const after = await snapshot(editor, "animation-after", afterEdit.revisionId);
  const previews = [];
  for (const frame of [4, 10, 11, 12, 15, 16, 17, 18, 19, 20, 21, 26]) {
    previews.push(await preview(editor, after.id, frame, `after-${String(frame).padStart(2, "0")}.png`, expectedAt(frame)));
  }
  assert.equal(previews.find(item => item.frame === 15)?.artifactId, previews.find(item => item.frame === 16)?.artifactId);
  const scene = await preview(editor, after.id, 3, "incoming-source-frame.png", [[30, 30, green], [172, 126, yellow]], "green");
  const layout = await invoke<SnapshotLayoutInspectionReport>(editor, "inspect.layout", { snapshotId: after.id, frames: [15, 16, 18, 20] });
  assert.deepEqual(layout.frames.map(frame => frame.nodes.map(node => node.nodeId)),
    [["red-background", "red-marker"], ...Array.from({ length: 3 }, () => ["green-background", "green-marker"])]);

  await host.close();
  await rm(sourcePath);
  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = actor();
  const retained = await invoke<ProjectSnapshot>(reopened, "project.snapshot.inspect", { snapshotId: before.id });
  assert.deepEqual(retained.document, initial);
  const recovered = await preview(reopened, before.id, cut, "reopened-before-cut.png", [[30, 30, green], [252, 86, green]]);
  assert.equal(recovered.artifactId, oldCut.artifactId);
  const video = await invoke<{ artifactId: string }>(reopened, "render.video", { snapshotId: after.id, startFrame: 0, durationFrames });
  const file = "animation-crossfade.mp4", path = join(output, file);
  await artifact(video.artifactId, file);
  const { streams: [stream] } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,avg_frame_rate,duration", "-of", "json", path], { encoding: "utf8", timeout: 15_000 }));
  assert.deepEqual([stream.width, stream.height, stream.avg_frame_rate, Number(stream.duration)], [width, height, `${fps}/1`, durationFrames / fps]);
  const frameBytes = width * height * 3;
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-i", path, "-map", "0:v:0", "-threads", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: (durationFrames + 1) * frameBytes, timeout: 15_000 });
  assert.equal(decoded.length, durationFrames * frameBytes);
  const frames = Array.from({ length: durationFrames }, (_, frame) => ({ frame,
    pixels: pixels(decoded.subarray(frame * frameBytes, (frame + 1) * frameBytes), 3, expectedAt(frame), 10, frame) }));
  Object.assign(evidence, { status: "passed", width, height, cut, fadeFrames, editedKeyframes: animated.animationTracks[0].keyframes,
    before: { snapshot: before, oldMotion, oldCut, recovered }, after: { snapshot: after, previews, scene, inspectedFrames: layout.coverage.checkedFrames },
    video: { ...video, file, durationFrames, fps, seconds: Number(stream.duration), frames } });
  console.log("PASS: retimed and eased keyframes, step and crossfade boundaries, overlay order, old snapshot and decoded MP4");
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
