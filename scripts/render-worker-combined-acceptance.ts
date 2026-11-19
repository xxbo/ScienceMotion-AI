import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import type { RenderWorkerEvent } from "../src/contracts/render-worker";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import { LocalRenderWorker } from "../src/platform/render-worker";
import { assertReaped, processes, stillOwned, type ObservedProcess } from "./fixtures/owned-processes";

const { values } = parseArgs({ options: { "cgroup-parent": { type: "string" }, "temporary-volume": { type: "string", multiple: true } } });
const parentArgument = values["cgroup-parent"], mounts = values["temporary-volume"];
assert.ok(parentArgument && isAbsolute(parentArgument), "Supply a delegated cgroup parent");
assert.ok(mounts?.length === 2 && mounts.every(isAbsolute), "Supply two dedicated ext4 loop mounts");
const cgroupParent = await realpath(parentArgument);
const volumes = await Promise.all(mounts.map(path => realpath(path)));
const output = resolve("out/render-worker-combined");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-combined-")), directory = join(root, "host"), staging = join(root, "staging");
const ffprobe = join(dirname(createRequire(import.meta.url).resolve(`@remotion/compositor-linux-${process.arch}-gnu/package.json`)), "ffprobe");
const mib = 1024 * 1024, frames = 60;
const budget = { cpuMillicores: 2500, cpuTimeMs: 22000, memoryBytes: 1536 * mib, temporaryBytes: 128 * mib };
const policy = { maxConcurrentJobs: 2, cgroupParent, temporaryVolumes: volumes, resourceBudget: budget };
const cases = [
  { name: "cpu", fixture: "budget-cpu", code: "RENDER_WORKER_CPU_TIME_LIMIT", color: "#55d6e8" },
  { name: "memory", fixture: "budget-memory", code: "RENDER_WORKER_MEMORY_LIMIT", color: "#ffb454" },
  { name: "disk", fixture: "budget-temporary", code: "RENDER_WORKER_TEMPORARY_LIMIT", color: "#f47d9c" },
] as const;
const liveStates = ["queued", "running", "stopping", "publishing"];
const records: RenderJobRecord[] = [], events: RenderWorkerEvent[] = [], latest = new Map<string, RenderWorkerEvent>();
const scopes: Array<{ event: RenderWorkerEvent; tree: ObservedProcess[]; group: string; volume: string; work: string }> = [];
const scenarios: Array<Record<string, unknown>> = [];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
  policy, status: "running", events, records, scopes, scenarios };
let host: CreativeHost | undefined, worker: LocalRenderWorker | undefined, sequence = 0;
const initial = await Promise.all(volumes.map(volume => statfs(volume)));
const store = new FileSystemArtifactStore(join(directory, "artifacts"));

const actor = (projectId: string) => host!.createSession({ projectId,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.shape.create", "project.snapshot.save", "render.preview", "render.video"] });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown): Promise<T> {
  const result = await session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "combined-resources", callId: String(++sequence) });
  assert.ok(result.ok, JSON.stringify(result));
  return result.output as T;
}
async function seed(projectId: string, name: string, fill: string) {
  const session = actor(projectId), snapshotId = "snapshot-" + projectId;
  await invoke(session, "project.create", { name, episodeId: "combined-resources", durationFrames: frames, width: 640, height: 360, fps: 30 });
  await invoke(session, "project.scene.create", { sceneId: "scene", name, durationFrames: frames });
  await invoke(session, "graphics.2d.shape.create", { sceneId: "scene", nodeId: "shape", primitive: "circle", x: 260, y: 120, width: 120, height: 120, fill });
  const project = await invoke<ProjectDocument>(session, "project.inspect", {});
  await invoke(session, "project.snapshot.save", { snapshotId, revisionId: project.revisions.at(-1)!.id });
  return { session, snapshotId, projectId };
}
async function submit(input: Awaited<ReturnType<typeof seed>>, operation: "preview" | "video", id: string) {
  const { created, record } = await input.session.jobs.submit({ submissionId: id, runId: "combined-resources", callId: id, toolVersion: "1.0.0",
    ...(operation === "preview" ? { toolId: "render.preview", input: { snapshotId: input.snapshotId, frame: 0 } }
      : { toolId: "render.video", input: { snapshotId: input.snapshotId, startFrame: 0, durationFrames: frames } }) });
  assert.equal(created, true);
  return record;
}
async function until<T>(label: string, observe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 33000;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out while observing ${label}`);
}
async function settled(session: CreativeSession, record: RenderJobRecord) {
  return until(record.id, async () => {
    const current = await session.jobs.get(record.id);
    assert.ok(current);
    if (!liveStates.includes(current.state)) {
      records.push(current);
      return current;
    }
  });
}
function readLive(path: string) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}
const proc = (pid: number, file: "cmdline" | "cgroup") => readLive(`/proc/${pid}/${file}`);
function locateWorker(jobId: string) {
  for (const volume of volumes) {
    for (const job of readdirSync(volume).filter(name => name.startsWith("sciencemotion-disk-"))) {
      const work = join(volume, job, "work"), marker = readLive(join(work, "worker-scope.json"));
      if (!marker) continue;
      const reported = JSON.parse(marker) as { jobId: string; pid: number; temporary: string };
      if (reported.jobId === jobId) {
        assert.equal(reported.temporary, work, "The Node renderer inherits the leased temporary directory");
        return { pid: reported.pid, work, volume };
      }
    }
  }
}
const eventKey = (projectId: string, operation: string) => `${projectId}/${operation}`;
async function observeScope(projectId: string, operation: "preview" | "video", marker: string) {
  return until(`${projectId}/${operation} at ${marker}`, () => {
    const event = latest.get(eventKey(projectId, operation));
    if (!event || event.state === "starting") return;
    assert.equal(event.state, "running", JSON.stringify(event));
    const location = locateWorker(event.jobId);
    if (!location || !existsSync(join(location.work, marker))) return;
    const { work, volume } = location, guardian = event.processId!;
    const tree = processes(guardian);
    const renderer = tree.find(p => p.pid === location.pid && p.parent === guardian);
    assert.ok(renderer, "The reported Node process is the guardian's child");
    const membership = proc(renderer.pid, "cgroup")?.trim();
    assert.ok(membership?.startsWith("0::/"));
    const group = join("/sys/fs/cgroup", membership!.slice(3));
    assert.equal(dirname(group), cgroupParent);
    assert.notEqual(proc(guardian, "cgroup")?.trim(), membership);
    for (const child of tree.filter(p => p.pid !== guardian)) {
      const current = proc(child.pid, "cgroup")?.trim();
      if (current !== undefined) assert.equal(current, membership, `Expected ${child.command} in its render cgroup`);
    }
    const control = (name: string) => readFileSync(join(group, name), "utf8").trim();
    assert.equal(control("cpu.max"), `${budget.cpuMillicores * 100} 100000`);
    assert.equal(control("memory.max"), String(budget.memoryBytes));
    assert.equal(control("memory.oom.group"), "1");
    const scope = { event, tree, group, volume, work };
    scopes.push(scope);
    return scope;
  });
}
async function verifyArtifact(record: RenderJobRecord, kind: string, event: RenderWorkerEvent) {
  assert.equal(record.state, "succeeded", JSON.stringify(record));
  assert.ok(record.result);
  const receipt = record.result, artifact = await store.get(receipt.artifactId), data = await store.read(receipt.artifactId);
  assert.ok(artifact && data);
  assert.equal(receipt.inputHash, record.inputHash);
  assert.equal(receipt.jobId, record.id);
  assert.equal(artifact.metadata?.jobId, record.id);
  assert.equal(artifact.metadata?.snapshotHash, record.input.snapshot.contentHash);
  const usage = event.resourceUsage!;
  assert.ok(usage);
  assert.ok(Number(usage.cpuUsageUsec) > 0 && Number(usage.cpuUsageUsec) < budget.cpuTimeMs * 1000);
  assert.equal(usage.memoryOomKills, "0");
  assert.equal(usage.temporaryCapacityBytes, String(budget.temporaryBytes));
  assert.ok(Number(usage.temporaryMinimumAvailableBytes) > 0);
  const execution = artifact.metadata?.execution as { kind?: string; jobId?: string; resourceUsage?: unknown };
  assert.equal(execution.kind, "local-process");
  assert.equal(execution.jobId, event.jobId);
  assert.deepEqual(execution.resourceUsage, usage);
  const retained = await host!.maintenance.renderJobs.inspect(record.input.projectId, record.id);
  assert.ok(retained && "output" in retained && retained.output?.retainedByJob && retained.output.availability === "verified");
  const bytes = Buffer.from(data);
  assert.equal(bytes.length, receipt.sizeBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.contentHash);
  const preview = record.input.render.operation === "preview";
  const file = `${kind}-${preview ? "recovered.png" : "sibling.mp4"}`, path = join(output, file);
  await writeFile(path, bytes);
  if (preview) {
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 640);
    assert.equal(bytes.readUInt32BE(20), 360);
  } else {
    const { streams: [video], format } = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,nb_frames:format=duration", "-of", "json", path], { encoding: "utf8", timeout: 10000 }));
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 640);
    assert.equal(video.height, 360);
    assert.equal(Number(video.nb_frames), frames);
    assert.equal(Number(format.duration), frames / 30);
  }
  return { file, record, contentHash: receipt.contentHash, usage };
}

try {
  await mkdir(staging);
  worker = new LocalRenderWorker({ policy, temporaryDirectory: staging, workerScript: resolve("src/platform/fixtures/render-worker-combined-fixture.mjs"),
    onEvent: event => { events.push(event); latest.set(eventKey(event.projectId, event.operation), event); } });
  host = await openCreativeHost({ directory, renderer: worker, renderJobs: { maxConcurrentJobs: 2, maxQueuedJobs: 1 } });
  for (const { name, fixture, code, color } of cases) {
    const overloaded = await seed(`pressure-${name}`, fixture, color);
    const healthy = await seed(`sibling-${name}`, `Healthy ${name} render`, color);
    const pressure = await submit(overloaded, "preview", name + "-pressure");
    const sibling = await submit(healthy, "video", name + "-video");
    const followup = await submit(healthy, "preview", name + "-followup");
    assert.equal(followup.state, "queued");
    const [loadScope, siblingScope] = await Promise.all([
      observeScope(overloaded.projectId, "preview", "../budget-processes.json"),
      observeScope(healthy.projectId, "video", "video-paused"),
    ]);
    assert.equal(worker.status().activeJobs, 2);
    assert.equal((await healthy.session.jobs.get(followup.id))?.state, "queued");
    assert.notEqual(loadScope.group, siblingScope.group);
    assert.notEqual(loadScope.volume, siblingScope.volume);
    const load = JSON.parse(readFileSync(join(dirname(loadScope.work), "budget-processes.json"), "utf8"));
    assert.equal(load.directory, loadScope.work);
    assert.ok(loadScope.tree.some(p => p.pid === load.load && p.parent === load.renderer && p.group === p.pid), "Observe the detached pressure process");
    const browser = siblingScope.tree.filter(p => /chrome/i.test(p.command)).flatMap(p => proc(p.pid, "cmdline")?.split("\0") ?? []);
    const encoder = siblingScope.tree.filter(p => /ffmpeg/i.test(p.command)).flatMap(p => proc(p.pid, "cmdline")?.split("\0") ?? []);
    const profile = browser.find(arg => arg.startsWith(`--user-data-dir=${siblingScope.work}/`));
    const encoderOutput = encoder.find(arg => arg.startsWith(siblingScope.work + "/") && arg.endsWith("pre-encode.mp4"));
    assert.ok(profile && encoderOutput, "Observe live Chromium and FFmpeg using the sibling volume");

    writeFileSync(join(loadScope.work, "start-load"), "", { flag: "wx" });
    const failed = await settled(overloaded.session, pressure);
    assert.equal(failed.state, "failed", JSON.stringify(failed));
    assert.equal(failed.diagnostic?.code, code, JSON.stringify(failed.diagnostic));
    assert.equal(failed.result, undefined);
    const failureEvent = latest.get(eventKey(overloaded.projectId, "preview"))!;
    assert.equal(failureEvent.code, code);
    const usage = failureEvent.resourceUsage!;
    assert.ok(usage);
    assert.equal(usage.temporaryCapacityBytes, String(budget.temporaryBytes));
    if (name === "cpu") {
      assert.ok(Number(usage.cpuUsageUsec) >= budget.cpuTimeMs * 1000);
      assert.ok(Number(usage.cpuThrottledPeriods) > 0);
    }
    if (name === "memory") assert.ok(Number(usage.memoryOomEvents) > 0 && Number(usage.memoryOomKills) > 0);
    else assert.equal(usage.memoryOomKills, "0");
    if (name === "disk") assert.match(failed.diagnostic!.message, /ENOSPC after \d+ bytes/);
    await assertReaped(loadScope.tree);
    assert.equal(existsSync(loadScope.group), false);
    assert.equal(existsSync(loadScope.work), false);
    const reused = await observeScope(healthy.projectId, "preview", "request.json");
    assert.equal(reused.volume, loadScope.volume, "The queued job must reuse the exhausted job's volume");
    assert.notEqual(reused.group, loadScope.group);
    assert.notEqual(reused.group, siblingScope.group);
    assert.equal((await healthy.session.jobs.get(sibling.id))?.state, "running");
    assert.equal(await stillOwned(siblingScope.tree.find(p => p.pid === siblingScope.event.processId)!), true);
    assert.ok(existsSync(siblingScope.group) && existsSync(siblingScope.work));
    const resumeOffset = events.length;
    writeFileSync(join(siblingScope.work, "resume-video"), "", { flag: "wx" });
    const [video, preview] = await Promise.all([settled(healthy.session, sibling), settled(healthy.session, followup)]);
    assert.ok(events.slice(resumeOffset).some(event => event.jobId === siblingScope.event.jobId && event.progress?.phase === "rendering" &&
      (event.progress.fraction ?? 0) > (siblingScope.event.progress?.fraction ?? 0)), "The same video must render additional frames after the failure");
    const outputs = await Promise.all([verifyArtifact(video, name, latest.get(eventKey(healthy.projectId, "video"))!),
      verifyArtifact(preview, name, latest.get(eventKey(healthy.projectId, "preview"))!)]);
    await assertReaped([...siblingScope.tree, ...reused.tree]);
    assert.equal(worker.status().activeJobs, 0);
    assert.deepEqual((await readdir(cgroupParent)).filter(entry => entry.startsWith("sciencemotion-render-")), []);
    assert.deepEqual(await readdir(staging), []);
    const reclaimed = await Promise.all(volumes.map(async (volume, index) => {
      const after = await statfs(volume);
      assert.ok(after.bavail >= initial[index].bavail && after.ffree >= initial[index].ffree);
      assert.deepEqual((await readdir(volume)).filter(entry => entry !== "lost+found"), []);
      return { volume, availableBytes: after.bavail * after.bsize, freeInodes: after.ffree };
    }));
    scenarios.push({ name, failed, usage, pressureScope: loadScope, siblingScope, reused, profile, encoderOutput, reclaimed, outputs });
    console.log(`PASS combined ${name}: ${code}, sibling MP4, recovered slot PNG`);
  }
  await host.close();
  await worker.close();
  host = await openCreativeHost({ directory });
  for (const record of records) assert.deepEqual(await actor(record.input.projectId).jobs.get(record.id), record);
  Object.assign(evidence, { status: "passed", exactRecordsAfterReopen: true });
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    await worker?.close();
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
