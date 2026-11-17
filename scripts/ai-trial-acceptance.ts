import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreativeClientRequest, CreativeLocalConfig } from "../src/contracts/creative-client";
import type { ProjectDocument } from "../src/contracts/project";
import type { SnapshotLayoutInspectionReport } from "../src/contracts/layout-inspection";
import type { SnapshotInspectionReport } from "../src/contracts/inspection";
import { parseCreativeRequest } from "../src/platform/creative-stdio";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";

// This replays a historical model interaction. It never calls or impersonates a model.
const fixture = "docs/ai-trials/cache-hit-2026-11-17";
const output = resolve("out/ai-trial");
const width = 960, height = 540, frames = [0, 90, 179, 180, 270, 359];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
// Trace payloads are heterogeneous JSON; validate their protocol and tool-specific fields below.
type Entry = { sequence: number; at: string; kind: string; data: any };
function transcript(text: string) {
  assert.ok(text.endsWith("\n"), "Truncated historical transcript");
  const records: Entry[] = text.trim().split("\n").map(line => JSON.parse(line));
  records.forEach((r, i) => {
    assert.equal(r.sequence, i + 1); assert.ok(Number.isFinite(Date.parse(r.at)));
    if (i) assert.ok(Date.parse(r.at) >= Date.parse(records[i - 1].at));
  });
  assert.equal(records[0].kind, "session"); assert.equal(records[0].data.protocolVersion, "1.0.0");
  assert.equal(records[1].kind, "response"); assert.equal(records[1].data.type, "ready");
  const requests: CreativeClientRequest[] = [], responses = new Map<string, any>();
  for (let i = 2; i < records.length; i += 2) {
    const request = records[i], response = records[i + 1];
    assert.equal(request.kind, "request"); assert.equal(response?.kind, "response");
    const r = parseCreativeRequest(JSON.parse(request.data.text));
    assert.ok(r.note?.length); assert.equal(responses.has(r.id), false, "Duplicate request identity");
    assert.equal(response.data.id, r.id); assert.equal(response.data.ok, true);
    if (r.method === "invoke") {
      assert.equal(response.data.result.ok, true, JSON.stringify(response.data.result.diagnostics));
      assert.equal(response.data.result.metadata.toolId, r.params.toolId);
      assert.equal(response.data.result.metadata.toolVersion, r.params.toolVersion);
    }
    requests.push(r); responses.set(r.id, response.data);
  }
  assert.equal(requests[0].method, "discover"); assert.equal(requests.at(-1)!.method, "close");
  assert.deepEqual(responses.get("close").result, { closed: true });
  const catalogue = responses.get("discover").result;
  assert.equal(catalogue.total, 16); assert.equal(catalogue.tools.length, 16);
  for (const r of requests.filter(r => r.method === "invoke")) {
    const m = catalogue.tools.find((t: any) => t.id === r.params.toolId);
    assert.ok(m); assert.equal(m.version, r.params.toolVersion);
  }
  return { records, requests, responses, catalogue,
    value: <T>(id: string): T => responses.get(id).result.output as T };
}
type Trial = ReturnType<typeof transcript>;
function checkRenderReceipt(t: Trial, id: string) {
  const request = t.requests.find(r => r.id === id);
  assert.ok(request?.method === "invoke" && ["render.preview", "render.video"].includes(request.params.toolId));
  const input = request.params.input as { snapshotId: string; frame?: number; startFrame?: number; durationFrames?: number };
  const receipt = t.value<any>(id), snapshot = t.value<ProjectSnapshot>(`read-${input.snapshotId}`);
  assert.equal(receipt.artifactId, `sha256:${receipt.contentHash}`);
  assert.equal(receipt.uri, `artifact://sha256/${receipt.contentHash}`);
  assert.equal(receipt.mediaType, request.params.toolId === "render.preview" ? "image/png" : "video/mp4");
  assert.equal(receipt.metadata.snapshotId, snapshot.id); assert.equal(receipt.metadata.snapshotHash, snapshot.contentHash);
  assert.equal(receipt.metadata.revisionId, snapshot.document.revisions.at(-1)!.id);
  for (const key of ["frame", "startFrame", "durationFrames"] as const) assert.equal(receipt.metadata[key], input[key]);
  return receipt;
}
function normalizedAudit(project: ProjectDocument) {
  const p = structuredClone(project);
  p.project.createdAt = p.project.updatedAt = "audit-time-omitted";
  p.revisions.forEach(r => { r.createdAt = "audit-time-omitted"; });
  return p;
}
function checkProjectsAndReports(t: Trial) {
  const before = t.value<ProjectSnapshot>("read-before"), after = t.value<ProjectSnapshot>("read-final");
  for (const s of [before, after]) {
    assert.equal(hashProject(s.document), s.contentHash);
    assert.equal(s.projectId, "ai-cache-hit");
    assert.equal(t.value<ProjectSnapshot>(`save-${s.id}`).contentHash, s.contentHash);
    const model = t.value<SnapshotInspectionReport>(`model-${s.id}`), layout = t.value<SnapshotLayoutInspectionReport>(`layout-${s.id}`);
    for (const report of [model, layout]) {
      assert.equal(report.snapshotHash, s.contentHash); assert.equal(report.revisionId, s.document.revisions.at(-1)!.id);
      assert.deepEqual(report.coverage.checkedFrames, frames); assert.equal(report.issuesTruncated, false);
    }
    assert.equal(model.outcome, "no-issues-detected"); assert.deepEqual(model.issues, []);
    assert.equal(layout.cost.encodedImageFrames, 0); assert.equal(layout.cost.visualModelCalls, 0);
    assert.equal(layout.cost.browserFrames, 6);
    if (s.id === "before") {
      assert.equal(layout.outcome, "issues-found");
      assert.deepEqual(layout.issues.map(i => [i.code, i.nodeId, i.frame]),
        [0, 90, 179].map(f => ["LAYOUT_TEXT_OVERFLOW", "hit-explanation", f]));
      assert.ok(layout.frames[0].nodes.find(n => n.nodeId === "hit-explanation")!.text!.overflowY > 0);
    } else { assert.equal(layout.outcome, "no-issues-detected"); assert.deepEqual(layout.issues, []); }
  }
  const b = normalizedAudit(before.document), a = normalizedAudit(after.document);
  assert.equal(a.revisions.length, b.revisions.length + 2);
  assert.notDeepEqual(a.nodes.find(n => n.id === "hit-explanation"), b.nodes.find(n => n.id === "hit-explanation"));
  assert.notDeepEqual(a.animationTracks.find(t => t.id === "packet-return"), b.animationTracks.find(t => t.id === "packet-return"));
  a.nodes = a.nodes.map(n => n.id === "hit-explanation" ? b.nodes.find(n => n.id === "hit-explanation")! : n);
  a.animationTracks = a.animationTracks.map(t => t.id === "packet-return" ? b.animationTracks.find(t => t.id === "packet-return")! : t);
  a.revisions = a.revisions.slice(0, -2);
  assert.deepEqual(a, b, "Only the recorded text and animation edit may change creative data");
  assert.ok(t.requests.findIndex(r => r.id === "layout-before") < t.requests.findIndex(r => r.id === "repair-text"));
  return { before, after };
}
function decode(path: string, selected: number[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "select=" + selected.map(f => `eq(n\\,${f})`).join("+"),
    "-fps_mode", "passthrough", "-frames:v", String(selected.length), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  { maxBuffer: width * height * 3 * selected.length + 1024 * 1024, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(result.stdout.length, width * height * 3 * selected.length);
  return selected.map((_, i) => result.stdout.subarray(i * width * height * 3, (i + 1) * width * height * 3));
}
function difference(a: Buffer, b: Buffer, x: number, y: number, w: number, h: number) {
  let changed = 0;
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
    const i = (py * width + px) * 3;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
  }
  return changed;
}
function packetX(pixels: Buffer) {
  let sum = 0, count = 0;
  for (let y = 270; y < 295; y++) for (let x = 285; x < 630; x++) {
    const i = (y * width + x) * 3;
    if ([92, 224, 193].every((c, k) => Math.abs(c - pixels[i + k]) < 8)) { sum += x; count++; }
  }
  assert.ok(count > 100, "Visible packet missing"); return sum / count;
}
function validateMedia(directory: string) {
  const videos = ["before", "final"].map(stage => {
    const file = join(directory, `video-${stage}.mp4`);
    const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", timeout: 30000 });
    assert.equal(probe.status, 0, probe.stderr); const metadata = JSON.parse(probe.stdout);
    assert.equal(metadata.streams.length, 1, "This trial is explicitly silent");
    const v = metadata.streams[0];
    assert.equal(v.codec_name, "h264"); assert.equal(v.width, width); assert.equal(v.height, height);
    assert.equal(v.r_frame_rate, "30/1"); assert.equal(Number(v.nb_read_frames), 360);
    assert.ok(Math.abs(Number(metadata.format.duration) - 12) < 0.05);
    const full = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { encoding: "utf8", timeout: 30000 });
    assert.equal(full.status, 0, full.stderr);
    const selected = decode(file, frames);
    selected.forEach(p => assert.ok(p.reduce((s, n) => s + n, 0) / p.length > 6, "Sampled video frame is blank"));
    return { file: `video-${stage}.mp4`, metadata, fullDecode: true, sampledFrames: frames };
  });
  const before = decode(join(directory, "preview-before-90.png"), [0])[0], after = decode(join(directory, "preview-final-90.png"), [0])[0];
  const textPixelsChanged = difference(before, after, 60, 405, 836, 80);
  assert.ok(textPixelsChanged > 500); assert.equal(difference(before, after, 60, 105, 836, 75), 0, "Unchanged title pixels moved");
  const packetBefore = packetX(before), packetAfter = packetX(after);
  assert.ok(Math.abs(packetBefore - 508.5) < 2); assert.ok(Math.abs(packetAfter - 300.5) < 2);
  for (const frame of [0, 180, 359]) decode(join(directory, `preview-final-${frame}.png`), [0]);
  return { videos, textPixelsChanged, unchangedTitlePixels: true, packetBefore, packetAfter,
    comparison: "Within each environment; no cross-environment byte-identical MP4 claim" };
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-ai-replay-"));
try {
  const manifest = await json(join(fixture, "manifest.json"));
  assert.equal(manifest.kind, "historical-interactive-model-trial");
  for (const [file, receipt] of Object.entries(manifest.files) as [string, { sha256: string; bytes: number }][]) {
    assert.match(file, /^[a-zA-Z0-9.-]+$/); const bytes = await readFile(join(fixture, file));
    assert.equal(sha(bytes), receipt.sha256, file); assert.equal(bytes.length, receipt.bytes, file);
  }
  const original = transcript(await readFile(join(fixture, "transcript.jsonl"), "utf8"));
  const config: CreativeLocalConfig = await json(join(fixture, "launch-config.json"));
  assert.deepEqual(original.records[0].data.metadata, manifest.metadata);
  assert.deepEqual(config.metadata, manifest.metadata); assert.deepEqual(original.records[0].data.grant, config.grant);
  assert.equal(original.requests.length, manifest.requestCount);
  assert.equal(original.requests.filter(r => r.method === "invoke").length, manifest.invocationCount);
  const originalProjects = checkProjectsAndReports(original);
  assert.deepEqual(await json(join(fixture, "before-snapshot.json")), originalProjects.before);
  assert.deepEqual(await json(join(fixture, "final-snapshot.json")), originalProjects.after);
  const renderRequests = original.requests.filter(r => r.method === "invoke" && ["render.preview", "render.video"].includes(r.params.toolId));
  assert.deepEqual(manifest.media.map((m: any) => m.requestId), renderRequests.map(r => r.id));
  assert.deepEqual(Object.keys(manifest.files).sort(), ["transcript.jsonl", "launch-config.json", "before-snapshot.json", "final-snapshot.json", ...manifest.media.map((m: any) => m.file)].sort());
  for (const media of manifest.media) {
    assert.deepEqual(checkRenderReceipt(original, media.requestId), media.receipt);
    assert.equal(manifest.files[media.file].sha256, media.receipt.contentHash);
  }
  const originalMedia = validateMedia(fixture);
  const tracePath = join(root, "replay.jsonl");
  await writeFile(join(root, "config.json"), JSON.stringify({ ...config, directory: join(root, "workspace"), traceFile: tracePath,
    metadata: { mode: "deterministic-replay", modelCalls: 0, originalTranscriptHash: manifest.files["transcript.jsonl"].sha256 } }));
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/creative-host-server.ts", "--config", join(root, "config.json")], {
    input: original.requests.map(r => JSON.stringify(r) + "\n").join(""), encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  await writeFile(join(output, "replay-stdout.jsonl"), child.stdout ?? "");
  await writeFile(join(output, "replay-stderr.txt"), child.stderr ?? "");
  try { await writeFile(join(output, "replay-transcript.jsonl"), await readFile(tracePath)); } catch { /* Startup failures have stderr. */ }
  assert.equal(child.status, 0, child.stderr || child.error?.message); assert.equal(child.stderr, "");
  const replay = transcript(await readFile(tracePath, "utf8")), replayProjects = checkProjectsAndReports(replay);
  assert.deepEqual(replay.requests, original.requests); assert.deepEqual(replay.catalogue, original.catalogue);
  assert.deepEqual(child.stdout.trim().split("\n").map(line => JSON.parse(line)), replay.records.filter(r => r.kind === "response").map(r => r.data));
  for (const stage of ["before", "after"] as const) {
    assert.deepEqual(normalizedAudit(replayProjects[stage].document), normalizedAudit(originalProjects[stage].document));
    await writeFile(join(output, `${stage}-snapshot.json`), JSON.stringify(replayProjects[stage], null, 2) + "\n");
  }
  const mediaReceipts = [];
  for (const media of manifest.media) {
    const receipt = checkRenderReceipt(replay, media.requestId), hash = receipt.contentHash;
    assert.match(hash, /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(root, "workspace", "artifacts", "blobs", hash.slice(0, 2), hash));
    assert.equal(sha(bytes), hash); assert.equal(receipt.artifactId, `sha256:${hash}`);
    await writeFile(join(output, media.file), bytes); mediaReceipts.push({ file: media.file, receipt });
  }
  const evidence = { status: "passed", mode: "deterministic-replay-of-historical-model-trial", newModelCalls: 0,
    originalTranscriptHash: manifest.files["transcript.jsonl"].sha256, requests: replay.requests.length,
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), node: process.version,
    sourceWorktreeDirty: Boolean(spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim()),
    auditNormalization: ["project.createdAt", "project.updatedAt", "revisions[*].createdAt"],
    original: { media: originalMedia, layoutBefore: original.value("layout-before"), layoutFinal: original.value("layout-final") },
    replay: { media: validateMedia(output), receipts: mediaReceipts, layoutBefore: replay.value("layout-before"), layoutFinal: replay.value("layout-final") },
    humanVisualReview: "pending", companionRegression: "accept:creative-loop runs separately in the same CI job" };
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Verified historical AI trial and ${replay.requests.length}-request deterministic replay; two videos and five previews per run.`);
} catch (error) {
  await writeFile(join(output, "evidence.json"), JSON.stringify({ status: "failed", mode: "deterministic-replay", error: String(error) }, null, 2) + "\n");
  throw error;
} finally { await rm(root, { recursive: true, force: true }); }
