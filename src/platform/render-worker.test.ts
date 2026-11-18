import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RenderWorkerEvent } from "../contracts/render-worker";
import { createEmptyProject } from "./empty-project";
import { hashProject } from "./project-snapshots";
import { LocalRenderWorker, renderWorkerPolicy } from "./render-worker";
import { openCreativeHost } from "./creative-host";
import type { CreativeSession } from "../contracts/creative-host";
import type { ProjectGraphSnapshotRenderer } from "../contracts/renderer";
import { FileSystemArtifactStore } from "./artifact-store";
import { probeRenderResources } from "./render-resource-capabilities";

const script = resolve("src/platform/fixtures/render-worker-fixture.mjs");
function request(name: string, signal?: AbortSignal) {
  const project = createEmptyProject({ id: "worker-test", name, episodeId: "approved", durationFrames: 30 });
  return { project, revisionId: "revision-initial", snapshotHash: hashProject(project), frame: 0, signal };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const noJobs = async (root: string) => assert.deepEqual((await readdir(root)).filter(p => p.startsWith("sciencemotion-worker-")), []);
async function notRunning(pid: number) {
  // A killed descendant may briefly be a zombie until the machine's init reaps it.
  for (let i = 0; i < 100; i++) {
    try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Worker descendant ${pid} is still running`);
}
const linux = { skip: process.platform !== "linux", timeout: 30000 };

test("guardian refuses work and removes its private temporary directory when the parent is already gone at startup", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-orphan-start-"));
  const directory = await mkdtemp(join(root, "sciencemotion-worker-"));
  try {
    await writeFile(join(directory, "request.json"), "unfinished parent request");
    await writeFile(join(root, "unrelated.txt"), "must remain");
    const result = spawnSync("python3", [resolve("src/platform/render-worker-supervisor.py"), process.execPath, script, directory, "1024", "150", "-1"],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr); assert.equal(result.stderr, "");
    await noJobs(root); assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "must remain");
    assert.equal(existsSync(join(root, "worker.json")), false, "No renderer may start after parent loss");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker returns verified bytes only after exit; observers cannot alter success; descendants and temporary files are cleaned", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-test-")), events: RenderWorkerEvent[] = [];
  const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root,
    onEvent: event => { events.push(event); throw new Error("Observer failure"); } });
  try {
    const result = await worker.renderPreview(request("success-child"));
    assert.equal(result.bytes[8], 42); assert.equal(result.execution!.kind, "local-process");
    assert.notEqual(result.execution!.processId, process.pid);
    const info = JSON.parse(await readFile(join(root, "worker.json"), "utf8"));
    assert.ok(info.args.includes("--max-old-space-size=1024")); assert.ok(info.tmp.startsWith(root));
    assert.deepEqual(events.map(e => e.state), ["starting", "running", "completed"]);
    await notRunning(result.execution!.processId);
    await notRunning(JSON.parse(await readFile(join(root, "descendant.json"), "utf8")).pid);
    await noJobs(root); assert.equal(worker.status().activeJobs, 0);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker cancels non-cooperative CPU work and its descendant, holds admission until exit, then accepts another job", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-cancel-")), started = deferred(), controller = new AbortController();
  const events: RenderWorkerEvent[] = [];
  const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root,
    onEvent: e => { events.push(e); if (e.state === "running") started.resolve(); } });
  try {
    const pending = worker.renderPreview(request("spin", controller.signal));
    await Promise.race([started.promise, pending.then(() => assert.fail("Worker completed before entering its running state"))]);
    await assert.rejects(worker.renderPreview(request("success")), { code: "RENDER_WORKER_BUSY" });
    controller.abort(); assert.equal(worker.status().activeJobs, 1);
    await assert.rejects(pending, { code: "RENDER_WORKER_CANCELLED" });
    const descendant = JSON.parse(await readFile(join(root, "descendant.json"), "utf8"));
    await notRunning(descendant.pid); await notRunning(descendant.parent); await noJobs(root);
    assert.equal(events.at(-1)!.state, "cancelled");
    assert.equal((await worker.renderPreview(request("success"))).bytes[8], 42);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker deadlines terminate hangs even after a result message, without releasing a false success", linux, async () => {
  for (const mode of ["spin", "result-hang"]) {
    const root = await mkdtemp(join(tmpdir(), "science-worker-deadline-")), events: RenderWorkerEvent[] = [];
    const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root, policy: { timeoutMs: 4000 }, onEvent: e => { events.push(e); } });
    try {
      await assert.rejects(worker.renderPreview(request(mode)), { code: "RENDER_WORKER_TIMEOUT" });
      assert.equal(events.at(-1)!.state, "timed-out");
      const descendant = JSON.parse(await readFile(join(root, "descendant.json"), "utf8"));
      await notRunning(descendant.pid); await notRunning(descendant.parent); await noJobs(root);
    } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("worker rejects crash, missing/mismatched evidence, hash/size faults, duplicate messages and symlink output", linux, async () => {
  for (const [mode, code] of [["crash", "RENDER_WORKER_EXIT"], ["empty-exit", "RENDER_WORKER_EXIT"], ["identity", "RENDER_WORKER_PROTOCOL"],
    ["hash", "RENDER_WORKER_OUTPUT_INVALID"], ["oversize", "RENDER_WORKER_OUTPUT_LIMIT"], ["duplicate", "RENDER_WORKER_PROTOCOL"], ["symlink", "RENDER_WORKER_OUTPUT_INVALID"]]) {
    const root = await mkdtemp(join(tmpdir(), "science-worker-fault-"));
    const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root, policy: { maxOutputBytes: 1024 } });
    try {
      await assert.rejects(worker.renderPreview(request(mode)), { code });
      if (mode === "crash") await notRunning(JSON.parse(await readFile(join(root, "descendant.json"), "utf8")).pid);
      await noJobs(root); assert.equal(worker.status().activeJobs, 0);
    } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("worker ignores late success after cancellation; explicit close drains and prevents subsequent jobs", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-close-")), started = deferred(), controller = new AbortController();
  const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root, policy: { killGraceMs: 1000 }, onEvent: e => { if (e.state === "running") started.resolve(); } });
  try {
    const pending = worker.renderPreview(request("late", controller.signal));
    await Promise.race([started.promise, pending.then(() => assert.fail("Worker completed before entering its running state"))]);
    controller.abort(); await Promise.all([worker.close(), assert.rejects(pending, { code: "RENDER_WORKER_CANCELLED" })]);
    assert.deepEqual(worker.status(), { closed: true, activeJobs: 0 }); await noJobs(root);
    await assert.rejects(worker.renderPreview(request("success")), { code: "RENDER_WORKER_CLOSED" });
    await notRunning(JSON.parse(await readFile(join(root, "descendant.json"), "utf8")).pid);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker rejects invalid policy and pre-aborted work before filesystem/process admission", linux, async () => {
  for (const policy of [{ timeoutMs: 0 }, { maxConcurrentJobs: 5 }, { maxOutputBytes: NaN }, { maxOldSpaceMb: 0 }, { workerScript: "injected" }])
    assert.throws(() => renderWorkerPolicy(policy), { code: "RENDER_WORKER_CONFIG" });
  assert.throws(() => renderWorkerPolicy(JSON.parse('{"constructor":"injected"}')), { code: "RENDER_WORKER_CONFIG" });
  const root = await mkdtemp(join(tmpdir(), "science-worker-pre-abort-")), controller = new AbortController(); controller.abort();
  const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root });
  try { await assert.rejects(worker.renderPreview(request("success", controller.signal)), { code: "RENDER_WORKER_CANCELLED" }); assert.deepEqual(await readdir(root), []); }
  finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("resource budget validation distinguishes invalid limits from unavailable enforcement", () => {
  for (const resourceBudget of [{}, { cpuMillicores: 9 }, { cpuTimeMs: 0 }, { cpuTimeMs: Number.MAX_SAFE_INTEGER },
    { memoryBytes: 1.5 }, { temporaryBytes: Infinity }, { unknown: 1 }, JSON.parse('{"constructor": 1}')]) {
    assert.throws(() => renderWorkerPolicy({ resourceBudget }), { code: "RENDER_WORKER_CONFIG" });
  }
  for (const resourceBudget of [{ cpuMillicores: 500 }, { cpuTimeMs: 2000 }, { memoryBytes: 128 * 1024 * 1024 }, { temporaryBytes: 32 * 1024 * 1024 }])
    assert.throws(() => renderWorkerPolicy({ resourceBudget }), { code: "RENDER_WORKER_RESOURCE_UNAVAILABLE" });
});

test("native and stdio resource requests fail before creating workspace or trace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-resource-config-"));
  const directory = join(root, "workspace"), traceFile = join(root, "trace.jsonl");
  const renderWorker = { resourceBudget: { cpuMillicores: 500, memoryBytes: 128 * 1024 * 1024 } };
  try {
    await assert.rejects(openCreativeHost({ directory, renderWorker }), { code: "RENDER_WORKER_RESOURCE_UNAVAILABLE" });
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ schemaVersion: "1.0.0", directory, traceFile, grant: { projectId: "resource-fixture" }, renderWorker }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/creative-host-server.ts", "--config", config],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /\[RENDER_WORKER_RESOURCE_UNAVAILABLE\]/);
    assert.deepEqual(await readdir(root), ["config.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit resource probes reject ordinary directories before creating any probe objects", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-resource-probe-"));
  try {
    await writeFile(join(root, "unrelated.txt"), "untouched");
    const report = await probeRenderResources({ cgroupParent: root, temporaryVolume: root });
    assert.equal(report.enforcement, "probe-only");
    assert.equal(report.cgroup.verification.state, "unavailable");
    assert.equal(report.storage.state, "unavailable");
    assert.deepEqual(await readdir(root), ["unrelated.txt"]);
    assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker observes cancellation during temporary cleanup and cannot return contradictory success", linux, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-worker-cleanup-")), controller = new AbortController();
  const events: RenderWorkerEvent[] = []; let watcher: FSWatcher | undefined, cancelledDuringCleanup = false;
  const worker = new LocalRenderWorker({ workerScript: script, temporaryDirectory: root, onEvent: event => {
    events.push(event);
    if (event.state === "running" && !watcher) {
      const directory = join(root, readdirSync(root).find(name => name.startsWith("sciencemotion-worker-"))!);
      watcher = watch(directory, (_kind, filename) => {
        // Observe actual output removal while the guardian has exited and nested files are still being cleaned.
        if (filename === "output.bin" && !existsSync(join(directory, "output.bin")) && worker.status().activeJobs === 1) {
          cancelledDuringCleanup = true; controller.abort();
        }
      });
    }
  } });
  try {
    await assert.rejects(worker.renderPreview(request("cleanup", controller.signal)), { code: "RENDER_WORKER_CANCELLED" });
    assert.equal(cancelledDuringCleanup, true); assert.equal(events.at(-1)!.state, "cancelled");
    assert.equal(events.some(event => event.state === "completed"), false); await noJobs(root);
  } finally { watcher?.close(); await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("host cancellation reaches the render request and prevents a late non-cooperative renderer from publishing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-host-late-render-")), started = deferred(), finish = deferred(), controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const renderer: ProjectGraphSnapshotRenderer = { id: "test", version: "1",
    async renderPreview(req) { observedSignal = req.signal; started.resolve(); await finish.promise;
      return { bytes: new Uint8Array([137,80,78,71,13,10,26,10,42]), mediaType: "image/png", extension: "png", rendererId: this.id, rendererVersion: this.version }; },
    async renderVideo() { throw new Error("unused"); } };
  const host = await openCreativeHost({ directory: root, renderer }); let id = 0;
  const call = (s: CreativeSession, toolId: string, input: unknown, signal?: AbortSignal) => s.invoke({ toolId, toolVersion: "1.0.0", input, runId: "worker-host", callId: String(++id), signal });
  try {
    const session = host.createSession({ projectId: "p", permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write", "execution.read"],
      toolIds: ["project.create", "project.inspect", "project.snapshot.save", "render.preview", "execution.list"] });
    assert.equal((await call(session, "project.create", { name: "Late result", episodeId: "approved" })).ok, true);
    await call(session, "project.snapshot.save", { snapshotId: "s", revisionId: "revision-initial" });
    const pending = call(session, "render.preview", { snapshotId: "s", frame: 0 }, controller.signal);
    await started.promise; controller.abort(); assert.equal(observedSignal!.aborted, true);
    assert.equal((await pending).diagnostics[0].code, "TOOL_CANCELLED");
    finish.resolve(); assert.equal((await call(session, "project.inspect", {})).ok, true);
    assert.deepEqual(await new FileSystemArtifactStore(join(root, "artifacts")).list(), []);
  } finally { finish.resolve(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
