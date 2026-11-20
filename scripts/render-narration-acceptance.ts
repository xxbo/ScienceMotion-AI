import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeAssetImport, CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { TimelinePatchOperation } from "../src/contracts/project-patch";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";

const output = resolve("out/narration");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-narration-"));
const directory = join(root, "workspace"), store = new FileSystemArtifactStore(join(directory, "artifacts"));
const width = 320, height = 180, fps = 10, durationFrames = 80, sampleRate = 48_000;
const samplesPerFrame = sampleRate / fps, speechStart = 14;
const projectId = "narration-fixture", evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };
let host: CreativeHost | undefined, calls = 0;

const actor = (id = projectId) => host!.createSession({ projectId: id,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "project.snapshot.save", "graphics.2d.shape.create",
    "assets.import", "timeline.edit", "render.preview", "render.video"] });
const call = (session: CreativeSession, toolId: string, input: unknown) =>
  session.invoke({ runId: "narration-acceptance", callId: String(++calls), toolVersion: "1.0.0", toolId, input });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const result = await call(session, toolId, input);
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}
async function reject(session: CreativeSession, toolId: string, input: unknown, diagnostic: RegExp) {
  const result = await call(session, toolId, input);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.diagnostics), diagnostic);
}

function timingWave() {
  const bytes = Buffer.alloc(44 + 6 * samplesPerFrame * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let sample = 0; sample < 6 * samplesPerFrame; sample++) {
    const frequency = [220, 610, 890][Math.floor(sample / (2 * samplesPerFrame))];
    bytes.writeInt16LE(Math.round(14_000 * Math.sin(2 * Math.PI * frequency * sample / sampleRate)), 44 + sample * 2);
  }
  return bytes;
}
const place = (trackId: string, id: string, assetId: string, startFrame: number, durationFrames: number, inFrame = 0, gain = 1): TimelinePatchOperation =>
  ({ op: "place-clip", trackId, clip: { id, assetId, startFrame, durationFrames, inFrame, gain } });
const caption = (captionId: string, text: string, startFrame: number, durationFrames: number): TimelinePatchOperation =>
  ({ op: "set-caption", captionId, caption: { text, startFrame, durationFrames } });
const hasCaption = (frame: number) => (frame >= 5 && frame < 9) || (frame >= 16 && frame < 70);
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function saveArtifact(id: string, file: string) {
  const bytes = await store.read(id);
  assert.ok(bytes);
  assert.equal(hash(bytes), id);
  await writeFile(join(output, file), bytes);
  return Buffer.from(bytes);
}
const isInk = (bytes: Buffer, offset: number) => bytes[offset] >= 210 && bytes[offset + 1] >= 210 && bytes[offset + 2] >= 210;
function captionInk(bytes: Buffer, channels: number) {
  let ink = 0;
  for (let y = 85; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    if (isInk(bytes, i)) ink++;
  }
  return ink;
}
async function preview(session: CreativeSession, snapshotId: string, frame: number, visible: boolean, file: string, sceneId?: string) {
  const { artifactId } = await invoke<{ artifactId: string }>(session, "render.preview", { snapshotId, frame, ...(sceneId ? { sceneId } : {}) });
  const png = PNG.sync.read(await saveArtifact(artifactId, file));
  assert.deepEqual([png.width, png.height], [width, height]);
  const ink = captionInk(png.data, 4);
  assert.ok(visible ? ink > 30 : ink === 0, `Frame ${frame} caption ink: ${ink}`);
  return { file, artifactId, frame, ink };
}

const ffmpeg = (args: string[], maxBuffer = 1 << 20) => execFileSync("ffmpeg", ["-v", "error", "-threads", "1", ...args], { timeout: 20_000, maxBuffer });
const decodeAudio = (file: string) => ffmpeg(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"]);
function tones(pcm: Buffer, frame: number) {
  const offset = frame * samplesPerFrame + 1_440, count = 1_920;
  let sumSq = 0;
  const peaks = [220, 610, 890].map(frequency => {
    let real = 0, imaginary = 0;
    for (let i = 0; i < count; i++) {
      const sample = pcm.readInt16LE(2 * (offset + i)) / 32_768;
      const angle = 2 * Math.PI * frequency * i / sampleRate;
      real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle);
      if (frequency === 220) sumSq += sample * sample;
    }
    return 2 * Math.hypot(real, imaginary) / count;
  });
  return { peaks, rms: Math.sqrt(sumSq / count) };
}
function verifyTone(samples: ReturnType<typeof tones>, index: number) {
  assert.ok(samples.peaks[index] > 0.08 && samples.peaks.every((peak, i) => i === index || peak < 0.025), JSON.stringify(samples));
}
function compareSpeech(source: Buffer, output: Buffer) {
  let cross = 0, inputSquares = 0, outputSquares = 0;
  for (let i = sampleRate / 2; i < 5.5 * sampleRate; i++) {
    const a = source.readInt16LE(i * 2), b = output.readInt16LE((speechStart * samplesPerFrame + i) * 2);
    cross += a * b; inputSquares += a * a; outputSquares += b * b;
  }
  const score = cross / Math.sqrt(inputSquares * outputSquares);
  assert.ok(score > 0.9, `Exported speech waveform correlation: ${score}`);
  return score;
}
async function verifyVideo(id: string, file: string, start: number, count: number, sourceSpeech?: Buffer) {
  await saveArtifact(id, file);
  const path = join(output, file);
  const { streams } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,avg_frame_rate,start_time,duration", "-of", "json", path],
  { encoding: "utf8", timeout: 15_000 }));
  const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const audio = streams.filter((stream: { codec_type: string }) => stream.codec_type === "audio");
  assert.deepEqual([video.width, video.height, video.avg_frame_rate, Number(video.duration)], [width, height, `${fps}/1`, count / fps]);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].codec_name, "aac");
  assert.equal(Number(audio[0].start_time), 0);
  assert.ok(Math.abs(Number(audio[0].duration) - count / fps) <= 1024 / sampleRate);
  const frameBytes = width * height * 3;
  const rgb = ffmpeg(["-i", path, "-map", "0:v:0", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], (count + 1) * frameBytes);
  assert.equal(rgb.length, count * frameBytes);
  const frameInk = Array.from({ length: count }, (_, i) => {
    const ink = captionInk(rgb.subarray(i * frameBytes, (i + 1) * frameBytes), 3);
    assert.ok(hasCaption(start + i) ? ink > 30 : ink === 0, `Frame ${start + i} MP4 caption ink: ${ink}`);
    return ink;
  });
  const cueReferences = await Promise.all([6, 7].map(async frame => PNG.sync.read(await readFile(join(output, `frame-${frame}.png`))).data));
  const switchDistances = [6, 7].map(frame => cueReferences.map(reference => {
    const offset = (frame - start) * frameBytes;
    let different = 0;
    for (let i = 85 * width; i < width * height; i++) {
      if (isInk(rgb, offset + i * 3) !== isInk(reference, i * 4)) different++;
    }
    return different;
  }));
  assert.ok(switchDistances[0][0] < switchDistances[0][1] && switchDistances[1][1] < switchDistances[1][0],
    `Expected a caption switch on frame 7: ${JSON.stringify(switchDistances)}`);
  const pcm = decodeAudio(path);
  assert.ok(pcm.length >= count * samplesPerFrame * 2 && pcm.length < (count * samplesPerFrame + 1024) * 2);
  const probes = [];
  for (const [frame, index] of [[1, -1], [4, -1], [5, 1], [6, 1], [7, 2], [8, 2], [9, -1], [10, 1], [11, 1], [12, -1], [78, -1]]) {
    if (frame < start || frame >= start + count) continue;
    const sample = tones(pcm, frame - start);
    if (index < 0) assert.ok(sample.rms < 0.003, `Frame ${frame} should be silent: ${sample.rms}`);
    else verifyTone(sample, index);
    probes.push({ frame, ...sample });
  }
  const gainRatio = tones(pcm, 6 - start).peaks[1] / tones(pcm, 10 - start).peaks[1];
  assert.ok(gainRatio > 0.45 && gainRatio < 0.55, `Gain ratio: ${gainRatio}`);
  return { artifactId: id, file, startFrame: start, frames: count, fps, videoSeconds: Number(video.duration),
    audioSeconds: Number(audio[0].duration), frameInk, switchDistances, probes, gainRatio, ...(sourceSpeech ? { speechCorrelation: compareSpeech(sourceSpeech, pcm) } : {}) };
}

try {
  const voice = join(root, "approved-narration.wav"), timing = join(root, "timing.wav"), invalid = join(root, "broken.wav");
  const fixture = resolve("docs/showcase/cpu-cache-30s.mp4");
  ffmpeg(["-i", fixture, "-map", "0:a:0", "-t", "6", "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", voice]);
  const sourceSpeech = decodeAudio(voice);
  assert.equal(sourceSpeech.length, 6 * sampleRate * 2);
  const wave = timingWave();
  await Promise.all([writeFile(timing, wave), writeFile(invalid, wave.subarray(0, -1))]);
  const assetImports: CreativeAssetImport[] = [
    { projectId, sourceId: "voice", path: voice, mediaType: "audio/wav", attribution: "ScienceMotion AI showcase" },
    { projectId, sourceId: "timing", path: timing, mediaType: "audio/wav" },
    { projectId, sourceId: "invalid", path: invalid, mediaType: "audio/wav" },
  ];
  host = await openCreativeHost({ directory, assetImports });
  const editor = actor();
  const create = (session: CreativeSession) => invoke(session, "project.create", { name: "Narration and subtitles", episodeId: "narration-fixture",
    width, height, fps, durationFrames });
  await create(editor);
  await invoke(editor, "project.scene.create", { sceneId: "scene", name: "Voice", durationFrames });
  const clean = await invoke<{ revisionId: string }>(editor, "graphics.2d.shape.create", {
    sceneId: "scene", nodeId: "background", primitive: "rect", x: 0, y: 0, width, height, fill: "#175970",
  });
  const before = await invoke<{ contentHash: string }>(editor, "project.snapshot.save", { snapshotId: "visual-only", revisionId: clean.revisionId });
  const old = await preview(editor, "visual-only", 5, false, "before.png");
  await reject(editor, "assets.import", { sourceId: "voice", assetId: "from-unmatched-type" }, /HOST_ASSET_IMPORT_DENIED/);
  await reject(editor, "assets.import", { sourceId: "invalid", assetId: "invalid", mediaType: "audio/wav" }, /HOST_WAV_INVALID/);
  const other = actor("other-project");
  await create(other);
  await reject(other, "assets.import", { sourceId: "voice", assetId: "voice", mediaType: "audio/wav" }, /HOST_ASSET_IMPORT_DENIED/);
  await invoke(editor, "assets.import", { sourceId: "timing", assetId: "timing", mediaType: "audio/wav" });
  const imported = await invoke<{ revisionId: string }>(editor, "assets.import", { sourceId: "voice", assetId: "voice", mediaType: "audio/wav" });
  const audio1 = place("narration", "trimmed-timing", "timing", 5, 4, 2, 0.5);
  const cap1 = caption("first", "PCM 610", 5, 2);
  const current = await invoke<ProjectDocument>(editor, "project.inspect", {});
  const apply = (edits: TimelinePatchOperation[]) => ({ baseRevisionId: imported.revisionId, edits });
  for (const [edits, diagnostic] of [
    [[cap1, place("narration", "bad", "timing", 5, 5, 2)], /exceeds the WAV source duration/],
    [[audio1, place("other-audio", "overlap", "timing", 6, 2)], /Narration clip overlaps/],
    [[cap1, caption("overlap", "Overlap", 6, 2)], /Caption overlaps/],
    [[caption("outside", "Too late", 79, 2)], /Caption exceeds sequence bounds/],
  ] as [TimelinePatchOperation[], RegExp][]) {
    await reject(editor, "timeline.edit", apply(edits), diagnostic);
    assert.deepEqual(await invoke(editor, "project.inspect", {}), current);
  }
  const edited = await invoke<{ revisionId: string; changedClipIds: string[]; changedCaptionIds: string[] }>(editor, "timeline.edit", apply([
    audio1, place("narration", "reference", "timing", 10, 2, 2), place("narration", "voice", "voice", speechStart, 60),
    cap1, caption("second", "PCM 890", 7, 2), caption("speech", "CPU 算得快，却常常要等数据。\n缓存，把常用数据放得更近。", 16, 54),
  ]));
  assert.deepEqual(edited.changedClipIds, ["trimmed-timing", "reference", "voice"]);
  assert.deepEqual(edited.changedCaptionIds, ["first", "second", "speech"]);
  const after = await invoke<{ contentHash: string }>(editor, "project.snapshot.save", { snapshotId: "with-narration", revisionId: edited.revisionId });
  assert.notEqual(after.contentHash, before.contentHash);
  const previews = [];
  for (const frame of [4, 5, 6, 7, 8, 9, 15, 16, 69, 70]) {
    previews.push(await preview(editor, "with-narration", frame, hasCaption(frame), `frame-${frame}.png`));
  }
  assert.notEqual(previews.find(item => item.frame === 6)?.artifactId, previews.find(item => item.frame === 7)?.artifactId);
  const source = await preview(editor, "with-narration", 5, false, "scene-only.png", "scene");
  assert.equal(source.artifactId, old.artifactId);
  const sub = await invoke<{ artifactId: string }>(editor, "render.video", { snapshotId: "with-narration", startFrame: 6, durationFrames: 6 });
  const subrange = await verifyVideo(sub.artifactId, "subrange.mp4", 6, 6);

  await host.close();
  await Promise.all(assetImports.map(item => rm(item.path)));
  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = actor();
  const oldAfterReopen = await preview(reopened, "visual-only", 5, false, "reopened-before.png");
  assert.equal(oldAfterReopen.artifactId, old.artifactId);
  const { record: admitted } = await reopened.jobs.submit({
    toolId: "render.video", input: { snapshotId: "with-narration", startFrame: 0, durationFrames },
    toolVersion: "1.0.0", callId: "export", runId: "narration-reopen", submissionId: "export",
  });
  const deadline = Date.now() + 65_000;
  let job = admitted;
  while (["queued", "running", "stopping", "publishing"].includes(job.state)) {
    assert.ok(Date.now() < deadline, "Narration export did not settle");
    await new Promise(resolve => setTimeout(resolve, 50));
    job = (await reopened.jobs.get(admitted.id))!;
  }
  assert.equal(job.state, "succeeded", JSON.stringify(job.diagnostic));
  assert.equal(job.input.snapshot.contentHash, after.contentHash);
  assert.ok(job.result);
  const full = await verifyVideo(job.result.artifactId, "narration-and-captions.mp4", 0, durationFrames, sourceSpeech);
  Object.assign(evidence, { status: "passed", before: { ...before, preview: old, reopened: oldAfterReopen },
    after: { ...after, previews, sceneOnly: source }, full: { ...full, jobId: job.id }, subrange, speechStartFrame: speechStart,
    sourceFilesRemovedBeforeReopen: true, source: "docs/showcase/cpu-cache-30s.mp4, first six seconds of Mandarin narration" });
  console.log("PASS: narration timing, source trim, gain, AAC, caption boundaries and retained snapshots after reopening");
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
