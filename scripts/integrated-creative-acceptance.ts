import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeAssetImport, CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { SnapshotInspectionReport, TimelineInspectionReport } from "../src/contracts/inspection";
import type { SnapshotLayoutInspectionReport } from "../src/contracts/layout-inspection";
import type { ProjectDocument } from "../src/contracts/project";
import type { ProjectSnapshot } from "../src/platform/project-snapshots";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";

const output = resolve("out/integrated-creative");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-integrated-"));
const directory = join(root, "workspace"), store = new FileSystemArtifactStore(join(directory, "artifacts"));
const width = 640, height = 360, fps = 10, durationFrames = 80, sampleRate = 48_000;
const projectId = "cache-short", speech = "CPU 算得快，却常常要等数据。\n缓存，把常用数据放得更近。";
const narrationStart = 10, narrationIn = 2, narrationLength = 55, cut = 40;
const background = [17, 29, 49], indicator = [46, 184, 167], marker = [245, 185, 68];
const featureTools = ["project.create", "project.inspect", "project.scene.create", "project.snapshot.save", "project.snapshot.inspect",
  "project.snapshot.restore", "graphics.2d.text.create", "graphics.2d.shape.create", "graphics.2d.path.create", "graphics.2d.chart.create",
  "graphics.2d.edit", "animation.keyframes.set", "animation.keyframes.edit", "assets.import", "timeline.edit",
  "inspect.snapshot", "inspect.layout", "inspect.timeline", "render.preview", "render.video", "execution.list"];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };
let host: CreativeHost | undefined, calls = 0;
const revision = (document: ProjectDocument) => document.revisions.at(-1)!.id;
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const authored = (document: ProjectDocument) => ({ ...document, project: { ...document.project, updatedAt: "" }, revisions: [] });
const writeJson = async (name: string, data: unknown) => writeFile(join(output, name), JSON.stringify(data, null, 2) + "\n");
const editor = () => host!.createSession({ projectId, allowDestructive: true, toolIds: featureTools,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "snapshot.restore", "artifact.write", "execution.read"] });
async function call(session: CreativeSession, toolId: string, input: unknown) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, `Expected a manifest for ${toolId}`);
  return session.invoke({ toolId, toolVersion: manifest.version, runId: "integrated-creative", callId: String(++calls), input });
}
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown = {}) {
  const result = await call(session, toolId, input);
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}
async function save(session: CreativeSession, snapshotId: string, document: ProjectDocument) {
  return invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId, revisionId: revision(document) });
}
async function inspect(session: CreativeSession, snapshot: SnapshotReceipt) {
  const model = await invoke<SnapshotInspectionReport>(session, "inspect.snapshot", { snapshotId: snapshot.id });
  const layout = await invoke<SnapshotLayoutInspectionReport>(session, "inspect.layout", { snapshotId: snapshot.id, frames: [10, 20, 39, 42, 52, 65] });
  const timeline = await invoke<TimelineInspectionReport>(session, "inspect.timeline", { snapshotId: snapshot.id, requireNarrationForCaptions: true });
  assert.ok([model, layout, timeline].every(report => report.snapshotHash === snapshot.contentHash));
  assert.equal(model.coverage.checkedFrames.length, durationFrames);
  return { model, layout, timeline };
}
const ffmpeg = (args: string[], maxBuffer = 1 << 20) =>
  execFileSync("ffmpeg", ["-v", "error", "-threads", "1", ...args], { timeout: 35_000, maxBuffer });
const audio = (file: string) => ffmpeg(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"]);
async function artifact(artifactId: string, file: string) {
  const bytes = await store.read(artifactId);
  assert.ok(bytes);
  assert.equal(`sha256:${sha(bytes)}`, artifactId);
  await writeFile(join(output, file), bytes);
  return Buffer.from(bytes);
}
const rgb = (bytes: Buffer, stride: number, x: number, y: number) => [...bytes.subarray((y * width + x) * stride, (y * width + x) * stride + 3)];
const near = (value: number[], expected: number[], tolerance: number) =>
  value.length === 3 && value.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
function captionInk(bytes: Buffer, channels: number) {
  let total = 0;
  for (let offset = 270 * width * channels; offset < bytes.length; offset += channels)
    if (bytes[offset] >= 210 && bytes[offset + 1] >= 210 && bytes[offset + 2] >= 210) total++;
  return total;
}
async function preview(session: CreativeSession, snapshot: SnapshotReceipt, frame: number, name: string, captionVisible: boolean, expectedMarker?: number[]) {
  const { artifactId } = await invoke<{ artifactId: string }>(session, "render.preview", { snapshotId: snapshot.id, frame });
  const file = name + ".png", image = PNG.sync.read(await artifact(artifactId, file));
  assert.deepEqual([image.width, image.height], [width, height]);
  const ink = captionInk(image.data, 4);
  assert.ok(captionVisible ? ink > 30 : ink === 0, `Caption ink at frame ${frame}: ${ink}`);
  assert.ok(near(rgb(image.data, 4, 590, 38), indicator, 1));
  if (expectedMarker) assert.ok(near(rgb(image.data, 4, 350, 186), expectedMarker, 1), `Marker at frame ${frame}`);
  return { artifactId, file, frame, captionInk: ink, marker: rgb(image.data, 4, 350, 186) };
}
async function inspectVideo(artifactId: string, file: string, source: Buffer) {
  await artifact(artifactId, file);
  const path = join(output, file);
  const { streams } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,duration",
    "-of", "json", path], { encoding: "utf8", timeout: 15_000 }));
  const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const voice = streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  assert.deepEqual([video.width, video.height, video.avg_frame_rate, video.codec_name, Number(video.duration)], [width, height, "10/1", "h264", 8]);
  assert.equal(voice.codec_name, "aac");
  assert.ok(Math.abs(Number(voice.duration) - 8) <= 1024 / sampleRate);
  const stride = width * height * 3;
  const decoded = ffmpeg(["-i", path, "-map", "0:v:0", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], stride * (durationFrames + 1));
  assert.equal(decoded.length, stride * durationFrames);
  const image = (frame: number) => decoded.subarray(frame * stride, (frame + 1) * stride);
  const frameInk = Array.from({ length: durationFrames }, (_, frame) => {
    const ink = captionInk(image(frame), 3);
    assert.ok(frame >= narrationStart && frame < narrationStart + narrationLength ? ink > 30 : ink === 0, `Caption ink in MP4 at ${frame}: ${ink}`);
    return ink;
  });
  assert.ok(near(rgb(image(20), 3, 350, 186), marker, 10));
  assert.ok(near(rgb(image(42), 3, 8, 115), [20, 34, 52], 8));
  assert.ok(near(rgb(image(52), 3, 590, 38), indicator, 8));
  const pcm = audio(path);
  const perFrame = sampleRate / fps;
  let cross = 0, original = 0, result = 0;
  for (let i = sampleRate / 2; i < 5 * sampleRate; i++) {
    const a = source.readInt16LE((narrationIn * perFrame + i) * 2);
    const b = pcm.readInt16LE((narrationStart * perFrame + i) * 2);
    cross += a * b; original += a * a; result += b * b;
  }
  const correlation = cross / Math.sqrt(original * result);
  assert.ok(correlation > 0.9, `Decoded Mandarin waveform correlation: ${correlation}`);
  return { artifactId, file, frames: durationFrames, fps, seconds: Number(video.duration), audioSeconds: Number(voice.duration),
    frameInk, decodedVideoHash: sha(decoded), decodedAudioHash: sha(pcm), correlation };
}

try {
  const voicePath = join(root, "voice.wav"), pngPath = join(root, "indicator.png");
  const voiceSource = "docs/showcase/cpu-cache-30s.mp4";
  ffmpeg(["-i", voiceSource, "-map", "0:a:0", "-t", "6", "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", voicePath]);
  const voice = audio(voicePath);
  const png = new PNG({ width: 160, height: 90 });
  for (let y = 7; y < 13; y++) for (let x = 143; x < 153; x++) png.data.set([...indicator, 255], (y * png.width + x) * 4);
  await writeFile(pngPath, PNG.sync.write(png));
  const assetImports: CreativeAssetImport[] = [
    { projectId, sourceId: "voice", path: voicePath, mediaType: "audio/wav", attribution: "ScienceMotion AI CPU cache showcase" },
    { projectId, sourceId: "indicator", path: pngPath },
  ];
  host = await openCreativeHost({ directory, assetImports });
  const session = editor();
  const discovery = await session.discover({ limit: 100 });
  assert.deepEqual(discovery.tools.map(tool => tool.id).sort(), [...featureTools].sort());
  await invoke(session, "project.create", { name: "让数据更近", episodeId: "cache-short", width, height, fps, durationFrames });
  await invoke(session, "project.scene.create", { sceneId: "wait", name: "等待数据", startFrame: 0, durationFrames: cut });
  await invoke(session, "project.scene.create", { sceneId: "near", name: "缓存让数据更近", startFrame: cut, durationFrames: durationFrames - cut });
  const shape = (sceneId: string, nodeId: string, x: number, y: number, width: number, height: number, fill: string) =>
    invoke(session, "graphics.2d.shape.create", { sceneId, nodeId, primitive: "rect", x, y, width, height, fill });
  const text = (sceneId: string, nodeId: string, text: string, x: number, y: number, width: number, height: number, fontSize: number) =>
    invoke(session, "graphics.2d.text.create", { sceneId, nodeId, text, x, y, width, height, fontSize });
  await shape("wait", "wait-background", 0, 0, width, height, "#111d31");
  await text("wait", "wait-title", "CPU 算得快，数据要等", 54, 45, 480, 58, 34);
  await text("wait", "wait-label", "数据从较远的地方送来", 54, 112, 475, 40, 23);
  await invoke(session, "graphics.2d.path.create", { sceneId: "wait", nodeId: "data-path", x: 55, y: 178, width: 510, height: 42,
    pathData: "M 0 21 H 510", fill: "transparent", stroke: "#357d99", strokeWidth: 4 });
  await shape("wait", "data-marker", 80, 178, 46, 30, "#f5b944");
  await shape("near", "near-background", 0, 0, width, height, "#172736");
  await text("near", "near-title", "缓存，让数据更近", 54, 45, 480, 58, 34);
  await text("near", "near-label", "常用数据\n放在 CPU 附近", 54, 131, 235, 83, 29);
  await text("near", "chart-label", "示意耗时", 327, 108, 160, 29, 17);
  await invoke(session, "graphics.2d.chart.create", { sceneId: "near", nodeId: "latency", chartType: "bar",
    x: 322, y: 102, width: 350, height: 162, data: [{ label: "较远", value: 8 }, { label: "缓存", value: 2 }],
    fill: "#5bd9cd", fontSize: 16 });
  await invoke(session, "animation.keyframes.set", { trackId: "data-motion", targetNodeId: "data-marker", targetProperty: "transform.position",
    keyframes: [{ frame: 0, value: [80, 178, 0] }, { frame: 20, value: [720, 178, 0], interpolation: "linear" },
      { frame: 39, value: [480, 178, 0], interpolation: "linear" }] });
  await invoke(session, "assets.import", { sourceId: "indicator", assetId: "indicator" });
  const imported = await invoke<{ revisionId: string }>(session, "assets.import", { sourceId: "voice", assetId: "voice", mediaType: "audio/wav" });
  await invoke(session, "timeline.edit", { baseRevisionId: imported.revisionId, edits: [
    { op: "set-transition", fromShotId: "shot-wait", toShotId: "shot-near", transition: { type: "crossfade", durationFrames: 5 } },
    { op: "place-clip", trackId: "brand", clip: { id: "indicator", assetId: "indicator", startFrame: 0, durationFrames } },
    { op: "place-clip", trackId: "narration", clip: { id: "cache-voice", assetId: "voice", startFrame: narrationStart, durationFrames: narrationLength, inFrame: narrationIn } },
    { op: "set-caption", captionId: "spoken-cue", caption: { text: speech, startFrame: 4, durationFrames: 66 } },
  ] });
  const draft = await invoke<ProjectDocument>(session, "project.inspect");
  const before = await save(session, "before-repair", draft);
  const initial = await inspect(session, before);
  await writeJson("inspection-before.json", initial);
  const motion = initial.model.issues.find(issue => issue.code === "INSPECT_NODE_OUTSIDE_FRAME" && issue.frames.includes(20));
  const crop = initial.layout.issues.find(issue => issue.code === "LAYOUT_VIEWPORT_OVERFLOW" && issue.frame === 52);
  assert.equal(motion?.nodeId, "data-marker");
  assert.equal(crop?.nodeId, "latency");
  assert.ok(initial.layout.issues.some(issue => issue.nodeId === motion?.nodeId && issue.frame === 20));
  const [gap] = initial.timeline.issues;
  assert.deepEqual([gap?.code, gap?.captionId, gap?.uncovered], ["TIMELINE_CAPTION_NARRATION_GAP", "spoken-cue",
    [{ startFrame: 4, endFrame: 10 }, { startFrame: 65, endFrame: 70 }]]);
  assert.deepEqual(await invoke(session, "project.inspect"), draft);
  const readOnly = host.createSession({ projectId, permissions: ["snapshot.read"], toolIds: ["inspect.timeline"] });
  const range = await invoke<TimelineInspectionReport>(readOnly, "inspect.timeline", { snapshotId: before.id, range: { startFrame: 38, durationFrames: 8 } });
  assert.deepEqual(range.intervals.find(interval => interval.kind === "crossfade"),
    { kind: "crossfade", fromShotId: "shot-wait", toShotId: "shot-near", startFrame: 40, endFrame: 45 });
  const foreign = host.createSession({ projectId: "unrelated", permissions: ["snapshot.read"], toolIds: ["inspect.timeline"] });
  const denied = await call(foreign, "inspect.timeline", { snapshotId: before.id });
  assert.equal(denied.diagnostics[0]?.code, "HOST_SNAPSHOT_DENIED");
  const previousPreviews = [await preview(session, before, 7, "before-caption", true),
    await preview(session, before, 20, "before-motion", true, background)];

  const track = draft.animationTracks.find(item => item.targetNodeId === motion?.nodeId && item.targetProperty === "transform.position")!;
  const chart = draft.nodes.find(item => item.id === crop?.nodeId)!;
  const cue = draft.sequences[0].captions!.find(item => item.id === gap.captionId)!;
  const interval = initial.timeline.intervals.find(item => item.kind === "narration" && item.gain > 0)!;
  const motionEdit = await invoke<{ revisionId: string }>(session, "animation.keyframes.edit", { baseRevisionId: revision(draft), edits: [
    { op: "update", trackId: track.id, frame: 20, changes: { value: [330, 178, 0], interpolation: "bezier", easing: "ease-in-out" } },
  ] });
  const chartEdit = await invoke<{ revisionId: string }>(session, "graphics.2d.edit", { baseRevisionId: motionEdit.revisionId, edits: [
    { kind: "chart", nodeId: chart.id, changes: { width: width - chart.transform.position[0] - 40 } },
  ] });
  await invoke(session, "timeline.edit", { baseRevisionId: chartEdit.revisionId, edits: [
    { op: "set-caption", captionId: gap.captionId, caption: { text: cue.text,
      startFrame: interval.startFrame, durationFrames: interval.endFrame - interval.startFrame } },
  ] });
  const repaired = await invoke<ProjectDocument>(session, "project.inspect");
  const fixed = await save(session, "after-repair", repaired);
  const checked = await inspect(session, fixed);
  assert.ok(Object.values(checked).every(report => report.outcome === "no-issues-detected"), JSON.stringify(checked));
  assert.deepEqual(repaired.nodes.filter(node => node.id !== chart.id), draft.nodes.filter(node => node.id !== chart.id));
  assert.deepEqual(repaired.assets, draft.assets);
  assert.deepEqual(repaired.shots, draft.shots);
  assert.deepEqual(repaired.clips, draft.clips);
  await writeJson("inspection-after.json", checked);
  const fixedPreviews = [];
  for (const frame of [7, 10, 20, 42, 52, 64, 65]) fixedPreviews.push(await preview(session, fixed, frame, `fixed-${frame}`,
    frame >= narrationStart && frame < narrationStart + narrationLength, frame === 20 ? marker : undefined));
  const firstVideo = await invoke<{ artifactId: string }>(session, "render.video", { snapshotId: fixed.id, startFrame: 0, durationFrames });
  const firstExport = await inspectVideo(firstVideo.artifactId, "cache-short.mp4", voice);
  await host.close();
  await Promise.all(assetImports.map(source => rm(source.path)));

  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = editor();
  const original = await invoke<ProjectSnapshot>(reopened, "project.snapshot.inspect", { snapshotId: before.id });
  assert.equal(original.contentHash, before.contentHash);
  assert.deepEqual(original.document, draft);
  const rolledBack = await invoke<ProjectDocument>(reopened, "project.snapshot.restore", {
    snapshotId: before.id, baseRevisionId: revision(repaired), message: "Verify recoverable draft before restoring the repaired edit",
  });
  assert.deepEqual(authored(rolledBack), authored(draft));
  const recovered = await invoke<ProjectDocument>(reopened, "project.snapshot.restore", {
    snapshotId: fixed.id, baseRevisionId: revision(rolledBack), message: "Restore the verified short after reopening",
  });
  assert.deepEqual(authored(recovered), authored(repaired));
  assert.equal(recovered.revisions.at(-1)?.snapshotHash, fixed.contentHash);
  assert.equal(recovered.revisions.at(-1)?.parentRevisionId, revision(rolledBack));
  const restored = await save(reopened, "recovered-short", recovered);
  const restoredReport = await invoke<TimelineInspectionReport>(reopened, "inspect.timeline", { snapshotId: restored.id, requireNarrationForCaptions: true });
  assert.deepEqual(restoredReport.intervals, checked.timeline.intervals);
  assert.deepEqual(restoredReport.issues, []);
  const reopenedPreview = await preview(reopened, restored, 20, "recovered-motion", true, marker);
  assert.equal(reopenedPreview.artifactId, fixedPreviews.find(item => item.frame === 20)?.artifactId);
  const { record: admitted } = await reopened.jobs.submit({ toolId: "render.video", input: { snapshotId: restored.id, startFrame: 0, durationFrames },
    toolVersion: "1.0.0", callId: "recovered-video", runId: "integrated-creative", submissionId: "recovered-video" });
  const deadline = Date.now() + 75_000;
  let job = admitted;
  while (["queued", "running", "stopping", "publishing"].includes(job.state)) {
    assert.ok(Date.now() < deadline, "Recovered render job did not settle");
    await new Promise(resolve => setTimeout(resolve, 50));
    job = (await reopened.jobs.get(admitted.id))!;
  }
  assert.equal(job.state, "succeeded", JSON.stringify(job.diagnostic));
  assert.equal(job.input.snapshot.contentHash, restored.contentHash);
  assert.ok(job.result);
  const restoredExport = await inspectVideo(job.result.artifactId, "cache-short-recovered.mp4", voice);
  assert.equal(restoredExport.decodedVideoHash, firstExport.decodedVideoHash);
  assert.equal(restoredExport.decodedAudioHash, firstExport.decodedAudioHash);
  const trace = await invoke<ToolExecutionRecord[]>(reopened, "execution.list");
  assert.ok(trace.some(item => item.toolId === "inspect.timeline" && item.status === "succeeded"));
  assert.ok(trace.some(item => item.toolId === "project.snapshot.restore" && item.status === "succeeded"));
  await writeJson("executions.json", trace);
  Object.assign(evidence, { status: "passed", projectId, discoveredTools: discovery.tools.map(tool => tool.id), voiceSource,
    diagnoses: [motion, crop, gap], before: { snapshot: before, previews: previousPreviews },
    repaired: { snapshot: fixed, previews: fixedPreviews, export: firstExport },
    recovered: { snapshot: restored, preview: reopenedPreview, export: restoredExport, jobId: job.id },
    sourceFilesRemoved: true, toolCalls: calls });
  console.log("PASS: public creation, three scoped diagnoses, targeted repair, verified export and exact recovered media after reopening");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    await writeJson("evidence.json", evidence);
    await rm(root, { recursive: true, force: true });
  }
}
