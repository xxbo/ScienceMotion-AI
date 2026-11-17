import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreativeLocalConfig } from "../src/contracts/creative-client";
import type { CreativeJobSubmission } from "../src/contracts/creative-jobs";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { CreativeCli } from "./fixtures/creative-cli";
import { assertReaped, processes, stillOwned, waitReaped } from "./fixtures/owned-processes";

assert.equal(process.platform, "linux");
assert.equal(process.env.SCIENCEMOTION_OWNED_HARNESS, String(process.ppid), "Run npm run accept:render-jobs so orphaned guardians have a reaping owner");
const root = await mkdtemp(join(tmpdir(), "sciencemotion-job-cli-"));
const output = resolve("out/render-job-cli"), temporary = join(root, "temporary"), directory = join(root, "host");
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const clients: CreativeCli[] = [], evidence: Record<string, unknown> = { schemaVersion: "1.0.0", scenario: "B3 real protocol-1.1 worker lifecycle", status: "running" };
let sequence = 0;
const save = async (key: string, value: unknown) => { evidence[key] = value; await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n"); };
async function launch(name: string) {
  const config: CreativeLocalConfig = { schemaVersion: "1.0.0", protocolVersion: "1.1.0", directory, traceFile: join(output, `${name}-trace.jsonl`), renderWorker: {},
    grant: { projectId: "job-cli", permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write"],
      toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create", "project.snapshot.save", "render.preview", "render.video"] } };
  const path = join(output, `${name}-config.json`); await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  const client = new CreativeCli(path, temporary); clients.push(client); return client;
}
async function ready(client: CreativeCli) {
  const message = await client.ready;
  assert.equal(message.protocolVersion, "1.1.0"); assert.equal(message.jobsVersion, "1.0.0"); assert.ok(message.methods.includes("jobs.cancel"));
  return message;
}
async function invoke<T>(client: CreativeCli, toolId: string, input: unknown): Promise<T> {
  const result = await client.request<{ ok: boolean; output: T }>({ method: "invoke", params: { toolId, input, toolVersion: "1.0.0", runId: "b3-cli", callId: `edit-${++sequence}` } });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.output;
}
const submission = (id: string, frames?: number): CreativeJobSubmission => ({ submissionId: id, runId: "b3-cli", callId: id, toolVersion: "1.0.0",
  ...(frames ? { toolId: "render.video", input: { snapshotId: "b3-snapshot", startFrame: 0, durationFrames: frames } }
    : { toolId: "render.preview", input: { snapshotId: "b3-snapshot", frame: 15 } }) });
const submit = (client: CreativeCli, params: CreativeJobSubmission) => client.request<{ created: boolean; record: RenderJobRecord }>({ method: "jobs.submit", params });
const get = (client: CreativeCli, jobId: string) => client.request<RenderJobRecord>({ method: "jobs.get", params: { jobId } });
async function until(client: CreativeCli, jobId: string, predicate: (record: RenderJobRecord) => boolean) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const record = await get(client, jobId);
    if (predicate(record)) return record;
    assert.ok(["queued", "running", "stopping", "publishing"].includes(record.state), `Unexpected terminal job: ${JSON.stringify(record)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} did not reach the expected state`);
}
const rendering = (record: RenderJobRecord) => record.state === "running" && record.progress?.phase === "rendering" && (record.progress.fraction ?? 0) > 0 && (record.progress.fraction ?? 1) < 0.8;
const noTemporaryJobs = async () => assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith("sciencemotion-worker-")), [], "Worker job temporary directory survived cleanup");
async function observe(client: CreativeCli) {
  const tree = processes(client.child.pid!);
  assert.ok(tree.some(p => /chrome/i.test(p.command)), "Must interrupt a real, live Chromium render");
  const guardian = tree.find(p => p.parent === client.child.pid && /python/i.test(p.command)); assert.ok(guardian);
  const workerTree = processes(guardian.pid);
  const names = (await readdir(temporary)).filter(name => name.startsWith("sciencemotion-worker-")); assert.equal(names.length, 1);
  const request = JSON.parse(await readFile(join(temporary, names[0], "request.json"), "utf8"));
  return { tree, workerTree, temporaryDirectory: names[0], workerJobId: request.jobId };
}
async function verifiedOutput(record: RenderJobRecord, filename: string, frames?: number) {
  const receipt = record.result!; assert.ok(receipt); assert.equal(receipt.jobId, record.id); assert.equal(receipt.inputHash, record.inputHash);
  const saved = await artifacts.get(receipt.artifactId), data = await artifacts.read(receipt.artifactId); assert.ok(saved && data);
  assert.equal(saved.metadata!.jobId, record.id); assert.equal(saved.metadata!.snapshotHash, record.input.snapshot.contentHash);
  assert.equal((saved.metadata!.execution as { kind: string }).kind, "local-process");
  const bytes = Buffer.from(data); assert.equal(bytes.length, receipt.sizeBytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.contentHash);
  await writeFile(join(output, filename), bytes);
  if (frames) {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", join(output, filename)], { encoding: "utf8", timeout: 10000 }));
    const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    assert.equal(video.width, 640); assert.equal(video.height, 360); assert.equal(video.r_frame_rate, "30/1"); assert.equal(Number(video.nb_frames), frames);
    assert.ok(Math.abs(Number(probe.format.duration) - frames / 30) < 0.1);
  } else {
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(bytes.readUInt32BE(16), 640); assert.equal(bytes.readUInt32BE(20), 360);
  }
  await noTemporaryJobs(); return { record, artifact: saved, file: filename };
}

try {
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true }); await mkdir(temporary);
  let client = await launch("initial"); await save("ready", await ready(client));
  for (const [toolId, input] of [
    ["project.create", { name: "CLI render lifecycle", episodeId: "b3-engineering-fixture", durationFrames: 900, width: 640, height: 360, fps: 30 }],
    ["project.scene.create", { sceneId: "scene", name: "Jobs", durationFrames: 900 }],
    ["graphics.2d.text.create", { sceneId: "scene", nodeId: "title", text: "Submit → Cancel → Recover", x: 32, y: 40, fontSize: 32, width: 576, height: 80 }],
    ["graphics.2d.shape.create", { sceneId: "scene", nodeId: "shape", primitive: "circle", x: 270, y: 160, width: 100, height: 100, fill: "#55d6e8" }],
  ] as Array<[string, unknown]>) await invoke(client, toolId, input);
  const project = await invoke<ProjectDocument>(client, "project.inspect", {});
  await invoke(client, "project.snapshot.save", { snapshotId: "b3-snapshot", revisionId: project.revisions.at(-1)!.id });

  const running = await submit(client, submission("cancel-running", 900)); assert.equal(running.record.state, "queued");
  const progress = await until(client, running.record.id, rendering), observed = await observe(client);
  const queued = await submit(client, submission("cancel-queued")); assert.equal(queued.record.state, "queued");
  const queuedStop = await client.request<{ accepted: boolean; record: RenderJobRecord }>({ method: "jobs.cancel", params: { jobId: queued.record.id } });
  assert.equal(queuedStop.accepted, true); assert.equal(queuedStop.record.state, "cancelled");
  const requestedAt = performance.now();
  const stop = await client.request<{ accepted: boolean; record: RenderJobRecord }>({ method: "jobs.cancel", params: { jobId: running.record.id } });
  assert.equal(stop.accepted, true); assert.equal(stop.record.state, "stopping");
  const cancelled = await until(client, running.record.id, r => r.state === "cancelled");
  await assertReaped(observed.workerTree); await noTemporaryJobs();
  assert.equal(cancelled.result, undefined); assert.equal(cancelled.outcomeUnknown, false); assert.deepEqual(await artifacts.list(), []);
  assert.deepEqual(await invoke(client, "project.inspect", {}), project);
  await save("cancellation", { progress, observed, acknowledgement: stop, cancelled, queued: queuedStop.record, cleanupMs: Math.round(performance.now() - requestedAt), processesReaped: true, temporaryFilesRemoved: true, noPublishedArtifact: true });
  console.log("PASS CLI cancellation: live Chromium progress, queued/running cancellation, process reaping and no result");

  const successful: RenderJobRecord[] = [];
  for (const [id, frames, file] of [["after-cancel-preview", undefined, "after-cancel.png"], ["after-cancel-video", 30, "after-cancel.mp4"]] as const) {
    const request = submission(id, frames), admitted = await submit(client, request);
    assert.equal((await submit(client, request)).created, false);
    const done = await until(client, admitted.record.id, r => r.state === "succeeded"); successful.push(done);
    await save(id, await verifiedOutput(done, file, frames));
  }
  assert.deepEqual(await get(client, cancelled.id), cancelled, "Late output must not change a cancelled job");
  await client.close(); client = await launch("reopened"); await ready(client);
  for (const record of [...successful, cancelled, queuedStop.record]) assert.deepEqual(await get(client, record.id), record);
  await save("exactResultsAfterReopen", true);

  const crashRequest = submission("interrupted-video", 900), crashing = await submit(client, crashRequest);
  const crashProgress = await until(client, crashing.record.id, rendering), crashObserved = await observe(client);
  const owner = crashObserved.tree.find(p => p.pid === client.child.pid)!; assert.ok(owner);
  // This fixture owns this private directory and this exact ChildProcess. These
  // captured lock identities are not a general stale-PID lock recovery algorithm.
  const lockPaths = ["projects/writer.lock", "executions/writer.lock", "jobs/writer.lock", "host.lock"];
  const locks = await Promise.all(lockPaths.map(async path => {
    const fullPath = join(directory, path), stat = await lstat(fullPath), text = await readFile(fullPath, "utf8");
    assert.ok(stat.isFile()); assert.equal(JSON.parse(text).pid, owner.pid);
    return { path, dev: stat.dev, ino: stat.ino, text };
  }));
  assert.equal(await stillOwned(owner), true); assert.equal(client.child.kill("SIGKILL"), true);
  assert.deepEqual(await client.exited, { code: null, signal: "SIGKILL" });
  await waitReaped(crashObserved.tree);
  await save("crashObservation", { progress: crashProgress, observed: crashObserved, owner, locks, processesReaped: true });
  await noTemporaryJobs(); // Regression: previously only the dead parent removed these files.
  const crashedLedger = JSON.parse(await readFile(join(directory, "jobs/jobs.json"), "utf8"));
  const persisted = (crashedLedger.records as RenderJobRecord[]).find(r => r.id === crashing.record.id)!;
  assert.equal(persisted.state, "running"); assert.equal(persisted.result, undefined);
  const beforeRecoveryArtifacts = await artifacts.list(); assert.equal(beforeRecoveryArtifacts.length, 2);
  const blocked = await launch("blocked-reopen"); await assert.rejects(blocked.ready, /EEXIST/); assert.equal((await blocked.exited).code, 1);
  // Explicit, verified-owner recovery, subordinate locks first and the root gate last.
  for (const lock of locks) {
    await assertReaped(crashObserved.tree);
    const fullPath = join(directory, lock.path), current = await lstat(fullPath);
    assert.equal(current.dev, lock.dev); assert.equal(current.ino, lock.ino); assert.equal(current.isFile(), true);
    assert.equal(await readFile(fullPath, "utf8"), lock.text); await rm(fullPath);
  }
  client = await launch("recovered"); await ready(client);
  const interrupted = await get(client, crashing.record.id);
  assert.equal(interrupted.state, "interrupted"); assert.equal(interrupted.interruptedFrom, "running"); assert.equal(interrupted.outcomeUnknown, true);
  assert.equal(interrupted.result, undefined); assert.deepEqual(interrupted.input, persisted.input); assert.deepEqual(interrupted.progress, persisted.progress);
  assert.deepEqual(await submit(client, crashRequest), { created: false, record: interrupted }, "Retry must return uncertainty without replay");
  assert.equal((await client.request<{ accepted: boolean }>({ method: "jobs.cancel", params: { jobId: interrupted.id } })).accepted, false);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await get(client, interrupted.id), interrupted); await noTemporaryJobs();
  assert.deepEqual(await artifacts.list(), beforeRecoveryArtifacts);
  assert.equal(processes(client.child.pid!).some(p => /python|chrome/i.test(p.command)), false);
  await save("recovery", { blockedAutomaticReopen: true, verifiedOwnedLocks: locks, temporaryFilesRemoved: true, persisted, interrupted, noAutomaticReplay: true, noInterruptedArtifact: true });
  console.log("PASS CLI host interruption: owned SIGKILL, descendant/temp cleanup, exclusive locks and uncertain recovery without replay");

  const next = await submit(client, submission("explicit-after-recovery", 60));
  const recovered = await until(client, next.record.id, r => r.state === "succeeded");
  await save("explicitAfterRecovery", await verifiedOutput(recovered, "after-recovery.mp4", 60));
  await client.close(); client = await launch("final-reopen"); await ready(client);
  for (const record of [...successful, cancelled, queuedStop.record, interrupted, recovered]) assert.deepEqual(await get(client, record.id), record);
  assert.equal((await client.request<{ total: number }>({ method: "jobs.list", params: {} })).total, 6);
  await client.close(); await noTemporaryJobs(); await save("status", "passed");
  console.log("PASS CLI durable results: PNG + 30/60-frame MP4s, verified worker receipts, exact terminal records after reopen");
} catch (error) {
  await save("failure", error instanceof Error ? error.stack : String(error)); await save("status", "failed"); throw error;
} finally {
  for (const client of clients) if (client.child.exitCode === null && client.child.signalCode === null) {
    client.child.kill("SIGTERM"); await client.exited;
  }
  await rm(root, { recursive: true, force: true });
}
