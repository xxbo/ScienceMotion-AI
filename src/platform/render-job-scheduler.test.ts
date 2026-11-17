import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeHost, CreativeSession, CreativePluginFactory } from "../contracts/creative-host";
import type { CreativeJobPolicy, CreativeJobSubmission } from "../contracts/creative-jobs";
import type { ProjectGraphPreviewRequest, ProjectGraphRenderOutput, ProjectGraphSnapshotRenderer } from "../contracts/renderer";
import { openCreativeHost } from "./creative-host";
import { creativeJobPolicy } from "./creative-job-input";
import { readCreativeLocalConfig } from "./creative-local-server";
import { FileSystemArtifactStore } from "./artifact-store";

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "Scheduler condition timed out"); await pause(); }
}
const actor = (host: CreativeHost, projectId = "a") => host.createSession({ projectId,
  toolIds: ["project.create", "project.snapshot.save", "render.preview"],
  permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write"] });
async function seed(host: CreativeHost, projectId = "a") {
  const session = actor(host, projectId);
  for (const [toolId, input] of [["project.create", { name: projectId, episodeId: "scheduler", durationFrames: 30, width: 640, height: 360 }],
    ["project.snapshot.save", { snapshotId: "snap-" + projectId, revisionId: "revision-initial" }]] as Array<[string, unknown]>) {
    const result = await session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "seed", callId: toolId });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  return session;
}
const request = (frame: number, projectId = "a"): CreativeJobSubmission => ({ submissionId: "frame-" + frame, runId: "scheduler", callId: "frame-" + frame,
  toolId: "render.preview", toolVersion: "1.0.0", input: { snapshotId: "snap-" + projectId, frame } });
const submit = (session: CreativeSession, frame: number) => session.jobs.submit(request(frame, session.projectId));
async function state(session: CreativeSession, id: string, expected: string) {
  await until(async () => (await session.jobs.get(id))?.state === expected);
  return (await session.jobs.get(id))!;
}
function controlled() {
  const starts: string[] = [], requests = new Map<string, ProjectGraphPreviewRequest>(), gates = new Map<string, ReturnType<typeof deferred<Error | undefined>>>();
  let active = 0, peak = 0, released = false;
  const renderer: ProjectGraphSnapshotRenderer = { id: "test.scheduler", version: "1.0.0",
    async renderPreview(req): Promise<ProjectGraphRenderOutput> {
      const key = req.project.project.id + ":" + req.frame, gate = deferred<Error | undefined>();
      starts.push(key); requests.set(key, req); gates.set(key, gate); active++; peak = Math.max(peak, active);
      try {
        const failure = released ? undefined : await gate.promise; if (failure) throw failure;
        return { rendererId: this.id, rendererVersion: this.version, bytes: new Uint8Array([137,80,78,71,13,10,26,10,req.frame,req.project.project.id.charCodeAt(0)]),
          mediaType: "image/png", extension: "png" };
      } finally { active--; }
    }, async renderVideo() { throw new Error("Unused"); } };
  return { renderer, starts, requests, get active() { return active; }, get peak() { return peak; },
    started: (key: string) => until(() => starts.includes(key)),
    finish: (key: string, error?: Error) => { assert.ok(gates.has(key), "Not running: " + key); gates.get(key)!.resolve(error); },
    releaseAll: () => { released = true; for (const gate of gates.values()) gate.resolve(undefined); } };
}
async function fixture(policy: Partial<CreativeJobPolicy>, work: (host: CreativeHost, control: ReturnType<typeof controlled>, root: string) => Promise<void>, allowFailedClose = false) {
  const root = await mkdtemp(join(tmpdir(), "science-scheduler-")), control = controlled();
  let host: CreativeHost | undefined;
  try { host = await openCreativeHost({ directory: root, renderer: control.renderer, renderJobs: policy }); await work(host, control, root); }
  finally {
    control.releaseAll();
    try { if (allowFailedClose) await host?.close().catch(() => undefined); else await host?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("scheduler configuration separates waiting/running counts, preserves legacy limits and rejects incompatible workers before locking", async () => {
  assert.deepEqual(creativeJobPolicy(), { maxQueuedJobs: 7, maxConcurrentJobs: 1, timeoutMs: 30000 });
  assert.deepEqual(creativeJobPolicy({ maxActiveJobs: 2, timeoutMs: 500 }), { maxQueuedJobs: 1, maxConcurrentJobs: 1, timeoutMs: 500 });
  assert.deepEqual(creativeJobPolicy({ maxQueuedJobs: 0, maxConcurrentJobs: 2 }), { maxQueuedJobs: 0, maxConcurrentJobs: 2, timeoutMs: 30000 });
  for (const invalid of [{ maxActiveJobs: 2, maxQueuedJobs: 1 }, { maxActiveJobs: 2, maxConcurrentJobs: 1 },
    { maxQueuedJobs: -1 }, { maxConcurrentJobs: 0 }, { maxConcurrentJobs: 5 }, { maxQueuedJobs: 31, maxConcurrentJobs: 2 },
    { maxQueuedJobs: null }, { maxConcurrentJobs: 1.5 }, { timeoutMs: null }, { unknown: true }])
    assert.throws(() => creativeJobPolicy(invalid as unknown as Partial<CreativeJobPolicy>));
  const root = await mkdtemp(join(tmpdir(), "science-scheduler-config-"));
  try {
    await assert.rejects(openCreativeHost({ directory: join(root, "host"), renderWorker: {}, renderJobs: { maxConcurrentJobs: 2 } }), { code: "HOST_JOB_CONFIG" });
    assert.deepEqual(await readdir(root), []);
    const config = { schemaVersion: "1.0.0", protocolVersion: "1.1.0", directory: "host", traceFile: "trace.jsonl", grant: { projectId: "a" },
      renderJobs: { maxConcurrentJobs: 2, maxQueuedJobs: 3 }, renderWorker: { maxConcurrentJobs: 2 } };
    await writeFile(join(root, "config.json"), JSON.stringify(config));
    assert.deepEqual((await readCreativeLocalConfig(join(root, "config.json"))).renderJobs, config.renderJobs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two executors overlap with a bounded queue; queued cancellation frees waiting capacity while stopping retains its execution slot", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1 }, async (host, c) => {
    const session = await seed(host), first = await submit(session, 0), second = await submit(session, 1);
    await Promise.all([c.started("a:0"), c.started("a:1")]); assert.equal(c.active, 2);
    const queued = await submit(session, 2); assert.equal(queued.record.state, "queued");
    await assert.rejects(submit(session, 3), { code: "HOST_JOB_CAPACITY" });
    assert.equal((await submit(session, 2)).created, false);
    await assert.rejects(session.jobs.submit({ ...request(2), callId: "conflict" }), { code: "RENDER_JOB_CONFLICT" });
    assert.equal((await session.jobs.cancel(queued.record.id)).record.state, "cancelled");
    const replacement = await submit(session, 3); assert.equal(replacement.record.startedAt, undefined);
    assert.equal((await session.jobs.cancel(first.record.id)).record.state, "stopping");
    assert.equal(c.requests.get("a:0")!.signal!.aborted, true); assert.equal(c.requests.get("a:1")!.signal!.aborted, false);
    await assert.rejects(submit(session, 4), { code: "HOST_JOB_CAPACITY" });
    assert.deepEqual(c.starts, ["a:0", "a:1"]);
    c.finish("a:0"); await state(session, first.record.id, "cancelled"); await c.started("a:3");
    assert.equal(c.peak, 2); assert.equal(c.active, 2);
    c.finish("a:1"); c.finish("a:3");
    for (const job of [second, replacement]) await state(session, job.record.id, "succeeded");
    assert.equal((await session.jobs.list()).total, 4, "Rejected requests must not reserve submission identities");
  });
});

test("zero waiting capacity admits free execution slots and rejects overflow without creating a job", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 0 }, async (host, c) => {
    const s = await seed(host), a = await submit(s, 0), b = await submit(s, 1);
    await Promise.all([c.started("a:0"), c.started("a:1")]);
    await assert.rejects(submit(s, 2), { code: "HOST_JOB_CAPACITY" }); assert.equal((await s.jobs.list()).total, 2);
    c.finish("a:0"); await state(s, a.record.id, "succeeded");
    const next = await submit(s, 2); await c.started("a:2"); assert.equal(c.peak, 2);
    c.finish("a:1"); c.finish("a:2"); await state(s, b.record.id, "succeeded"); await state(s, next.record.id, "succeeded");
  });
});

test("waiting projects rotate fairly while each project keeps FIFO order and cancelled entries never execute", async () => {
  await fixture({ maxConcurrentJobs: 1, maxQueuedJobs: 8 }, async (host, c) => {
    const a = await seed(host, "a"), b = await seed(host, "b"), d = await seed(host, "c");
    await submit(a, 0); await c.started("a:0");
    for (const frame of [1, 2, 3]) await submit(a, frame);
    for (const frame of [0, 1]) await submit(b, frame);
    const cancelled = await submit(d, 0); await submit(d, 1); await d.jobs.cancel(cancelled.record.id);
    const expected = ["a:0", "a:1", "b:0", "c:1", "a:2", "b:1", "a:3"];
    for (let i = 1; i < expected.length; i++) {
      c.finish(expected[i - 1]); await c.started(expected[i]); assert.deepEqual(c.starts, expected.slice(0, i + 1));
    }
    c.finish(expected.at(-1)!); assert.equal(c.peak, 1);
    assert.equal((await d.jobs.get(cancelled.record.id))!.startedAt, undefined);
  });
});

test("session revocation cancels only its jobs across concurrent executors and preserves other sessions", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1 }, async (host, c, root) => {
    const owner = await seed(host), other = actor(host), a = await submit(owner, 0), b = await submit(other, 1);
    await Promise.all([c.started("a:0"), c.started("a:1")]); const queued = await submit(owner, 2);
    owner.revoke(); await state(other, queued.record.id, "cancelled"); await state(other, a.record.id, "stopping");
    assert.equal(c.requests.get("a:1")!.signal!.aborted, false);
    const next = await submit(other, 3); assert.deepEqual(c.starts, ["a:0", "a:1"]);
    c.finish("a:0"); await c.started("a:3"); await state(other, a.record.id, "cancelled");
    assert.deepEqual(await new FileSystemArtifactStore(join(root, "artifacts")).list(), []);
    c.finish("a:1"); c.finish("a:3"); await state(other, b.record.id, "succeeded"); await state(other, next.record.id, "succeeded");
  });
});

test("close drains every running executor before releasing locks and cancels the waiting queue", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1 }, async (host, c, root) => {
    const s = await seed(host), a = await submit(s, 0), b = await submit(s, 1), queued = await submit(s, 2);
    await Promise.all([c.started("a:0"), c.started("a:1")]);
    let closed = false; const closing = host.close().then(() => { closed = true; });
    await until(() => [...c.requests.values()].every(r => r.signal!.aborted));
    await assert.rejects(submit(s, 3), { code: "HOST_CLOSED" });
    c.finish("a:0"); await until(() => c.active === 1);
    assert.equal(closed, false); await readFile(join(root, "host.lock")); assert.equal(c.starts.includes("a:2"), false);
    c.finish("a:1"); await closing; assert.equal(closed, true);
    const reopened = await openCreativeHost({ directory: root, renderer: c.renderer });
    try { for (const job of [a, b, queued]) assert.equal((await actor(reopened).jobs.get(job.record.id))!.state, "cancelled"); }
    finally { await reopened.close(); }
  });
});

test("plugin activation drains multiple executors and their waiting jobs before switching", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1 }, async (host, c) => {
    const s = await seed(host), a = await submit(s, 0), b = await submit(s, 1), queued = await submit(s, 2);
    await Promise.all([c.started("a:0"), c.started("a:1")]);
    const plugin: CreativePluginFactory = { id: "test.scheduler-switch", version: "1.0.0", create: () => ({
      manifest: { id: "test.scheduler-switch", version: "1.0.0", name: "Scheduler drain", description: "Concurrent drain regression", toolIds: [] }, tools: [] }) };
    assert.equal(host.plugins.install(plugin).ok, true);
    let activated = false; const switching = host.plugins.activate(plugin.id, plugin.version).then(result => { activated = true; return result; });
    await assert.rejects(submit(s, 3), { code: "HOST_PLUGIN_SWITCHING" });
    c.finish("a:0"); await c.started("a:2"); c.finish("a:1"); await until(() => c.active === 1);
    assert.equal(activated, false); c.finish("a:2"); assert.equal((await switching).ok, true);
    for (const job of [a, b, queued]) await state(s, job.record.id, "succeeded");
    assert.equal(host.status().state, "ready");
  });
});

test("a fatal cleanup failure stops dispatch and suppresses a sibling late result without releasing ownership before it settles", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1 }, async (host, c, root) => {
    const s = await seed(host); await submit(s, 0); await submit(s, 1); await submit(s, 2);
    await Promise.all([c.started("a:0"), c.started("a:1")]);
    c.finish("a:0", Object.assign(new Error("Injected cleanup failure"), { code: "RENDER_WORKER_CLEANUP" }));
    await until(() => host.status().state === "failed"); assert.equal(c.requests.get("a:1")!.signal!.aborted, true);
    let settled = false; const closing = host.close().then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await pause(); assert.equal(settled, false); await readFile(join(root, "host.lock")); assert.equal(c.starts.includes("a:2"), false);
    c.finish("a:1"); assert.ok((await closing) instanceof AggregateError);
    assert.deepEqual(await new FileSystemArtifactStore(join(root, "artifacts")).list(), []);
    const ledger = JSON.parse(await readFile(join(root, "jobs/jobs.json"), "utf8"));
    assert.equal(ledger.records.some((record: { state: string }) => record.state === "succeeded"), false);
    const recovered = await openCreativeHost({ directory: root, renderer: c.renderer });
    try {
      const records = (await actor(recovered).jobs.list()).jobs;
      assert.equal(records.filter(record => record.state === "interrupted").length, 2);
      assert.equal(records.filter(record => record.state === "cancelled").length, 1);
      assert.deepEqual(c.starts, ["a:0", "a:1"], "Recovery must not replay either unresolved render");
    } finally { await recovered.close(); }
  }, true);
});

test("publication keeps its execution slot and refuses cancellation until the committed output is settled", async () => {
  const publication = deferred(), release = deferred(), original = FileSystemArtifactStore.prototype.put;
  try {
    await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1 }, async (host, c) => {
      try {
      const s = await seed(host), a = await submit(s, 0), b = await submit(s, 1), queued = await submit(s, 2);
      await Promise.all([c.started("a:0"), c.started("a:1")]);
      FileSystemArtifactStore.prototype.put = async function(input) { publication.resolve(); await release.promise; return original.call(this, input); };
      c.finish("a:0"); await publication.promise;
      assert.equal((await s.jobs.cancel(a.record.id)).accepted, false);
      assert.equal((await s.jobs.get(a.record.id))!.state, "publishing"); assert.equal((await s.jobs.get(queued.record.id))!.state, "queued");
      assert.deepEqual(c.starts, ["a:0", "a:1"]);
      release.resolve(); await state(s, a.record.id, "succeeded"); await c.started("a:2");
      c.finish("a:1"); c.finish("a:2"); await state(s, b.record.id, "succeeded"); await state(s, queued.record.id, "succeeded");
      } finally { release.resolve(); FileSystemArtifactStore.prototype.put = original; }
    });
  } finally { release.resolve(); FileSystemArtifactStore.prototype.put = original; }
});

test("each executor has its own deadline; waiting time does not consume the next job's deadline", async () => {
  await fixture({ maxConcurrentJobs: 2, maxQueuedJobs: 1, timeoutMs: 300 }, async (host, c) => {
    const s = await seed(host), a = await submit(s, 0), b = await submit(s, 1), queued = await submit(s, 2);
    await Promise.all([c.started("a:0"), c.started("a:1")]);
    await state(s, a.record.id, "stopping"); await state(s, b.record.id, "stopping");
    assert.equal((await s.jobs.get(queued.record.id))!.startedAt, undefined);
    c.finish("a:0"); await c.started("a:2"); c.finish("a:2");
    await state(s, queued.record.id, "succeeded"); c.finish("a:1");
    for (const job of [a, b]) assert.equal((await state(s, job.record.id, "timed-out")).stop!.reason, "timed-out");
    assert.equal(c.peak, 2);
  });
});
