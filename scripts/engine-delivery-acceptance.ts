import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeDeliveryReport, DeliverySnapshot } from "../src/contracts/creative-delivery";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyCreativeDelivery, verifyCreativeDeliveryRecovery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { SvgFfmpegProjectGraphRenderer } from "../src/renderers/svg-ffmpeg/svg-ffmpeg-project-graph-renderer";
import type { WaterMotionBaseline } from "./fixtures/water-motion-baseline";

const fixture = JSON.parse(await readFile("examples/water-motion-baseline.json", "utf8")) as WaterMotionBaseline;
const { snapshot, workload } = fixture;
const { projectId, document } = snapshot;
const { width, height, fps } = document.sequences[0];
const profile = { width, height, fps };
const revision = (project: ProjectDocument) => project.revisions.at(-1)!;
const approved = { id: snapshot.id, contentHash: snapshot.contentHash, revisionId: revision(document).id };
const range = workload.video;
const previewFrames = [range.startFrame, range.startFrame + Math.floor((range.durationFrames - 1) / 2), range.startFrame + range.durationFrames - 1];
const renderers = {
  remotion: { id: "remotion.project-graph", version: "1.0.0" },
  "svg-ffmpeg": { id: "svg-ffmpeg-project-graph", version: "1.0.0" },
} as const;
type Engine = keyof typeof renderers;
const output = resolve("out/engine-delivery");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-engine-delivery-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const reopenedJobs: Array<{ engine: Engine; stage: string; jobIds: string[] }> = [];
const hosts: Array<{ stage: string; engine: Engine }> = [];
const evidence: Record<string, unknown> = {
  schemaVersion: "1.0.0", status: "running", newModelCalls: 0, approved, profile, range, previewFrames, renderers, hosts, reopenedJobs,
};
let calls = 0;
const save = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, toolId);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "p1-5-d-engine-delivery", callId: `call-${++calls}` });
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function withHost<T>(engine: Engine, stage: string, work: (host: CreativeHost, session: CreativeSession) => Promise<T>) {
  const host = await openCreativeHost({ directory, ...(engine === "svg-ffmpeg" ? { renderer: new SvgFfmpegProjectGraphRenderer() } : {}) });
  hosts.push({ stage, engine });
  try {
    const session = host.createSession({ projectId, toolIds: ["project.snapshot.inspect", "render.preview", "render.video"],
      permissions: ["snapshot.read", "artifact.write"] });
    return await work(host, session);
  } finally { await host.close(); }
}

function verifyStill(bytes: Uint8Array, frame: number) {
  const png = PNG.sync.read(Buffer.from(bytes));
  assert.deepEqual([png.width, png.height], [width, height]);
  const marker = workload.markerSamples.find(item => item.frame === frame);
  const points = [...workload.swatches, ...(marker ? [{ ...marker, rgb: workload.markerRgb }] : [])];
  for (const { x, y, rgb } of points) {
    const offset = (y * width + x) * 4;
    assert.deepEqual([...png.data.subarray(offset, offset + 4)], [...rgb, 255], `Preview ${frame} at (${x}, ${y})`);
  }
}

async function verifyReceipts(host: CreativeHost, session: CreativeSession, engine: Engine, report: CreativeDeliveryReport, stage?: "original" | "restored") {
  const files = [...report.previews.map(({ frame, job }) => ({ name: `preview-${frame}.png`, frame, job })),
    { name: "delivery.mp4", frame: undefined, job: report.video.job }];
  const target = stage ? join(output, engine, stage) : undefined;
  if (target) await mkdir(target, { recursive: true });
  for (const { name, frame, job } of files) {
    assert.deepEqual(await session.jobs.get(job.id), job);
    assert.equal(job.state, "succeeded");
    assert.deepEqual(job.input.renderer, renderers[engine]);
    assert.deepEqual(job.input.snapshot, report.snapshot);
    assert.deepEqual(job.input.profile, profile);
    assert.deepEqual(job.input.render, frame === undefined ? { operation: "video", ...range } : { operation: "preview", frame });
    assert.ok(job.result);
    assert.equal(job.result.rendererId, renderers[engine].id);
    assert.equal(job.result.rendererVersion, renderers[engine].version);
    assert.equal(job.result.inputHash, job.inputHash);
    const retained = await host.maintenance.renderJobs.inspect(projectId, job.id);
    assert.ok(retained && "output" in retained && retained.output?.availability === "verified" && retained.output.referenceAttached);
    const bytes = await readVerifiedJobArtifact(artifacts, job.result);
    assert.ok(bytes);
    if (target) {
      if (frame !== undefined) verifyStill(bytes, frame);
      await writeFile(join(target, name), bytes);
    }
  }
  if (!stage) reopenedJobs.push({ engine, stage: hosts.at(-1)!.stage, jobIds: files.map(item => item.job.id) });
}

function checkDelivery(report: CreativeDeliveryReport, approval: DeliverySnapshot) {
  assert.deepEqual(report.snapshot, approval);
  assert.deepEqual(report.profile, profile);
  assert.deepEqual(report.range, range);
  assert.deepEqual(report.selection.frames.map(item => item.frame), previewFrames);
  assert.deepEqual(report.previews.map(item => item.frame), previewFrames);
  assert.equal(report.video.decoded.frames, range.durationFrames);
  assert.equal(report.video.decoded.durationSeconds, range.durationFrames / fps);
  assert.equal(report.video.decoded.codec, "h264");
  assert.equal(report.video.decoded.audio, undefined);
}

async function deliver(host: CreativeHost, session: CreativeSession, engine: Engine) {
  const report = await verifyCreativeDelivery(session, artifacts, { approved, range, maxPreviewFrames: previewFrames.length });
  checkDelivery(report, approved);
  await verifyReceipts(host, session, engine, report, "original");
  await save(`${engine}/original.json`, report);
  return report;
}

async function recover(host: CreativeHost, session: CreativeSession, engine: Engine, reference: CreativeDeliveryReport, restored: DeliverySnapshot) {
  const recovery = await verifyCreativeDeliveryRecovery(session, artifacts, { reference, restored });
  checkDelivery(recovery.restored, restored);
  assert.deepEqual(recovery.sourceSnapshot, approved);
  assert.deepEqual(recovery.comparison, { previewFrames, rgbHash: reference.video.decoded.rgbHash });
  assert.deepEqual(recovery.restored.previews.map(item => item.rgbaHash), reference.previews.map(item => item.rgbaHash));
  const priorJobIds = new Set([reference.video.job.id, ...reference.previews.map(item => item.job.id)]);
  assert.ok([recovery.restored.video.job, ...recovery.restored.previews.map(item => item.job)].every(job => !priorJobIds.has(job.id)));
  await verifyReceipts(host, session, engine, recovery.restored, "restored");
  await save(`${engine}/recovery.json`, recovery);
  return recovery;
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(hashProject(document), approved.contentHash);
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  try {
    await workspace.create(document);
    assert.deepEqual(await workspace.saveSnapshot(projectId, approved.revisionId, { id: approved.id, createdAt: snapshot.createdAt }), snapshot);
  } finally { await workspace.close(); }

  const originalRemotion = await withHost("remotion", "original-remotion", (host, session) => deliver(host, session, "remotion"));
  const { originalSvg, draft } = await withHost("svg-ffmpeg", "original-svg-and-edit", async (host, session) => {
    const originalSvg = await deliver(host, session, "svg-ffmpeg");
    assert.deepEqual(originalSvg.selection, originalRemotion.selection);
    assert.equal(originalSvg.renderContentHash, originalRemotion.renderContentHash);
    await verifyReceipts(host, session, "remotion", originalRemotion);

    const editor = host.createSession({ projectId, toolIds: ["graphics.2d.shape.create", "project.snapshot.save"],
      permissions: ["project.read", "project.write", "snapshot.write"] });
    const edited = await invoke<{ revisionId: string }>(editor, "graphics.2d.shape.create", {
      sceneId: fixture.source.sceneId, nodeId: "changed-for-restore", primitive: "rect", x: 16, y: 16, width: 24, height: 24, fill: "#ff5500",
    });
    const saved = await invoke<SnapshotReceipt>(editor, "project.snapshot.save", { snapshotId: "different-draft", revisionId: edited.revisionId });
    assert.notEqual(saved.contentHash, approved.contentHash);
    const preview = await invoke<{ artifactId: string; contentHash: string; metadata: Record<string, unknown> }>(session, "render.preview",
      { snapshotId: saved.id, frame: workload.previewFrame });
    assert.deepEqual(preview.metadata, { snapshotId: saved.id, snapshotHash: saved.contentHash, revisionId: edited.revisionId, frame: workload.previewFrame,
      ...profile, rendererId: renderers["svg-ffmpeg"].id, rendererVersion: renderers["svg-ffmpeg"].version });
    const bytes = await artifacts.read(preview.artifactId);
    assert.ok(bytes);
    assert.equal(digest(bytes), preview.contentHash);
    const png = PNG.sync.read(Buffer.from(bytes));
    const background = workload.swatches.find(point => point.name === "background")!;
    const offset = (background.y * width + background.x) * 4;
    const changedPixel = [...png.data.subarray(offset, offset + 4)];
    assert.deepEqual(changedPixel, [255, 85, 0, 255]);
    await writeFile(join(output, "different-draft.png"), bytes);
    const draft = { id: saved.id, revisionId: edited.revisionId, contentHash: saved.contentHash };
    evidence.draft = { snapshot: draft, preview, pixel: { x: background.x, y: background.y, before: [...background.rgb, 255], changed: changedPixel } };
    return { originalSvg, draft };
  });

  const { restored, recoveredRemotion } = await withHost("remotion", "restore-and-recover-remotion", async (host, session) => {
    await verifyReceipts(host, session, "svg-ffmpeg", originalSvg);
    const approver = host.createSession({ projectId, toolIds: ["project.snapshot.restore", "project.snapshot.save"],
      permissions: ["project.read", "project.write", "snapshot.restore", "snapshot.write"], allowDestructive: true });
    const restoredDocument = await invoke<ProjectDocument>(approver, "project.snapshot.restore",
      { snapshotId: approved.id, baseRevisionId: draft.revisionId, message: "Restore the paired engine delivery checkpoint" });
    assert.equal(revision(restoredDocument).parentRevisionId, draft.revisionId);
    assert.equal(revision(restoredDocument).snapshotHash, approved.contentHash);
    const saved = await invoke<SnapshotReceipt>(approver, "project.snapshot.save", { snapshotId: "restored-water-motion", revisionId: revision(restoredDocument).id });
    assert.equal(hashProject(restoredDocument), saved.contentHash);
    assert.notEqual(saved.contentHash, approved.contentHash);
    const restored = { id: saved.id, revisionId: revision(restoredDocument).id, contentHash: saved.contentHash };
    evidence.restore = { snapshot: restored, revision: revision(restoredDocument) };
    return { restored, recoveredRemotion: await recover(host, session, "remotion", originalRemotion, restored) };
  });

  const recoveredSvg = await withHost("svg-ffmpeg", "recover-svg", async (host, session) => {
    assert.deepEqual(await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: approved.id }), snapshot);
    const edited = await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: draft.id });
    assert.equal(edited.contentHash, draft.contentHash);
    assert.equal(hashProject(edited.document), draft.contentHash);
    await verifyReceipts(host, session, "remotion", recoveredRemotion.restored);
    return recover(host, session, "svg-ffmpeg", originalSvg, restored);
  });
  assert.equal(recoveredSvg.restored.renderContentHash, recoveredRemotion.restored.renderContentHash);
  evidence.comparisons = { remotion: recoveredRemotion.comparison, "svg-ffmpeg": recoveredSvg.comparison };
  evidence.status = "passed";
  console.log(`Verified delivery and recovery with both engines on ${approved.id}, frames [${previewFrames.join(", ")}] and ${range.durationFrames} video frames each.`);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await save("evidence.json", evidence); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
