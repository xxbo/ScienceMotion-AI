import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import type { GraphicsEdit } from "../src/platform/graphics-edits";
import type { ProjectSnapshot } from "../src/platform/project-snapshots";

const directory = await mkdtemp(join(tmpdir(), "sciencemotion-graphics-edit-"));
const output = resolve("out/graphics-edit");
await mkdir(output, { recursive: true });
const store = new FileSystemArtifactStore(join(directory, "artifacts"));
const width = 640, height = 360, fps = 25, durationFrames = 8;
const background = [7, 17, 31], red = [237, 91, 102], green = [63, 191, 155], blue = [85, 150, 234];
const violet = [172, 114, 237], yellow = [243, 212, 106], cyan = [85, 214, 232], orange = [243, 173, 89];
const probes = [
  { area: "shape corner", x: 40, y: 55, before: red, after: background },
  { area: "shape fill", x: 120, y: 94, before: red, after: green },
  { area: "shape extension", x: 180, y: 94, before: background, after: green },
  { area: "path hole", x: 120, y: 238, before: blue, after: background },
  { area: "path extension", x: 180, y: 238, before: background, after: violet },
  { area: "path stroke", x: 60, y: 200, before: blue, after: yellow },
  { area: "first bar becomes zero", x: 426, y: 132, before: cyan, after: background },
  { area: "second bar grows", x: 502, y: 120, before: background, after: orange },
  { area: "chart fill", x: 568, y: 215, before: cyan, after: orange },
];
const zones = [
  { name: "shape", left: 32, top: 48, right: 208, bottom: 140 },
  { name: "path", left: 40, top: 192, right: 240, bottom: 286 },
  { name: "chart", left: 316, top: 46, right: 620, bottom: 302 },
];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };
let host: CreativeHost | undefined, callCount = 0;
const actor = () => host!.createSession({ projectId: "graphics-edit-fixture", allowDestructive: true,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "snapshot.restore", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "project.snapshot.save", "project.snapshot.inspect",
    "project.snapshot.restore", "graphics.2d.shape.create", "graphics.2d.path.create", "graphics.2d.chart.create",
    "graphics.2d.edit", "render.preview", "render.video"] });
const call = (session: CreativeSession, toolId: string, input: unknown) =>
  session.invoke({ runId: "graphics-edit-acceptance", callId: String(++callCount), toolVersion: "1.0.0", toolId, input });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const result = await call(session, toolId, input);
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function writeArtifact(artifactId: string, file: string) {
  const data = await store.read(artifactId);
  assert.ok(data);
  assert.equal(`sha256:${createHash("sha256").update(data).digest("hex")}`, artifactId);
  await writeFile(join(output, file), data);
  return Buffer.from(data);
}
async function snapshot(session: CreativeSession, snapshotId: string, revisionId: string) {
  return invoke<Omit<ProjectSnapshot, "document">>(session, "project.snapshot.save", { snapshotId, revisionId });
}
async function renderPreview(session: CreativeSession, snapshotId: string, file: string) {
  const { artifactId } = await invoke<{ artifactId: string }>(session, "render.preview", { snapshotId, frame: 0 });
  const decoded = PNG.sync.read(await writeArtifact(artifactId, file));
  assert.deepEqual([decoded.width, decoded.height], [width, height]);
  return { artifactId, file, pixels: decoded.data };
}

function checkPixels(pixels: Buffer, channels: number, stage: "before" | "after", tolerance: number) {
  return probes.map(probe => {
    const offset = (probe.y * width + probe.x) * channels;
    const rgb = [...pixels.subarray(offset, offset + 3)];
    assert.ok(rgb.length === 3 && rgb.every((channel, index) => Math.abs(channel - probe[stage][index]) <= tolerance),
      `${probe.area} ${stage} at (${probe.x}, ${probe.y}): expected RGB ${probe[stage]}, got ${rgb}`);
    return { area: probe.area, x: probe.x, y: probe.y, rgb };
  });
}
function changedPixels(before: Buffer, after: Buffer) {
  const counts = Object.fromEntries(zones.map(zone => [zone.name, 0]));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (before.readUInt32LE(offset) === after.readUInt32LE(offset)) continue;
      const zone = zones.find(item => x >= item.left && x < item.right && y >= item.top && y < item.bottom);
      assert.ok(zone, `Pixel outside the edited regions changed at (${x}, ${y})`);
      counts[zone.name]++;
    }
  }
  assert.ok(Object.values(counts).every(count => count > 1000));
  return counts;
}

try {
  host = await openCreativeHost({ directory });
  const editor = actor(), sceneId = "graphics";
  await invoke(editor, "project.create", { name: "2D graphics edits", episodeId: "graphics-fixture", width, height, fps, durationFrames });
  await invoke(editor, "project.scene.create", { sceneId, name: "Editable graphics", durationFrames });
  await invoke(editor, "graphics.2d.shape.create", { sceneId, nodeId: "shape", primitive: "rect", x: 32, y: 48, width: 120, height: 72, fill: "#ed5b66" });
  await invoke(editor, "graphics.2d.path.create", { sceneId, nodeId: "path", x: 32, y: 184, width: 216, height: 112,
    pathData: "M 16 16 H 144 V 94 H 16 Z", fill: "#5596ea" });
  await invoke(editor, "graphics.2d.chart.create", { sceneId, nodeId: "bars", x: 316, y: 46, width: 304, height: 256, chartType: "bar",
    data: [{ label: "A", value: 6 }, { label: "B", value: 3 }, { label: "C", value: 2 }], fill: "#55d6e8" });
  const control = await invoke<{ revisionId: string }>(editor, "graphics.2d.shape.create", {
    sceneId, nodeId: "control", primitive: "rect", x: 32, y: 310, width: 216, height: 18, fill: "#8d9cb2", radius: 4,
  });
  const before = await snapshot(editor, "graphics-before", control.revisionId);
  const original = await invoke<ProjectDocument>(editor, "project.inspect", {});
  const { pixels: beforePixels, ...beforePreview } = await renderPreview(editor, before.id, "graphics-before.png");
  const beforeSamples = checkPixels(beforePixels, 4, "before", 0);

  const edits: GraphicsEdit[] = [
    { kind: "shape", nodeId: "shape", changes: { primitive: "ellipse", width: 176, height: 92, fill: "#3fbf9b", stroke: "#f3d46a", strokeWidth: 5 } },
    { kind: "path", nodeId: "path", changes: { pathData: "M 16 16 H 200 V 94 H 16 Z M 64 38 H 128 V 72 H 64 Z",
      fillRule: "evenodd", fill: "#ac72ed", stroke: "#f3d46a", strokeWidth: 8 } },
    { kind: "chart", nodeId: "bars", changes: { data: [{ label: "A", value: 0 }, { label: "B", value: 6 }, { label: "C", value: 2 }],
      fill: "#f3ad59", stroke: "#3fbf9b", labelColor: "#f0e4bc", fontSize: 18 } },
  ];
  const invalidBatches = [
    { claim: "incomplete-path", edits: [edits[0], { ...edits[1], changes: { pathData: "M 16 16 L 200" } }], diagnostic: /Invalid SVG path data/ },
    { claim: "invalid-chart-label", edits: [edits[0], { ...edits[2], changes: { data: [{ label: " ", value: 1 }, { label: "B", value: 2 }] } }],
      diagnostic: /labelled finite data points/ },
    { claim: "wrong-node-kind", edits: [{ ...edits[0], nodeId: "bars" }], diagnostic: /has kind chart, expected shape/ },
    { claim: "invalid-dimension", edits: [{ ...edits[0], changes: { width: 0 } }], diagnostic: /TOOL_INPUT_INVALID/ },
    { claim: "unsupported-paint", edits: [{ ...edits[0], changes: { fill: "rgb(0, 0, 0)" } }], diagnostic: /Unsupported fill color/ },
  ];
  for (const batch of invalidBatches) {
    const result = await call(editor, "graphics.2d.edit", { baseRevisionId: control.revisionId, edits: batch.edits });
    assert.equal(result.ok, false, batch.claim);
    assert.match(JSON.stringify(result.diagnostics), batch.diagnostic);
    assert.deepEqual(await invoke<ProjectDocument>(editor, "project.inspect", {}), original);
  }

  const updated = await invoke<{ revisionId: string; changedNodeIds: string[] }>(editor, "graphics.2d.edit", { baseRevisionId: control.revisionId, edits });
  assert.deepEqual(updated.changedNodeIds, ["shape", "path", "bars"]);
  const edited = await invoke<ProjectDocument>(editor, "project.inspect", {});
  assert.equal(edited.revisions.length, original.revisions.length + 1);
  assert.deepEqual(edited.nodes.find(node => node.id === "control"), original.nodes.find(node => node.id === "control"));
  const after = await snapshot(editor, "graphics-after", updated.revisionId);
  const { pixels: afterPixels, ...afterPreview } = await renderPreview(editor, after.id, "graphics-after.png");
  const afterSamples = checkPixels(afterPixels, 4, "after", 0);
  const areaChanges = changedPixels(beforePixels, afterPixels);

  await host.close();
  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = actor();
  const old = await invoke<ProjectSnapshot>(reopened, "project.snapshot.inspect", { snapshotId: before.id });
  assert.equal(old.contentHash, before.contentHash);
  assert.deepEqual(old.document, original);
  const restored = await invoke<ProjectDocument>(reopened, "project.snapshot.restore", { snapshotId: before.id,
    baseRevisionId: updated.revisionId, message: "Restore original graphics for acceptance" });
  const recoveryRevision = restored.revisions.at(-1)!;
  assert.equal(recoveryRevision.parentRevisionId, updated.revisionId);
  assert.equal(recoveryRevision.snapshotHash, before.contentHash);
  assert.deepEqual(restored.nodes, original.nodes);
  const recovery = await snapshot(reopened, "graphics-restored", recoveryRevision.id);
  const { pixels: restoredPixels, ...restoredPreview } = await renderPreview(reopened, recovery.id, "graphics-restored.png");
  assert.equal(restoredPreview.artifactId, beforePreview.artifactId);
  assert.ok(restoredPixels.equals(beforePixels));

  const video = await invoke<{ artifactId: string }>(reopened, "render.video", { snapshotId: after.id, startFrame: 0, durationFrames });
  const videoFile = "graphics-after.mp4";
  await writeArtifact(video.artifactId, videoFile);
  const videoPath = join(output, videoFile);
  const { streams: [stream] } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,avg_frame_rate,duration", "-of", "json", videoPath], { encoding: "utf8", timeout: 15_000 }));
  assert.deepEqual([stream.width, stream.height, stream.avg_frame_rate, Number(stream.duration)], [width, height, `${fps}/1`, durationFrames / fps]);
  const frameBytes = width * height * 3;
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-i", videoPath, "-map", "0:v:0", "-threads", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: (durationFrames + 1) * frameBytes, timeout: 15_000 });
  assert.equal(decoded.length, durationFrames * frameBytes);
  const videoSamples = Array.from({ length: durationFrames }, (_, frame) =>
    checkPixels(decoded.subarray(frame * frameBytes, (frame + 1) * frameBytes), 3, "after", 10));

  Object.assign(evidence, { status: "passed", width, height, before: { snapshot: before, ...beforePreview, samples: beforeSamples },
    after: { snapshot: after, ...afterPreview, samples: afterSamples, changedNodeIds: updated.changedNodeIds },
    restored: { snapshot: recovery, ...restoredPreview, revision: recoveryRevision }, changedPixels: areaChanges, outsideEditedRegions: 0,
    rejectedAtomically: invalidBatches.map(batch => batch.claim),
    video: { file: videoFile, artifactId: video.artifactId, durationFrames, fps, seconds: Number(stream.duration), samples: videoSamples } });
  console.log("PASS: targeted shape, path and chart pixels, unchanged surrounding regions, restored snapshot and edited MP4 after reopening");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(directory, { recursive: true, force: true });
  }
}
