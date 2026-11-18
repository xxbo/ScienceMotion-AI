import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativeJobSubmission } from "../src/contracts/creative-jobs";
import type { ProjectDocument } from "../src/contracts/project";
import type { ProjectPatchDocument, ProjectPatchResult } from "../src/contracts/project-patch";
import type { RenderJobRecord } from "../src/contracts/render-job";
import type { RenderWorkerEvent } from "../src/contracts/render-worker";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import { createEmptyProject } from "../src/platform/empty-project";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { approvedBriefPlugin, createApprovedBriefPlugin } from "./fixtures/approved-brief-plugin";
import { assertReaped, processes, stillOwned } from "./fixtures/owned-processes";

assert.equal(process.platform, "linux");
const root = await mkdtemp(join(tmpdir(), "sciencemotion-maintenance-"));
const directory = join(root, "host"), temporary = join(root, "temporary");
const output = resolve("out/render-job-maintenance"), previousTemporary = process.env.TMPDIR;
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const width = 640, height = 360, fps = 30, durationFrames = 360;
const originalData = [{ label: "A", value: 12 }, { label: "B", value: 4 }];
const editedData = [{ label: "A", value: 4 }, { label: "B", value: 12 }];
const cyan = "#55d6e8", orange = "#ffb454", green = "#8be28b", background = "#07111f";
const editor = "editing", other = "other";
const events: RenderWorkerEvent[] = [];
const evidence: Record<string, unknown> = {
  schemaVersion: "1.0.0", scenario: "C3 concurrent editing and maintenance with real render workers", status: "running", events,
};
const nextPlugin = createApprovedBriefPlugin("1.1.0");
const pluginTool = "acceptance.brief.attach";
let host: CreativeHost | undefined, calls = 0;
let activation: { eventIndex: number; jobs: Pick<RenderJobRecord, "id" | "state" | "result">[] } | undefined;

function actor(host: CreativeHost, projectId: string) {
  return host.createSession({ projectId, allowDestructive: true,
    permissions: ["project.read", "project.write", "project.delete", "snapshot.read", "snapshot.write", "artifact.read", "artifact.write"],
    toolIds: ["project.create", "project.scene.create", "project.inspect", "project.patch.apply", "project.patch.remove",
      "project.snapshot.save", "render.video", "render.preview", pluginTool] });
}

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown): Promise<T> {
  const result = await session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "maintenance", callId: `edit-${++calls}` });
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function createChart(session: CreativeSession, fill: string, assetId?: string) {
  await invoke(session, "project.scene.create", { sceneId: "scene", name: "Snapshot chart", durationFrames });
  const document = await invoke<ProjectDocument>(session, "project.inspect", {});
  const patch: ProjectPatchDocument = { schemaVersion: "1.3.0", projectId: session.projectId, baseRevisionId: document.revisions.at(-1)!.id,
    patches: [{ op: "add-node", sceneId: "scene", node: { id: "chart", name: "Sample data", type: "shape",
      transform: { position: [60, 56, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ kind: "geometry", data: { primitive: "chart", chartType: "bar", chartData: originalData,
        width: 520, height: 260, fill, fontSize: 16, ...(assetId ? { assetId } : {}) } }] } }] };
  return (await invoke<ProjectPatchResult>(session, "project.patch.apply", patch)).project;
}

function saveSnapshot(session: CreativeSession, snapshotId: string, document: ProjectDocument) {
  return invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId, revisionId: document.revisions.at(-1)!.id });
}

function assertSnapshot(record: RenderJobRecord, snapshot: SnapshotReceipt, project: ProjectDocument) {
  assert.equal(record.input.projectId, snapshot.projectId);
  assert.deepEqual(record.input.snapshot, { id: snapshot.id, contentHash: snapshot.contentHash, revisionId: project.revisions.at(-1)!.id });
}

const video = (id: string, snapshotId: string): CreativeJobSubmission => ({
  submissionId: id, runId: "maintenance", callId: id, toolVersion: "1.0.0", toolId: "render.video",
  input: { snapshotId, startFrame: 0, durationFrames },
});
const preview = (id: string, snapshotId: string): CreativeJobSubmission => ({
  submissionId: id, runId: "maintenance", callId: id, toolVersion: "1.0.0", toolId: "render.preview", input: { snapshotId, frame: 0 },
});

async function waitForJob(session: CreativeSession, id: string, ready: (record: RenderJobRecord) => boolean) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const record = await session.jobs.get(id);
    assert.ok(record);
    if (ready(record)) return record;
    assert.ok(["queued", "running", "publishing"].includes(record.state), JSON.stringify(record));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${id} did not reach the expected state`);
}

async function liveVideo(session: CreativeSession, id: string) {
  const record = await waitForJob(session, id, item => item.state === "running" &&
    item.progress?.phase === "rendering" && (item.progress.fraction ?? 0) > 0);
  const event = events.find(item => item.operation === "video" && item.projectId === record.input.projectId &&
    item.snapshotHash === record.input.snapshot.contentHash && item.progress?.phase === "rendering" &&
    (item.progress.fraction ?? 0) > 0);
  assert.ok(event?.processId, "Expected real worker progress from the admitted snapshot");
  const tree = processes(event.processId), guardian = tree.find(process => process.pid === event.processId);
  assert.ok(guardian && tree.some(process => /chrome/i.test(process.command)), "Expected a live owned Chromium tree");
  return { record, event, tree, guardian };
}

async function noTemporaryJobs() {
  assert.deepEqual(await readdir(temporary), [], "Private worker temporary directory is not empty");
}

function chartPixels(path: string, frame: number, colors: readonly [string, string], tolerance: number) {
  const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", `select=eq(n\\,${frame})`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-threads", "1", "pipe:1"],
  { maxBuffer: width * height * 3 + 1024 * 1024, timeout: 15000 });
  assert.equal(pixels.length, width * height * 3);
  return [240, 456].map((x, index) => {
    const y = 115, offset = (y * width + x) * 3;
    const actual = [...pixels.subarray(offset, offset + 3)], expected = [...Buffer.from(colors[index].slice(1), "hex")];
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance),
      `${path} frame ${frame}, chart pixel (${x}, ${y}): expected ${expected}, got ${actual}`);
    return { frame, x, y, expected, actual, tolerance };
  });
}

async function verifiedOutput(record: RenderJobRecord, file: string, colors: readonly [string, string]) {
  const receipt = record.result;
  assert.equal(record.state, "succeeded");
  assert.ok(receipt);
  assert.equal(receipt.jobId, record.id);
  assert.equal(receipt.inputHash, record.inputHash);
  const artifact = await artifacts.get(receipt.artifactId), bytes = await artifacts.read(receipt.artifactId);
  assert.ok(artifact && bytes);
  assert.equal(artifact.metadata?.jobId, record.id);
  assert.equal(artifact.metadata?.snapshotHash, record.input.snapshot.contentHash);
  assert.equal(artifact.metadata?.revisionId, record.input.snapshot.revisionId);
  assert.equal(artifact.provenance?.projectId, record.input.projectId);
  assert.equal(bytes.byteLength, receipt.sizeBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.contentHash);
  const execution = artifact.metadata?.execution as { kind: string; jobId: string } | undefined;
  assert.equal(execution?.kind, "local-process");
  const completedIndex = events.findIndex(event => event.jobId === execution?.jobId && event.state === "completed");
  assert.ok(completedIndex >= 0);
  const path = join(output, file);
  await writeFile(path, bytes);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path],
    { encoding: "utf8", timeout: 10000 }));
  const stream = probe.streams.find((item: { codec_type: string }) => item.codec_type === "video");
  assert.ok(stream);
  assert.equal(stream.width, width);
  assert.equal(stream.height, height);
  let pixels;
  if (record.input.render.operation === "video") {
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.r_frame_rate, `${fps}/1`);
    assert.equal(Number(stream.nb_frames), durationFrames);
    pixels = [0, durationFrames - 1].flatMap(frame => chartPixels(path, frame, colors, 24));
  } else {
    assert.equal(stream.codec_name, "png");
    pixels = chartPixels(path, 0, colors, 6);
  }
  return { file, record, artifact, pixels, completedIndex };
}

try {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await mkdir(temporary);
  process.env.TMPDIR = temporary;

  const source = await artifacts.put({ bytes: Buffer.from(JSON.stringify(originalData)), kind: "data", mediaType: "application/json" });
  const unreferenced = await artifacts.put({ bytes: Buffer.from("C3 GC control"), kind: "data", mediaType: "text/plain" });
  // Seed a local data source without a tool-run owner, so only the old snapshot can retain it after the edit.
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  const assetId = "original-chart-data";
  try {
    const document = createEmptyProject({ id: editor, name: "Concurrent edit", episodeId: "maintenance-fixture", width, height, fps, durationFrames });
    document.assets.push({ id: assetId, kind: "data", uri: source.uri, contentHash: source.contentHash });
    await workspace.create(document);
  } finally { await workspace.close(); }

  host = await openCreativeHost({ directory, plugins: [approvedBriefPlugin], renderWorker: {},
    renderJobs: { maxConcurrentJobs: 1, maxQueuedJobs: 1 }, onRenderWorkerEvent: event => events.push(event) });
  const editingSession = actor(host, editor), peerSession = actor(host, other);
  await invoke(peerSession, "project.create", { name: "Isolated project", episodeId: "maintenance-peer", width, height, fps, durationFrames });
  const original = await createChart(editingSession, cyan, assetId), peer = await createChart(peerSession, green);
  const s = await saveSnapshot(editingSession, "s", original), peerSnapshot = await saveSnapshot(peerSession, "other-snapshot", peer);
  assert.equal((await editingSession.manifest(pluginTool))?.version, approvedBriefPlugin.version);
  const installed = host.plugins.install({ ...nextPlugin, create(services) {
    const plugin = nextPlugin.create(services);
    return { ...plugin, async healthCheck() {
      const eventIndex = events.length;
      const ledger = JSON.parse(await readFile(join(directory, "jobs", "jobs.json"), "utf8")) as { records: RenderJobRecord[] };
      activation = { eventIndex, jobs: ledger.records.map(({ id, state, result }) => ({ id, state, result })) };
      return plugin.healthCheck!();
    } };
  } });
  assert.ok(installed.ok);

  const old = (await editingSession.jobs.submit(video("old-snapshot", s.id))).record;
  const active = await liveVideo(editingSession, old.id);
  evidence.oldJob = { admitted: old, active, snapshot: s, source };
  const geometry = original.nodes.find(node => node.id === "chart")!.components[0];
  const { assetId: reference, ...data } = geometry.data;
  assert.equal(reference, assetId);
  const edited = (await invoke<ProjectPatchResult>(editingSession, "project.patch.remove", {
    schemaVersion: "1.3.0", projectId: editor, baseRevisionId: original.revisions.at(-1)!.id,
    patches: [{ op: "update-node", nodeId: "chart", changes: { components: [{ ...geometry, data: { ...data, fill: orange, chartData: editedData } }] } },
      { op: "remove-asset", assetId }],
  })).project;
  const s2 = await saveSnapshot(editingSession, "s2", edited);
  assert.notEqual(s.contentHash, s2.contentHash);
  assert.deepEqual(edited.assets, []);

  assert.equal(await peerSession.jobs.get(old.id), undefined);
  await assert.rejects(peerSession.jobs.cancel(old.id), { code: "RENDER_JOB_NOT_FOUND" });
  await assert.rejects(peerSession.jobs.submit(preview("foreign-snapshot", s2.id)), { code: "HOST_SNAPSHOT_DENIED" });
  assert.deepEqual((await peerSession.jobs.list()).jobs, []);
  assert.deepEqual(await invoke<ProjectDocument>(peerSession, "project.inspect", {}), peer);

  const newer = (await editingSession.jobs.submit(preview("new-snapshot", s2.id))).record;
  const overflow = preview("peer-preview", peerSnapshot.id);
  await assert.rejects(peerSession.jobs.submit(overflow), { code: "HOST_JOB_CAPACITY" });
  const pinned = await host.maintenance.renderJobs.inspect(editor, old.id);
  assert.ok(pinned && "record" in pinned);
  assert.deepEqual(pinned.input, { retained: true, pinnedByJob: true, artifactIds: [source.id] });
  const sourceReferences = await references.list({ artifactId: source.id });
  assert.deepEqual(sourceReferences.map(ref => ref.ownerType), ["snapshot"]);
  await assert.rejects(host.maintenance.releaseSnapshot(editor, s.id), { code: "HOST_SNAPSHOT_RETAINED" });
  const during = await host.maintenance.collectGarbage(0);
  assert.deepEqual(during.deleted, [unreferenced.id]);
  assert.deepEqual(during.errors, []);
  const retainedBytes = await artifacts.read(source.id);
  assert.ok(retainedBytes);
  assert.deepEqual(Buffer.from(retainedBytes), Buffer.from(JSON.stringify(originalData)));
  const afterEdit = await editingSession.jobs.get(old.id);
  assert.ok(afterEdit && afterEdit.state === "running", "Old job must still be running after edits and GC");
  assertSnapshot(afterEdit, s, original);
  assert.equal((await editingSession.jobs.get(newer.id))?.state, "queued");
  assert.equal(await stillOwned(active.guardian), true);
  const currentWorker = events.filter(event => event.jobId === active.event.jobId).at(-1);
  assert.equal(currentWorker?.progress?.phase, "rendering");
  evidence.concurrentEdit = { s2, afterEdit, currentWorker, pinned, sourceReferences, during, blockedRelease: "HOST_SNAPSHOT_RETAINED" };

  const switchEventIndex = events.length;
  const switching = host.plugins.activate(nextPlugin.id, nextPlugin.version);
  void switching.catch(() => undefined);
  assert.equal(host.status().state, "switching");
  await assert.rejects(peerSession.jobs.submit(overflow), { code: "HOST_PLUGIN_SWITCHING" });
  await assert.rejects(async () => host!.maintenance.collectGarbage(0), { code: "HOST_PLUGIN_SWITCHING" });
  const activated = await switching;
  assert.ok(activated.ok);
  assert.equal((await editingSession.manifest(pluginTool))?.version, nextPlugin.version);
  const oldDone = await editingSession.jobs.get(old.id), newDone = await editingSession.jobs.get(newer.id);
  assert.ok(oldDone && newDone);
  const firstOutput = await verifiedOutput(oldDone, "snapshot-s.mp4", [cyan, background]);
  const secondOutput = await verifiedOutput(newDone, "snapshot-s2.png", [background, orange]);
  assertSnapshot(oldDone, s, original);
  assertSnapshot(newDone, s2, edited);
  const previewStarted = events.findIndex(event => event.snapshotHash === s2.contentHash && event.state === "starting");
  assert.ok(activation && switchEventIndex <= previewStarted && firstOutput.completedIndex < previewStarted &&
    previewStarted < secondOutput.completedIndex && secondOutput.completedIndex < activation.eventIndex);
  assert.deepEqual(activation.jobs.map(job => job.id).sort(), [oldDone.id, newDone.id].sort());
  for (const { id, state, result } of [oldDone, newDone])
    assert.deepEqual(activation.jobs.find(job => job.id === id), { id, state, result }, "Publication must settle before candidate health check");
  await assertReaped(active.tree);
  await noTemporaryJobs();
  evidence.pluginTransition = { pending: newer, activated, switchEventIndex, previewStarted, activation,
    blocked: ["HOST_JOB_CAPACITY", "HOST_PLUGIN_SWITCHING"], firstOutput, secondOutput };
  console.log("PASS concurrent edit and plugin drain: live old snapshot, new pixels, retained source and bounded queue");

  const peerJob = await peerSession.jobs.submit(overflow);
  assert.equal(peerJob.created, true, "Saturation must not reserve a submission identity");
  const peerDone = await waitForJob(peerSession, peerJob.record.id, record => record.state === "succeeded");
  assertSnapshot(peerDone, peerSnapshot, peer);
  assert.equal(await editingSession.jobs.get(peerDone.id), undefined);
  assert.deepEqual(await invoke<ProjectDocument>(peerSession, "project.inspect", {}), peer);
  const peerOutput = await verifiedOutput(peerDone, "other-project.png", [green, background]);
  const released = await host.maintenance.renderJobs.release(editor, oldDone.id);
  assert.ok(released.completedAt);
  await host.maintenance.releaseSnapshot(editor, s.id);
  const collected = await host.maintenance.collectGarbage(0);
  assert.deepEqual(collected.deleted.sort(), [source.id, oldDone.result!.artifactId].sort());
  assert.deepEqual(collected.errors, []);
  assert.equal(await artifacts.get(source.id), undefined);
  const remaining = [newDone.result!.artifactId, peerDone.result!.artifactId].sort();
  assert.deepEqual((await artifacts.list()).map(artifact => artifact.id).sort(), remaining);
  evidence.retentionRelease = { released, collected, remaining, peerOutput };

  const runningAtClose = (await peerSession.jobs.submit(video("close-running", peerSnapshot.id))).record;
  const queuedAtClose = (await editingSession.jobs.submit(preview("close-waiting", s2.id))).record;
  await assert.rejects(peerSession.jobs.submit(preview("close-overflow", peerSnapshot.id)), { code: "HOST_JOB_CAPACITY" });
  const closingWorker = await liveVideo(peerSession, runningAtClose.id);
  assert.equal((await editingSession.jobs.get(queuedAtClose.id))?.state, "queued");
  const closed = host.close();
  void closed.catch(() => undefined);
  assert.equal(host.status().state, "draining");
  await assert.rejects(editingSession.jobs.submit(preview("close-denied", s2.id)), { code: "HOST_CLOSED" });
  await closed;
  assert.equal(host.status().state, "closed");
  assert.equal(events.find(event => event.jobId === closingWorker.event.jobId && event.state === "cancelled")?.code, "RENDER_WORKER_CANCELLED");
  assert.equal(events.filter(event => event.state === "starting").length, 4);
  await assertReaped(closingWorker.tree);
  await noTemporaryJobs();
  assert.deepEqual((await artifacts.list()).map(artifact => artifact.id).sort(), remaining);
  evidence.hostClose = { runningAtClose, queuedAtClose, closingWorker, blocked: ["HOST_JOB_CAPACITY", "HOST_CLOSED"], remaining };

  host = await openCreativeHost({ directory, plugins: [nextPlugin] });
  const reopenedEditor = actor(host, editor), reopenedPeer = actor(host, other);
  assert.equal((await reopenedEditor.manifest(pluginTool))?.version, nextPlugin.version);
  assert.deepEqual(await invoke<ProjectDocument>(reopenedEditor, "project.inspect", {}), edited);
  assert.deepEqual(await invoke<ProjectDocument>(reopenedPeer, "project.inspect", {}), peer);
  for (const [session, record] of [[reopenedEditor, oldDone], [reopenedEditor, newDone], [reopenedPeer, peerDone]] as const)
    assert.deepEqual(await session.jobs.get(record.id), record);
  const oldRetained = await host.maintenance.renderJobs.inspect(editor, oldDone.id);
  assert.ok(oldRetained && "record" in oldRetained);
  assert.deepEqual(oldRetained.retention.release, released);
  assert.deepEqual(oldRetained.input, { retained: false, pinnedByJob: false, artifactIds: [] });
  assert.equal(oldRetained.output?.availability, "missing");
  const cancelled = [(await reopenedPeer.jobs.get(runningAtClose.id))!, (await reopenedEditor.jobs.get(queuedAtClose.id))!];
  for (const [index, record] of cancelled.entries()) {
    assert.deepEqual(record.input, [runningAtClose, queuedAtClose][index].input);
    assert.equal(record.state, "cancelled");
    assert.equal(record.result, undefined);
    assert.equal(record.outcomeUnknown, false);
  }
  assert.ok(cancelled[0].startedAt);
  assert.equal(cancelled[1].startedAt, undefined);
  assert.equal((await reopenedEditor.jobs.list()).total, 3);
  assert.equal((await reopenedPeer.jobs.list()).total, 2);
  await host.close();
  Object.assign(evidence, { status: "passed", reopened: { exactSuccessRecords: true, cancelled, oldRetained, remaining },
    observedProcessesReaped: true, privateTemporaryDirectoryEmpty: true });
  console.log("PASS retention release and close under load: scoped GC, real worker reaped, durable results and cancellations");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    if (previousTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemporary;
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
