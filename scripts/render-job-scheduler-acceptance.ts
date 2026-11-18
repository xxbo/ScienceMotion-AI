import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { CreativeJobSubmission } from "../src/contracts/creative-jobs";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import type { RenderWorkerEvent } from "../src/contracts/render-worker";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { processes, assertReaped, type ObservedProcess } from "./fixtures/owned-processes";

assert.equal(process.platform, "linux");
const root = await mkdtemp(join(tmpdir(), "sciencemotion-scheduler-")), temporary = join(root, "temporary");
const output = resolve("out/render-job-scheduler"), directory = join(root, "host"), oldTemporary = process.env.TMPDIR;
const events: RenderWorkerEvent[] = [], active = new Map<string, RenderWorkerEvent>(), records: RenderJobRecord[] = [];
let host: CreativeHost | undefined, sequence = 0, peak = 0, observedAt = 0, callbackFailure: unknown;
let overlap: Array<{ event: RenderWorkerEvent; tree: ObservedProcess[] }> | undefined;
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", scenario: "C1 actual concurrent worker jobs with a bounded waiting queue", status: "running" };
const actor = (projectId: string) => host!.createSession({ projectId,
  permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create", "project.snapshot.save", "render.video", "render.preview"] });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown): Promise<T> {
  const result = await session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "scheduler", callId: String(++sequence) });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.output as T;
}
async function seed(projectId: string, color: string) {
  const s = actor(projectId);
  for (const [toolId, input] of [
    ["project.create", { name: projectId, episodeId: "scheduler-fixture", durationFrames: 180, width: 640, height: 360, fps: 30 }],
    ["project.scene.create", { sceneId: "scene", name: projectId, durationFrames: 180 }],
    ["graphics.2d.text.create", { sceneId: "scene", nodeId: "title", text: "Concurrent render " + projectId, x: 40, y: 40, fontSize: 36, width: 560, height: 80 }],
    ["graphics.2d.shape.create", { sceneId: "scene", nodeId: "shape", primitive: "circle", x: 260, y: 160, width: 120, height: 120, fill: color }],
  ] as Array<[string, unknown]>) await invoke(s, toolId, input);
  const project = await invoke<ProjectDocument>(s, "project.inspect", {});
  await invoke(s, "project.snapshot.save", { snapshotId: "snapshot-" + projectId, revisionId: project.revisions.at(-1)!.id }); return s;
}
const request = (projectId: string, id: string, preview = false): CreativeJobSubmission => ({
  submissionId: id, runId: "scheduler", callId: id, toolVersion: "1.0.0",
  ...(preview ? { toolId: "render.preview", input: { snapshotId: "snapshot-" + projectId, frame: 30 } }
    : { toolId: "render.video", input: { snapshotId: "snapshot-" + projectId, startFrame: 0, durationFrames: 180 } }),
});
async function completed(s: CreativeSession, id: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const record = (await s.jobs.get(id))!;
    if (record.state === "succeeded") return record;
    assert.ok(["queued", "running", "publishing"].includes(record.state), JSON.stringify(record));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Concurrent worker did not complete");
}
try {
  await mkdir(temporary); process.env.TMPDIR = temporary;
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  host = await openCreativeHost({ directory, renderJobs: { maxConcurrentJobs: 2, maxQueuedJobs: 1 }, renderWorker: { maxConcurrentJobs: 2 },
    onRenderWorkerEvent: event => {
      events.push(event);
      if (["starting", "running"].includes(event.state)) {
        active.set(event.jobId, { ...active.get(event.jobId), ...event, progress: event.progress ?? active.get(event.jobId)?.progress });
        peak = Math.max(peak, active.size);
      } else active.delete(event.jobId);
      if (!overlap && active.size === 2 && event.progress?.phase === "rendering" && (event.progress.fraction ?? 0) > 0 && Date.now() - observedAt > 100) {
        observedAt = Date.now();
        try {
          const candidates = [...active.values()].map(value => ({ event: value, tree: processes(value.processId!) }));
          if (candidates.every(value => value.tree.some(p => /chrome/i.test(p.command)))) overlap = candidates;
        } catch (error) { callbackFailure = error; }
      }
    } });
  const a = await seed("a", "#55d6e8"), b = await seed("b", "#ffb454");
  const first = await a.jobs.submit(request("a", "video-a")), second = await b.jobs.submit(request("b", "video-b"));
  const queued = await a.jobs.submit(request("a", "queued-preview", true)); assert.equal(queued.record.state, "queued");
  await assert.rejects(b.jobs.submit(request("b", "overflow", true)), { code: "HOST_JOB_CAPACITY" });
  assert.equal((await a.jobs.submit(request("a", "queued-preview", true))).created, false);
  records.push(...await Promise.all([completed(a, first.record.id), completed(b, second.record.id), completed(a, queued.record.id)]));
  if (callbackFailure) throw callbackFailure;
  const observed = overlap as Array<{ event: RenderWorkerEvent; tree: ObservedProcess[] }> | undefined;
  assert.equal(peak, 2); assert.ok(observed, "Observe two live owned Chromium trees at the same time"); assert.equal(active.size, 0);
  const starts = events.filter(event => event.state === "starting");
  assert.equal(starts.length, 3); assert.deepEqual(starts.slice(0, 2).map(event => event.projectId).sort(), ["a", "b"]);
  assert.equal(starts[2].operation, "preview");
  assert.ok(events.slice(0, events.indexOf(starts[2])).some(event => event.state === "completed"), "Waiting work needs a released execution slot");
  await assertReaped(observed.flatMap(value => value.tree));
  assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith("sciencemotion-worker-")), []);
  const artifacts = new FileSystemArtifactStore(join(directory, "artifacts")), outputs = [];
  for (const record of records) {
    const receipt = record.result!, artifact = await artifacts.get(receipt.artifactId), data = await artifacts.read(receipt.artifactId);
    assert.ok(artifact && data); const bytes = Buffer.from(data);
    assert.equal(receipt.jobId, record.id); assert.equal(receipt.inputHash, record.inputHash); assert.equal(bytes.length, receipt.sizeBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.contentHash);
    assert.equal(artifact.metadata!.jobId, record.id); assert.equal(artifact.metadata!.snapshotHash, record.input.snapshot.contentHash);
    assert.equal((artifact.metadata!.execution as { kind: string }).kind, "local-process");
    const preview = record.input.render.operation === "preview", file = preview ? "queued-preview.png" : record.input.projectId + ".mp4";
    await writeFile(join(output, file), bytes);
    if (preview) { assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(bytes.readUInt32BE(16), 640); assert.equal(bytes.readUInt32BE(20), 360); }
    else {
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", join(output, file)], { encoding: "utf8", timeout: 10000 }));
      const video = probe.streams.find((value: { codec_type: string }) => value.codec_type === "video");
      assert.equal(video.width, 640); assert.equal(video.height, 360); assert.equal(video.r_frame_rate, "30/1"); assert.equal(Number(video.nb_frames), 180);
      assert.ok(Math.abs(Number(probe.format.duration) - 6) < 0.1);
    }
    outputs.push({ file, record, artifact });
  }
  assert.notEqual(records[0].result!.contentHash, records[1].result!.contentHash);
  await host.close(); host = await openCreativeHost({ directory });
  for (const record of records) assert.deepEqual(await actor(record.input.projectId).jobs.get(record.id), record);
  assert.equal((await actor("a").jobs.list()).total, 2); assert.equal((await actor("b").jobs.list()).total, 1);
  Object.assign(evidence, { status: "passed", peakWorkers: peak, overlap, outputs, events, processCleanup: true, temporaryCleanup: true, exactResultsAfterReopen: true,
    scope: "C1 scheduling and parallel output evidence. C3 covers concurrent editing and maintenance. D covers aggregate resource enforcement." });
  console.log("PASS scheduler: two live Chromium worker trees, peak 2, bounded queue, 2 x 180-frame MP4 + PNG, cleanup and exact reopened results");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error), peakWorkers: peak, overlap, records, events }); throw error;
} finally {
  try { await host?.close(); }
  finally {
    if (oldTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemporary;
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
