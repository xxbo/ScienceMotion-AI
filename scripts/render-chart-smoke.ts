import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCreativeHost } from "../src/platform/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { ToolResult } from "../src/contracts/agent-tool";

// Exercise the production tool -> snapshot -> composition -> PNG/MP4 path.
const width = 1280, height = 720;
const root = await mkdtemp(join(tmpdir(), "sciencemotion-charts-"));
const cyan = [85, 214, 232], orange = [255, 180, 84];
const barArea = { x: 80, y: 190, width: 520, height: 360 };
const lineArea = { x: 680, y: 190, width: 520, height: 360 };
let host: Awaited<ReturnType<typeof openCreativeHost>> | undefined;

function decodeFrame(file: string): Buffer {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: width * height * 3 + 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || String(result.error));
  assert.equal(result.stdout.length, width * height * 3);
  return result.stdout;
}
function colorCount(pixels: Buffer, area: typeof barArea, color: number[], tolerance = 6): number {
  let count = 0;
  for (let y = area.y; y < area.y + area.height; y++) for (let x = area.x; x < area.x + area.width; x++) {
    const offset = (y * width + x) * 3;
    if (color.every((channel, index) => Math.abs(channel - pixels[offset + index]) <= tolerance)) count++;
  }
  return count;
}
function assertRegionUnchanged(before: Buffer, after: Buffer, area: typeof barArea): void {
  for (let y = area.y; y < area.y + area.height; y++) {
    const start = (y * width + area.x) * 3;
    assert.ok(before.subarray(start, start + area.width * 3).equals(after.subarray(start, start + area.width * 3)),
      `Unrelated line chart changed at row ${y}`);
  }
}
async function saveArtifact(result: ToolResult, file: string): Promise<void> {
  const hash = result.artifacts?.[0]?.id.replace(/^sha256:/, "");
  assert.ok(hash && /^[a-f0-9]{64}$/.test(hash), "Missing content-addressed render Artifact");
  await writeFile(file, await readFile(join(root, "artifacts", "blobs", hash.slice(0, 2), hash)));
}

try {
  await mkdir("out", { recursive: true });
  host = await openCreativeHost({ directory: root });
  const session = host.createSession({ projectId: "chart-render-regression",
    permissions: ["project.read", "project.write", "artifact.read", "artifact.write", "snapshot.read", "snapshot.write"],
    toolIds: ["project.create", "project.scene.create", "graphics.2d.text.create", "graphics.2d.chart.create",
      "project.inspect", "project.patch.apply", "project.snapshot.save", "render.preview", "render.video"] });
  let call = 0;
  const invoke = async (toolId: string, input: unknown) => {
    const manifest = await session.manifest(toolId);
    assert.ok(manifest, `Tool not discoverable: ${toolId}`);
    const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "chart-render-smoke", callId: `chart-${++call}` });
    assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
    return result;
  };
  await invoke("project.create", { name: "Chart rendering regression", episodeId: "charts", durationFrames: 30, fps: 30, width, height });
  await invoke("project.scene.create", { sceneId: "charts", name: "Charts", durationFrames: 30 });
  await invoke("graphics.2d.text.create", { sceneId: "charts", nodeId: "title", text: "数据驱动图表 · 柱状图与折线图",
    x: 80, y: 55, fontSize: 38, width: 1120 });
  for (const [id, text, x] of [["bar-heading", "正值、负值与零值", 80], ["line-heading", "按数据顺序连接", 680]] as const) {
    await invoke("graphics.2d.text.create", { sceneId: "charts", nodeId: id, text, x, y: 145, fontSize: 24, width: 520 });
  }
  await invoke("graphics.2d.chart.create", { sceneId: "charts", nodeId: "bars", chartType: "bar", ...barArea,
    fill: "#55d6e8", data: [{ label: "增长", value: 12 }, { label: "下降", value: -6 }, { label: "持平", value: 0 }] });
  await invoke("graphics.2d.chart.create", { sceneId: "charts", nodeId: "line", chartType: "line", ...lineArea,
    fill: "#ffb454", data: [{ label: "起点", value: 0 }, { label: "中段", value: 6 }, { label: "终点", value: 12 }] });
  const project = (await invoke("project.inspect", {})).output as ProjectDocument;
  const beforeSnapshot = await invoke("project.snapshot.save", { snapshotId: "charts-before", revisionId: project.revisions.at(-1)!.id });
  const before = await invoke("render.preview", { snapshotId: "charts-before", frame: 0 });
  await saveArtifact(before, "out/charts-before.png");
  const beforePixels = decodeFrame("out/charts-before.png");
  const bars = colorCount(beforePixels, barArea, cyan), line = colorCount(beforePixels, lineArea, orange);
  assert.ok(bars > 5000 && bars < 50000, `Expected separate bars, not a filled rectangle: ${bars} pixels`);
  assert.ok(line > 300 && line < 5000, `Expected a thin line with markers, not a filled rectangle: ${line} pixels`);
  const firstBarArea = { x: 190, y: 240, width: 50, height: 130 };
  assert.ok(colorCount(beforePixels, firstBarArea, cyan) > 5000, "Positive bar is missing from its expected area");

  const chartNode = structuredClone(project.nodes.find((node) => node.id === "bars")!);
  const geometry = chartNode.components.find((component) => component.kind === "geometry")!;
  (geometry.data.chartData as Array<{ label: string; value: number }>)[0].value = 0;
  await invoke("project.patch.apply", { schemaVersion: "1.3.0", projectId: project.project.id,
    baseRevisionId: project.revisions.at(-1)!.id, patches: [{ op: "update-node", nodeId: "bars", changes: { components: chartNode.components } }] });
  const updated = (await invoke("project.inspect", {})).output as ProjectDocument;
  assert.deepEqual(updated.nodes.filter((node) => node.id !== "bars"), project.nodes.filter((node) => node.id !== "bars"));
  const afterSnapshot = await invoke("project.snapshot.save", { snapshotId: "charts-after", revisionId: updated.revisions.at(-1)!.id });
  const after = await invoke("render.preview", { snapshotId: "charts-after", frame: 0 });
  await saveArtifact(after, "out/charts-after.png");
  const afterPixels = decodeFrame("out/charts-after.png");
  assert.equal(colorCount(afterPixels, firstBarArea, cyan), 0, "Changing 12 to zero must remove the positive bar");
  assertRegionUnchanged(beforePixels, afterPixels, lineArea);
  assert.notEqual(before.artifacts![0].id, after.artifacts![0].id);

  const video = await invoke("render.video", { snapshotId: "charts-before", startFrame: 0, durationFrames: 30 });
  await saveArtifact(video, "out/charts-video.mp4");
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", "out/charts-video.mp4"], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  const stream = metadata.streams.find((item: { codec_type: string }) => item.codec_type === "video");
  assert.ok(stream && stream.width === width && stream.height === height && stream.r_frame_rate === "30/1");
  assert.ok(Math.abs(Number(metadata.format.duration) - 1) < 0.05);
  const videoPixels = decodeFrame("out/charts-video.mp4");
  const videoBars = colorCount(videoPixels, barArea, cyan, 24), videoLine = colorCount(videoPixels, lineArea, orange, 24);
  assert.ok(videoBars > 5000 && videoBars < 50000 && videoLine > 250 && videoLine < 5000, "MP4 must preserve rendered bars and line");
  await writeFile("out/chart-render-evidence.json", JSON.stringify({
    check: "production chart rendering and targeted data edit", width, height, fps: 30, durationFrames: 30,
    beforeSnapshot: beforeSnapshot.output, afterSnapshot: afterSnapshot.output,
    before: before.output, after: after.output, video: video.output,
    pixels: { bars, line, videoBars, videoLine, unrelatedLineRegionUnchanged: true },
  }, null, 2) + "\n");
  console.log(`PASS chart PNG/MP4 pixels; targeted edit removes one bar; unrelated line chart unchanged (${bars} bar pixels, ${line} line pixels)`);
} finally {
  await host?.close();
  await rm(root, { recursive: true, force: true });
}
