import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { CreativeHost, CreativePluginFactory, CreativeSession } from "../contracts/creative-host";
import type { CreativeJobSubmission } from "../contracts/creative-jobs";
import type { ProjectGraphRenderOutput, ProjectGraphRenderRequest, ProjectGraphSnapshotRenderer } from "../contracts/renderer";
import type { RenderJobRecord } from "../contracts/render-job";
import type { ToolExecutionRecord } from "../contracts/agent-tool";
import { openCreativeHost } from "./creative-host";
import { serveCreativeStdio, parseCreativeRequest } from "./creative-stdio";
import { readCreativeLocalConfig } from "./creative-local-server";
import { FileSystemArtifactStore } from "./artifact-store";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { FileSystemProjectWorkspace } from "./filesystem-project-workspace";
import { createEmptyProject } from "./empty-project";

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const temp = () => mkdtemp(join(tmpdir(), "science-host-jobs-"));
const code = (code: string) => ({ code });
let calls = 0;
const invoke = async (session: CreativeSession, toolId: string, input: unknown = {}) => {
  const result = await session.invoke({ toolId, toolVersion: "1.0.0", runId: "job-fixture", callId: String(++calls), input });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.output;
};
const actor = (host: CreativeHost, projectId = "p") => host.createSession({ projectId,
  permissions: ["project.read", "project.write", "project.delete", "snapshot.write", "snapshot.read", "artifact.read", "artifact.write", "execution.read"],
  toolIds: ["project.create", "project.inspect", "project.patch.apply", "project.patch.remove", "project.snapshot.save", "render.preview", "render.video", "execution.list"], allowDestructive: true });
const submission = (submissionId = "one", mode: "preview" | "video" = "preview"): CreativeJobSubmission => ({ submissionId, runId: "jobs", callId: submissionId,
  toolVersion: "1.0.0", ...(mode === "preview" ? { toolId: "render.preview", input: { snapshotId: "baseline", frame: 0 } }
    : { toolId: "render.video", input: { snapshotId: "baseline", startFrame: 0, durationFrames: 10 } }) });
const result = (mode: "preview" | "video"): ProjectGraphRenderOutput => ({ rendererId: "test.jobs", rendererVersion: "1.0.0",
  bytes: new Uint8Array(mode === "preview" ? [137,80,78,71,13,10,26,10,1] : [0,0,0,24,102,116,121,112,109,112,52,50]),
  mediaType: mode === "preview" ? "image/png" : "video/mp4", extension: mode === "preview" ? "png" : "mp4" });
const renderer = (run: (request: ProjectGraphRenderRequest, mode: "preview" | "video") => Promise<ProjectGraphRenderOutput>): ProjectGraphSnapshotRenderer => ({
  id: "test.jobs", version: "1.0.0", renderPreview: request => run(request, "preview"), renderVideo: request => run(request, "video"),
});
async function seed(host: CreativeHost) {
  const session = actor(host);
  await invoke(session, "project.create", { name: "Job input", episodeId: "approved", durationFrames: 30, width: 960, height: 540, fps: 30 });
  await invoke(session, "project.snapshot.save", { snapshotId: "baseline", revisionId: "revision-initial" });
  return session;
}
async function state(session: CreativeSession, id: string, expected: string): Promise<RenderJobRecord> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const record = (await session.jobs.get(id))!;
    if (record.state === expected) return record;
    if (["succeeded", "failed", "cancelled", "timed-out", "interrupted"].includes(record.state)) assert.fail(JSON.stringify(record));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Job ${id} did not reach ${expected}`);
}

test("host jobs return before rendering, deduplicate admission, persist verified results and replay after snapshot release/reopen", { timeout: 15000 }, async () => {
  const root = await temp(), started = deferred<ProjectGraphRenderRequest>(), release = deferred(); let host: CreativeHost | undefined, executions = 0;
  const render = renderer(async (request, mode) => { executions++; started.resolve(request); await release.promise; return result(mode); });
  try {
    host = await openCreativeHost({ directory: root, renderer: render }); let session = await seed(host);
    const request = submission(), pending = session.jobs.submit(request); request.input.snapshotId = "caller mutation";
    const first = await pending;
    first.record.input.snapshot.id = "response mutation";
    first.record.input.render = { operation: "preview", frame: 29 };
    const repeats = await Promise.all(Array.from({ length: 12 }, () => session.jobs.submit(submission())));
    assert.ok(repeats.every(item => !item.created && item.record.id === first.record.id));
    await assert.rejects(session.jobs.submit({ ...submission(), runId: "different" }), code("RENDER_JOB_CONFLICT"));
    const running = await started.promise; assert.equal(executions, 1); assert.equal(running.snapshotHash, first.record.input.snapshot.contentHash);
    assert.equal((running as ProjectGraphRenderRequest & { frame: number }).frame, 0);
    assert.equal((await session.jobs.get(first.record.id))!.input.snapshot.id, "baseline");
    assert.equal(running.project.project.name, "Job input");
    running.onProgress!({ phase: "rendering", fraction: 0.5 });
    assert.equal((await session.jobs.get(first.record.id))!.state, "running");
    assert.equal((await session.jobs.list()).total, 1);
    release.resolve(); const done = await state(session, first.record.id, "succeeded");
    assert.equal(done.result!.inputHash, done.inputHash); assert.equal(done.result!.jobId, done.id);
    const bytes = await readFile(join(root, "artifacts", "blobs", done.result!.contentHash.slice(0, 2), done.result!.contentHash));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), done.result!.contentHash);
    assert.equal((await host.maintenance.collectGarbage(0)).deleted.length, 0);
    const history = await invoke(session, "execution.list") as ToolExecutionRecord[];
    assert.deepEqual(history.map(record => record.toolId).sort(), ["execution.list", "project.create", "project.snapshot.save"], "Native jobs must not fabricate Gateway invocations");
    await host.maintenance.releaseSnapshot("p", "baseline");
    assert.deepEqual((await session.jobs.submit(submission())).record, done);
    await host.close(); host = await openCreativeHost({ directory: root, renderer: render }); session = actor(host);
    assert.deepEqual(await session.jobs.get(done.id), done); assert.equal((await session.jobs.submit(submission())).created, false); assert.equal(executions, 1);
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("job admission/control enforce session grants, project ownership, exact versions and bounded fields", async () => {
  const root = await temp(); let host: CreativeHost | undefined, executions = 0;
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => { executions++; return result(mode); }) });
    const session = await seed(host);
    const preview = await session.jobs.submit(submission()), video = await session.jobs.submit(submission("video", "video"));
    await state(session, video.record.id, "succeeded");
    const restricted = host.createSession({ projectId: "p", toolIds: ["render.preview"], permissions: ["snapshot.read", "artifact.write"] });
    assert.deepEqual((await restricted.jobs.list()).jobs.map(record => record.id), [preview.record.id]);
    await assert.rejects(restricted.jobs.get(video.record.id), code("HOST_TOOL_DENIED"));
    await assert.rejects(restricted.jobs.cancel(video.record.id), code("HOST_TOOL_DENIED"));
    const denied = host.createSession({ projectId: "p", toolIds: ["render.preview"], permissions: ["snapshot.read"] });
    await assert.rejects(denied.jobs.submit(submission("denied")), code("HOST_TOOL_DENIED")); assert.equal((await denied.jobs.list()).total, 0);
    const foreign = actor(host, "foreign"); assert.equal(await foreign.jobs.get(preview.record.id), undefined);
    await assert.rejects(foreign.jobs.cancel(preview.record.id), code("RENDER_JOB_NOT_FOUND"));
    await assert.rejects(foreign.jobs.submit(submission()), code("HOST_SNAPSHOT_DENIED"));
    await assert.rejects(session.jobs.submit({ ...submission("bad"), toolVersion: "2.0.0" }), code("HOST_TOOL_VERSION_MISMATCH"));
    for (const bad of [{ ...submission("bad"), projectId: "foreign" }, { ...submission("bad"), renderer: { id: "injected" } },
      { ...submission("bad"), input: { snapshotId: "baseline", frame: 0, path: "/tmp/output" } },
      { ...submission("bad"), input: { snapshotId: "baseline", frame: 30 } },
      { ...submission("bad"), input: { snapshotId: "baseline", frame: 0, sceneId: "missing" } },
      { ...submission("bad", "video"), input: { snapshotId: "baseline", startFrame: 25, durationFrames: 10 } }])
      await assert.rejects(session.jobs.submit(bad as CreativeJobSubmission));
    await assert.rejects(session.jobs.list({ limit: 201 })); assert.equal((await session.jobs.list()).total, 2); assert.equal(executions, 2);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("queued cancellation releases capacity; running cancellation waits for actual settlement and rejects late success", async () => {
  const root = await temp(), started = deferred(), release = deferred(); let host: CreativeHost | undefined, executions = 0;
  try {
    host = await openCreativeHost({ directory: root, renderJobs: { maxActiveJobs: 2 }, renderer: renderer(async (_request, mode) => {
      if (++executions === 1) { started.resolve(); await release.promise; } return result(mode);
    }) }); const session = await seed(host);
    const first = await session.jobs.submit(submission()); await started.promise;
    const second = await session.jobs.submit(submission("queued"));
    await assert.rejects(session.jobs.submit(submission("overflow")), code("HOST_JOB_CAPACITY"));
    const cancelled = await session.jobs.cancel(second.record.id); assert.equal(cancelled.accepted, true); assert.equal(cancelled.record.state, "cancelled");
    assert.equal(cancelled.record.startedAt, undefined);
    const replacement = await session.jobs.submit(submission("overflow")); await session.jobs.cancel(replacement.record.id);
    assert.equal((await session.jobs.cancel(first.record.id)).record.state, "stopping");
    assert.equal((await session.jobs.get(first.record.id))!.completedAt, undefined);
    await assert.rejects(host.maintenance.releaseSnapshot("p", "baseline"), code("HOST_SNAPSHOT_RETAINED"));
    release.resolve(); const stopped = await state(session, first.record.id, "cancelled"); assert.equal(stopped.result, undefined); assert.equal(executions, 1);
    const next = await session.jobs.submit(submission("after")); await state(session, next.record.id, "succeeded"); assert.equal(executions, 2);
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending admissions are bounded and concurrent identical submissions share persistence without sharing mutable replies", async () => {
  const root = await temp(), reading = deferred(), release = deferred(); let host: CreativeHost | undefined;
  const original = FileSystemProjectWorkspace.prototype.getSnapshot;
  try {
    host = await openCreativeHost({ directory: root, renderJobs: { maxActiveJobs: 2 }, renderer: renderer(async (_request, mode) => result(mode)) }); const session = await seed(host);
    FileSystemProjectWorkspace.prototype.getSnapshot = async function (id) { reading.resolve(); await release.promise; return original.call(this, id); };
    const first = session.jobs.submit(submission()), duplicates = Array.from({ length: 20 }, () => session.jobs.submit(submission()));
    await reading.promise; const second = session.jobs.submit(submission("second"));
    await assert.rejects(session.jobs.submit(submission("overflow")), code("HOST_JOB_CAPACITY"));
    await assert.rejects(session.jobs.submit({ ...submission(), runId: "conflict" }), code("RENDER_JOB_CONFLICT"));
    release.resolve(); const initial = await first, replies = await Promise.all(duplicates); await second;
    assert.equal(initial.created, true); assert.ok(replies.every(reply => !reply.created && reply.record.id === initial.record.id));
    replies[0].record.input.snapshot.id = "caller mutation"; assert.equal(replies[1].record.input.snapshot.id, "baseline");
    await state(session, initial.record.id, "succeeded"); assert.equal((await session.jobs.list()).total, 2);
  } finally { release.resolve(); await host?.close(); FileSystemProjectWorkspace.prototype.getSnapshot = original; await rm(root, { recursive: true, force: true }); }
});

test("deadline stop keeps the first reason and waits for renderer cleanup before becoming terminal", async () => {
  const root = await temp(), started = deferred(), release = deferred(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root, renderJobs: { timeoutMs: 30 }, renderer: renderer(async (_request, mode) => {
      started.resolve(); await release.promise; return result(mode);
    }) }); const session = await seed(host), first = await session.jobs.submit(submission()); await started.promise;
    const stopping = await state(session, first.record.id, "stopping"); assert.equal(stopping.stop!.reason, "timed-out");
    assert.equal((await session.jobs.cancel(first.record.id)).record.stop!.reason, "timed-out");
    release.resolve(); assert.equal((await state(session, first.record.id, "timed-out")).result, undefined);
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("revocation stops owned queued/running jobs while another authorized session can observe cleanup", async () => {
  const root = await temp(), started = deferred(), release = deferred(); let host: CreativeHost | undefined, executions = 0;
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (request, mode) => {
      executions++; started.resolve(); await release.promise; assert.equal(request.signal!.aborted, true); return result(mode);
    }) }); const session = await seed(host), observer = actor(host);
    const first = await session.jobs.submit(submission()); await started.promise;
    const second = await session.jobs.submit(submission("queued")); session.revoke();
    await assert.rejects(session.jobs.get(first.record.id), code("HOST_SESSION_REVOKED"));
    await assert.rejects(session.jobs.submit(submission("revoked")), code("HOST_SESSION_REVOKED"));
    await state(observer, first.record.id, "stopping"); await state(observer, second.record.id, "cancelled");
    release.resolve(); await state(observer, first.record.id, "cancelled"); assert.equal(executions, 1);
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("host close rejects new admission, cancels queued jobs and holds resources until the running renderer settles", async () => {
  const root = await temp(), started = deferred(), release = deferred(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => { started.resolve(); await release.promise; return result(mode); }) });
    const session = await seed(host), first = await session.jobs.submit(submission()); await started.promise;
    const second = await session.jobs.submit(submission("queued")); let closed = false;
    const closing = host.close().then(() => { closed = true; }); await tick();
    assert.equal(host.status().state, "draining"); assert.equal(closed, false); await readFile(join(root, "host.lock"));
    await assert.rejects(session.jobs.submit(submission("late")), code("HOST_CLOSED"));
    release.resolve(); await closing;
    host = await openCreativeHost({ directory: root }); const reopened = actor(host);
    assert.equal((await reopened.jobs.get(first.record.id))!.state, "cancelled"); assert.equal((await reopened.jobs.get(second.record.id))!.state, "cancelled");
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("plugin activation drains already admitted background work before changing the catalogue", async () => {
  const root = await temp(), started = deferred(), release = deferred(); let host: CreativeHost | undefined;
  const plugin: CreativePluginFactory = { id: "test.job-switch", version: "1.0.0", create: () => ({
    manifest: { id: "test.job-switch", version: "1.0.0", name: "Job switch", description: "Job drain fixture", toolIds: [] }, tools: [],
  }) };
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => { started.resolve(); await release.promise; return result(mode); }) });
    const session = await seed(host), first = await session.jobs.submit(submission()); await started.promise;
    assert.equal(host.plugins.install(plugin).ok, true); let activated = false;
    const transition = host.plugins.activate(plugin.id, plugin.version).then(value => { activated = true; return value; });
    await tick(); assert.equal(activated, false); assert.equal(host.status().state, "switching");
    await assert.rejects(session.jobs.submit(submission("switching")), code("HOST_PLUGIN_SWITCHING"));
    release.resolve(); assert.equal((await transition).ok, true); assert.equal((await session.jobs.get(first.record.id))!.state, "succeeded");
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("admission pins immutable snapshot dependencies across editing, release attempts and GC", async () => {
  const root = await temp(), started = deferred<ProjectGraphRenderRequest>(), release = deferred(); let host: CreativeHost | undefined;
  try {
    const artifacts = new FileSystemArtifactStore(join(root, "artifacts"));
    const artifact = await artifacts.put({ bytes: new TextEncoder().encode("retained chart source"), kind: "data", mediaType: "text/plain" });
    const lifecycle = new LocalArtifactLifecycleManager(artifacts, new FileSystemArtifactReferenceStore(join(root, "references")));
    const workspace = await FileSystemProjectWorkspace.open(join(root, "projects"), lifecycle);
    const project = createEmptyProject({ id: "p", name: "Retained input", episodeId: "approved", durationFrames: 30 });
    project.assets.push({ id: "source", kind: "data", uri: artifact.uri, contentHash: artifact.contentHash });
    await workspace.create(project); await workspace.saveSnapshot("p", "revision-initial", { id: "baseline", createdAt: new Date().toISOString() }); await workspace.close();
    host = await openCreativeHost({ directory: root, renderer: renderer(async (request, mode) => { started.resolve(request); await release.promise; return result(mode); }) });
    const session = actor(host), blob = join(root, "artifacts", "blobs", artifact.contentHash.slice(0, 2), artifact.contentHash);
    const original = await readFile(blob); await writeFile(blob, "tampered dependency");
    await assert.rejects(session.jobs.submit(submission())); assert.equal((await session.jobs.list()).total, 0);
    await writeFile(blob, original);
    const first = await session.jobs.submit(submission()), rendered = await started.promise;
    await invoke(session, "project.patch.remove", { schemaVersion: "1.3.0", projectId: "p", baseRevisionId: "revision-initial", patches: [{ op: "remove-asset", assetId: "source" }] });
    assert.equal(rendered.project.assets[0].contentHash, artifact.contentHash);
    await assert.rejects(host.maintenance.releaseSnapshot("p", "baseline"), code("HOST_SNAPSHOT_RETAINED"));
    assert.equal((await host.maintenance.collectGarbage(0)).deleted.includes(artifact.id), false);
    await session.jobs.cancel(first.record.id); release.resolve(); await state(session, first.record.id, "cancelled");
    await host.maintenance.releaseSnapshot("p", "baseline"); assert.equal((await host.maintenance.collectGarbage(0)).deleted.includes(artifact.id), true);
  } finally { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("background admission rejects mutable external assets without reserving a job identity", async () => {
  const root = await temp(); let host: CreativeHost | undefined;
  try {
    const lifecycle = new LocalArtifactLifecycleManager(new FileSystemArtifactStore(join(root, "artifacts")), new FileSystemArtifactReferenceStore(join(root, "references")));
    const workspace = await FileSystemProjectWorkspace.open(join(root, "projects"), lifecycle);
    const project = createEmptyProject({ id: "p", name: "External", episodeId: "approved" }); project.assets.push({ id: "external", kind: "data", uri: "https://example.test/mutable.json" });
    await workspace.create(project); await workspace.saveSnapshot("p", "revision-initial", { id: "baseline", createdAt: new Date().toISOString() }); await workspace.close();
    host = await openCreativeHost({ directory: root }); const session = actor(host);
    await assert.rejects(session.jobs.submit(submission()), code("HOST_JOB_ASSET_UNRETAINED")); assert.equal((await session.jobs.list()).total, 0);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("invalid renderer receipts fail before publication; a publication failure keeps uncertainty and input retention", async () => {
  const root = await temp(); let host: CreativeHost | undefined, invalid = true;
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => ({ ...result(mode), rendererVersion: invalid ? "wrong" : "1.0.0" })) });
    const session = await seed(host), first = await session.jobs.submit(submission());
    const failed = await state(session, first.record.id, "failed"); assert.equal(failed.outcomeUnknown, false); assert.equal(failed.publicationStartedAt, undefined);
    invalid = false; await mkdir(join(root, "artifacts"), { recursive: true }); await writeFile(join(root, "artifacts", "metadata"), "blocked publication");
    const second = await session.jobs.submit(submission("publication")), uncertain = await state(session, second.record.id, "failed");
    assert.equal(uncertain.outcomeUnknown, true); assert.ok(uncertain.publicationStartedAt); assert.equal(uncertain.result, undefined);
    await assert.rejects(host.maintenance.releaseSnapshot("p", "baseline"), code("HOST_SNAPSHOT_RETAINED"));
    await rm(join(root, "artifacts", "metadata")); const third = await session.jobs.submit(submission("recovered")); await state(session, third.record.id, "succeeded");
    await host.close(); host = await openCreativeHost({ directory: root }); assert.deepEqual(await actor(host).jobs.get(uncertain.id), uncertain);
    await assert.rejects(host.maintenance.releaseSnapshot("p", "baseline"), code("HOST_SNAPSHOT_RETAINED"));
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("progress floods are coalesced and callbacks after completion cannot change terminal evidence", async () => {
  const root = await temp(); let host: CreativeHost | undefined, report: ProjectGraphRenderRequest["onProgress"];
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (request, mode) => {
      report = request.onProgress; for (let i = 0; i <= 10000; i++) report!({ phase: "rendering", fraction: i / 10000 }); return result(mode);
    }) }); const session = await seed(host), first = await session.jobs.submit(submission()), done = await state(session, first.record.id, "succeeded");
    assert.ok(done.revision <= 6, `Unbounded progress writes: ${done.revision}`); report!({ phase: "rendering", fraction: 0 }); await tick();
    assert.deepEqual(await session.jobs.get(done.id), done);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a durable publication barrier explicitly declines cancellation and settles publication across revocation", async () => {
  const root = await temp(), publishing = deferred(), release = deferred(); let host: CreativeHost | undefined;
  const original = FileSystemArtifactStore.prototype.put;
  FileSystemArtifactStore.prototype.put = async function (input) { publishing.resolve(); await release.promise; return original.call(this, input); };
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => result(mode)) });
    const session = await seed(host), observer = actor(host), first = await session.jobs.submit(submission()); await publishing.promise;
    const cancel = await observer.jobs.cancel(first.record.id); assert.equal(cancel.accepted, false); assert.equal(cancel.record.state, "publishing");
    session.revoke(); await tick(); assert.equal((await observer.jobs.get(first.record.id))!.state, "publishing");
    release.resolve(); const done = await state(observer, first.record.id, "succeeded"); assert.equal(done.stop, undefined);
  } finally { release.resolve(); await host?.close(); FileSystemArtifactStore.prototype.put = original; await rm(root, { recursive: true, force: true }); }
});

test("transport trace loss after job admission reports uncertainty and drains without dispatching the next request", async () => {
  const root = await temp(); let host: CreativeHost | undefined;
  const input = new PassThrough(), responses: any[] = [];
  const output = new Writable({ write(chunk, _encoding, done) { responses.push(JSON.parse(chunk.toString())); done(); } });
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => result(mode)) }); const session = await seed(host);
    const serving = serveCreativeStdio({ session, input, output, protocolVersion: "1.1.0", maxRequestBytes: 8192,
      trace: { record: async (kind, data) => { if (kind === "response" && (data as { id?: string }).id === "admit") throw new Error("Trace unavailable after admission"); } },
      close: async () => { session.revoke(); await host!.close(); } });
    input.end(["admit", "later"].map(id => JSON.stringify({ id, method: "jobs.submit", params: submission(id) }) + "\n").join(""));
    assert.equal(await serving, false); assert.equal(responses.at(-1).error.outcomeUnknown, true); assert.equal(responses.at(-1).error.fatal, true);
    host = await openCreativeHost({ directory: root }); const records = await actor(host).jobs.list(); assert.equal(records.total, 1);
    assert.equal(records.jobs[0].input.submissionId, "admit"); assert.ok(["cancelled", "succeeded"].includes(records.jobs[0].state));
  } finally { input.end(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("uncertain admission persistence fails the host and releases resources only after draining", async () => {
  const root = await temp(); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root }); const session = await seed(host);
    const ledger = join(root, "jobs", "jobs.json"), backup = join(root, "jobs", "backup.json"); await rename(ledger, backup); await mkdir(ledger);
    await assert.rejects(session.jobs.submit(submission()), code("RENDER_JOB_PERSISTENCE_UNCERTAIN")); assert.equal(host.status().state, "failed");
    await assert.rejects(session.jobs.list(), code("HOST_CLOSED")); await assert.rejects(host.close()); host = undefined;
    await rm(ledger, { recursive: true }); await rename(backup, ledger);
    host = await openCreativeHost({ directory: root }); assert.equal((await actor(host).jobs.list()).total, 0);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("protocol 1.1 submits, queries and cancels through one live stream while rendering is blocked", { timeout: 15000 }, async () => {
  const root = await temp(), started = deferred(), release = deferred(); let host: CreativeHost | undefined;
  const input = new PassThrough(), waiting = new Map<string, (value: any) => void>(); const messages: any[] = [];
  const output = new Writable({ write(chunk, _encoding, done) { const value = JSON.parse(chunk.toString()); messages.push(value); waiting.get(value.id)?.(value); done(); } });
  const send = (id: string, method: string, params: unknown = {}) => new Promise<any>(resolve => { waiting.set(id, resolve); input.write(JSON.stringify({ id, method, params }) + "\n"); });
  let serving: Promise<boolean> | undefined;
  try {
    host = await openCreativeHost({ directory: root, renderer: renderer(async (_request, mode) => { started.resolve(); await release.promise; return result(mode); }) }); const session = await seed(host);
    serving = serveCreativeStdio({ session, input, output, protocolVersion: "1.1.0", trace: { record: async () => {} }, maxRequestBytes: 8192,
      close: async () => { session.revoke(); await host!.close(); } });
    const submitted = await send("submit", "jobs.submit", submission()); assert.equal(submitted.ok, true); const id = submitted.result.record.id;
    await started.promise; assert.equal((await send("get", "jobs.get", { jobId: id })).result.state, "running");
    assert.equal((await send("list", "jobs.list")).result.total, 1);
    assert.equal((await send("cancel", "jobs.cancel", { jobId: id })).result.record.state, "stopping");
    assert.equal((await send("again", "jobs.get", { jobId: id })).result.completedAt, undefined);
    assert.equal((await send("injection", "jobs.get", { jobId: id, projectId: "foreign" })).ok, false);
    release.resolve(); await state(session, id, "cancelled"); assert.equal((await send("close", "close")).ok, true); assert.equal(await serving, true);
    assert.equal(messages[0].protocolVersion, "1.1.0"); assert.equal(messages[0].jobsVersion, "1.0.0"); assert.ok(messages[0].methods.includes("jobs.cancel"));
  } finally { release.resolve(); input.end(); await serving?.catch(() => undefined); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("protocol 1.0 stays unchanged and trusted 1.1 configuration validates job bounds", async () => {
  assert.throws(() => parseCreativeRequest({ id: "job", method: "jobs.submit", params: submission() }), code("TRANSPORT_METHOD_UNKNOWN"));
  assert.equal(parseCreativeRequest({ id: "job", method: "jobs.submit", params: submission() }, "1.1.0").method, "jobs.submit");
  const root = await temp(), path = join(root, "config.json");
  const config = { schemaVersion: "1.0.0", protocolVersion: "1.1.0", directory: "host", traceFile: "trace.jsonl", grant: { projectId: "p" }, renderJobs: { maxActiveJobs: 2, timeoutMs: 1000 } };
  try {
    await writeFile(path, JSON.stringify(config)); assert.equal((await readCreativeLocalConfig(path)).protocolVersion, "1.1.0");
    for (const bad of [{ ...config, protocolVersion: "2.0.0" }, { ...config, renderJobs: { maxActiveJobs: 0 } }, { ...config, renderJobs: { timeoutMs: 0 } }]) {
      await writeFile(path, JSON.stringify(bad)); await assert.rejects(readCreativeLocalConfig(path));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
