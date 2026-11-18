import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderJobCompletion, RenderJobRecord, RenderJobReceipt, RenderJobSubmission } from "../contracts/render-job";
import { FileSystemRenderJobStore } from "./filesystem-render-job-store";
import { InMemoryRenderJobStore } from "./render-job-store";
import { validateJobRecord } from "./render-job-validation";
import { hashToolInput } from "./tool-execution-store";

const input = (submissionId = "once", projectId = "p"): RenderJobSubmission => ({ projectId, submissionId, runId: "run", callId: "call", toolVersion: "1.0.0",
  snapshot: { id: "snapshot", revisionId: "revision", contentHash: "a".repeat(64) }, render: { operation: "video", startFrame: 0, durationFrames: 360 },
  profile: { width: 960, height: 540, fps: 30 }, renderer: { id: "remotion.project-graph", version: "1.0.0" } });
const receipt = (record: RenderJobRecord): RenderJobReceipt => ({ jobId: record.id, inputHash: record.inputHash, artifactId: `sha256:${"b".repeat(64)}`,
  contentHash: "b".repeat(64), sizeBytes: 4096, mediaType: record.input.render.operation === "preview" ? "image/png" : "video/mp4",
  rendererId: record.input.renderer.id, rendererVersion: record.input.renderer.version });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const temp = () => mkdtemp(join(tmpdir(), "science-job-ledger-"));
const code = (value: string) => ({ code: value });

test("job submissions elect one project-scoped identity; canonical retries cannot replace admitted input", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    const values = await Promise.all(Array.from({ length: 30 }, () => store.submit(input())));
    assert.equal(values.filter(value => value.created).length, 1); assert.equal(new Set(values.map(value => value.record.id)).size, 1);
    const first = values[0].record;
    const { renderer, ...otherFields } = input();
    assert.equal((await store.submit({ renderer, ...otherFields })).record.id, first.id);
    for (const changed of [{ ...input(), snapshot: { ...input().snapshot, contentHash: "c".repeat(64) } },
      { ...input(), render: { operation: "video" as const, startFrame: 1, durationFrames: 360 } },
      { ...input(), toolVersion: "2" }, { ...input(), runId: "different" }])
      await assert.rejects(store.submit(changed), code("RENDER_JOB_CONFLICT"));
    assert.notEqual((await store.submit(input("once", "other-project"))).record.id, first.id);
    assert.notEqual((await store.submit(input("c", "a:b"))).record.id, (await store.submit(input("b:c", "a"))).record.id);
    assert.deepEqual((await store.list("p")).jobs, [first]);
    const claims = await Promise.allSettled(Array.from({ length: 20 }, () => store.claim("p", first.id)));
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  } finally { await store.close(); }
});

test("job input, results and pages cannot be mutated through caller aliases; project scope is mandatory", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    const value = input(), pending = store.submit(value); value.snapshot.id = "caller mutation";
    const { record } = await pending, original = structuredClone(record);
    record.input.profile.width = 1;
    const found = (await store.get("p", record.id))!; found.input.snapshot.id = "returned mutation";
    const page = await store.list("p"); page.jobs[0].input.renderer.id = "page mutation";
    assert.deepEqual(await store.get("p", record.id), original);
    assert.equal(await store.get("other", record.id), undefined); assert.equal((await store.list("other")).total, 0);
    await assert.rejects(store.claim("other", record.id), code("RENDER_JOB_NOT_FOUND"));
    await assert.rejects(store.requestStop("other", record.id, "cancelled"), code("RENDER_JOB_NOT_FOUND"));
    await store.submit(input("second")); assert.equal((await store.list("p", { offset: 1, limit: 1 })).jobs.length, 1);
    assert.equal((await store.list("p", { offset: 10 })).jobs.length, 0);
    await assert.rejects(store.list("p", { limit: 201 }), code("RENDER_JOB_INVALID"));
  } finally { await store.close(); }
});

test("running cancellation retains ownership until explicit cleanup acknowledgement and forbids late success", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    const { record } = await store.submit(input()), owner = await store.claim("p", record.id);
    await assert.rejects(store.beginPublication("p", record.id, "foreign"), code("RENDER_JOB_NOT_OWNED"));
    const stopped = await store.requestStop("p", record.id, "cancelled");
    assert.equal(stopped.accepted, true); assert.equal(stopped.record.state, "stopping"); assert.equal(stopped.record.completedAt, undefined);
    assert.deepEqual((await store.requestStop("p", record.id, "timed-out")).record, stopped.record);
    await assert.rejects(store.beginPublication("p", record.id, owner.token), code("RENDER_JOB_STATE"));
    await assert.rejects(store.finish("p", record.id, owner.token, { state: "succeeded", result: receipt(record) }), code("RENDER_JOB_STATE"));
    await assert.rejects(store.finish("p", record.id, owner.token, { state: "timed-out" }), code("RENDER_JOB_STATE"));
    const final = await store.finish("p", record.id, owner.token, { state: "cancelled" });
    assert.equal(final.state, "cancelled"); assert.equal(final.outcomeUnknown, false); assert.equal(final.result, undefined);
    await assert.rejects(store.finish("p", record.id, owner.token, { state: "failed", diagnostic: { code: "LATE", message: "Late failure" } }), code("RENDER_JOB_NOT_OWNED"));
    assert.deepEqual((await store.submit(input())).record, final); assert.equal((await store.requestStop("p", record.id, "cancelled")).accepted, false);
  } finally { await store.close(); }
});

test("queued stops need no executor; running deadlines cannot be overwritten by subsequent cancellation", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    for (const reason of ["cancelled", "timed-out"] as const) {
      const queued = (await store.submit(input(reason))).record;
      const stopped = await store.requestStop("p", queued.id, reason);
      assert.equal(stopped.record.state, reason); assert.equal(stopped.record.startedAt, undefined);
      await assert.rejects(store.claim("p", queued.id), code("RENDER_JOB_STATE"));
    }
    const running = (await store.submit(input("running"))).record, owner = await store.claim("p", running.id);
    await store.requestStop("p", running.id, "timed-out"); await store.requestStop("p", running.id, "cancelled");
    const final = await store.finish("p", running.id, owner.token, { state: "timed-out" });
    assert.equal(final.diagnostic!.code, "RENDER_JOB_TIMEOUT");
  } finally { await store.close(); }
});

test("publication and stop races have one winner; acknowledged cancellation never becomes success", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    for (const cancelFirst of [true, false]) {
      const { record } = await store.submit(input(String(cancelFirst))), owner = await store.claim("p", record.id);
      const operations = cancelFirst ? [store.requestStop("p", record.id, "cancelled"), store.beginPublication("p", record.id, owner.token)] :
        [store.beginPublication("p", record.id, owner.token), store.requestStop("p", record.id, "cancelled")];
      const results = await Promise.allSettled(operations);
      if (cancelFirst) {
        assert.equal(results[1].status, "rejected"); assert.equal((await store.get("p", record.id))!.state, "stopping");
        await store.finish("p", record.id, owner.token, { state: "cancelled" });
      } else {
        assert.equal(results[1].status, "fulfilled");
        assert.equal((results[1] as PromiseFulfilledResult<{ accepted: boolean }>).value.accepted, false);
        assert.equal((await store.finish("p", record.id, owner.token, { state: "succeeded", result: receipt(record) })).state, "succeeded");
      }
    }
  } finally { await store.close(); }
});

test("successful receipts bind to immutable job input and renderer; failure after publication remains uncertain", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    const { record } = await store.submit(input()), owner = await store.claim("p", record.id);
    await assert.rejects(store.finish("p", record.id, owner.token, { state: "succeeded", result: receipt(record) }), code("RENDER_JOB_STATE"));
    const barrier = await store.beginPublication("p", record.id, owner.token);
    for (const patch of [{ jobId: "foreign" }, { inputHash: "c".repeat(64) }, { artifactId: "arbitrary" }, { mediaType: "image/png" },
      { rendererVersion: "other" }, { sizeBytes: 0 }, { sizeBytes: 65 * 1024 * 1024 }]) {
      await assert.rejects(store.finish("p", record.id, owner.token, { state: "succeeded", result: { ...receipt(record), ...patch } as RenderJobReceipt }), code("RENDER_JOB_INVALID"));
      assert.deepEqual(await store.get("p", record.id), barrier);
    }
    const value: RenderJobCompletion = { state: "succeeded", result: receipt(record) }, pending = store.finish("p", record.id, owner.token, value);
    value.result.jobId = "mutated after call";
    const final = await pending; assert.equal(final.result!.jobId, record.id);
    final.result!.sizeBytes = 1; assert.equal((await store.get("p", record.id))!.result!.sizeBytes, 4096);
    for (const publishing of [false, true]) {
      const next = (await store.submit(input(`failure-${publishing}`))).record, nextOwner = await store.claim("p", next.id);
      if (publishing) await store.beginPublication("p", next.id, nextOwner.token);
      const failure = await store.finish("p", next.id, nextOwner.token, { state: "failed", diagnostic: { code: "IO_FAILED", message: "Output storage unavailable" } });
      assert.equal(failure.outcomeUnknown, publishing); assert.equal(failure.result, undefined);
    }
  } finally { await store.close(); }
});

test("progress is bounded, monotonic and throttled; phase changes persist and clock rollback cannot reorder evidence", async () => {
  let time = Date.parse("2026-11-17T00:00:00.000Z");
  const store = new InMemoryRenderJobStore({ now: () => new Date(time), progressIntervalMs: 250 });
  try {
    const { record } = await store.submit(input()), owner = await store.claim("p", record.id);
    const first = await store.progress("p", record.id, owner.token, { phase: "rendering", fraction: 0 }); assert.equal(first.updated, true);
    time += 100;
    const skipped = await store.progress("p", record.id, owner.token, { phase: "rendering", fraction: 0.2 });
    assert.equal(skipped.updated, false); assert.deepEqual(skipped.record, first.record);
    time += 150;
    assert.equal((await store.progress("p", record.id, owner.token, { phase: "rendering", fraction: 0.2 })).updated, true);
    await assert.rejects(store.progress("p", record.id, owner.token, { phase: "rendering", fraction: 0.1 }), code("RENDER_JOB_PROGRESS_REGRESSION"));
    await assert.rejects(store.progress("p", record.id, owner.token, { phase: "bundling" }), code("RENDER_JOB_PROGRESS_REGRESSION"));
    await assert.rejects(store.progress("p", record.id, owner.token, { phase: "rendering", fraction: NaN }), code("RENDER_JOB_INVALID"));
    time -= 1000;
    const encoding = await store.progress("p", record.id, owner.token, { phase: "encoding", fraction: 0.3 });
    assert.equal(encoding.updated, true); assert.equal(encoding.record.updatedAt, "2026-11-17T00:00:00.250Z");
    await store.requestStop("p", record.id, "cancelled");
    await assert.rejects(store.progress("p", record.id, owner.token, { phase: "encoding", fraction: 1 }), code("RENDER_JOB_STATE"));
    const preview = (await store.submit({ ...input("preview"), render: { operation: "preview", frame: 0 } })).record;
    const previewOwner = await store.claim("p", preview.id);
    await assert.rejects(store.progress("p", preview.id, previewOwner.token, { phase: "encoding" }), code("RENDER_JOB_INVALID"));
  } finally { await store.close(); }
});

test("invalid job inputs do not reserve identity and capacity rejection never evicts retained submissions", async () => {
  const store = new InMemoryRenderJobStore({ maxJobs: 1 });
  try {
    const bad = [null, { ...input(), path: "/injected" }, { ...input(), profile: { width: 0, height: 1, fps: 30 } },
      { ...input(), render: { operation: "video", startFrame: 0, durationFrames: 901 } },
      { ...input(), render: { operation: "preview", frame: 0, durationFrames: 1 } },
      { ...input(), snapshot: { ...input().snapshot, contentHash: "invalid" } }, { ...input(), submissionId: "x".repeat(129) },
      { ...input(), extra: undefined }, { ...input(), snapshot: new Date() }];
    for (const value of bad) await assert.rejects(store.submit(value as RenderJobSubmission), code("RENDER_JOB_INVALID"));
    assert.equal((await store.list("p")).total, 0);
    const { record } = await store.submit(input()); await store.requestStop("p", record.id, "cancelled");
    await assert.rejects(store.submit(input("second")), code("RENDER_JOB_CAPACITY"));
    assert.equal((await store.submit(input())).created, false); assert.equal((await store.list("p")).total, 1);
    const bytes = new InMemoryRenderJobStore({ maxLedgerBytes: 18 * 1024 });
    try {
      const first = (await bytes.submit(input())).record;
      await assert.rejects(bytes.submit(input("over-budget")), code("RENDER_JOB_CAPACITY"));
      assert.equal((await bytes.list("p")).total, 1);
      const owner = await bytes.claim("p", first.id);
      const final = await bytes.finish("p", first.id, owner.token, { state: "failed", diagnostic: { code: "FAILURE", message: "x".repeat(2048) } });
      assert.equal(final.state, "failed"); // Admission reserved this terminal-growth budget.
    } finally { await bytes.close(); }
  } finally { await store.close(); }
});

test("admission acknowledgements wait for persistence; close drains admitted work and immediately rejects later calls", async () => {
  const entered = deferred(), allow = deferred(); let acknowledged = false;
  class SlowStore extends InMemoryRenderJobStore { protected override async persist() { entered.resolve(); await allow.promise; } }
  const store = new SlowStore();
  const pending = store.submit(input()).then(result => { acknowledged = true; return result; });
  await entered.promise; assert.equal(acknowledged, false);
  let closed = false; const closing = store.close().then(() => { closed = true; });
  await assert.rejects(store.submit(input("later")), code("RENDER_JOB_CLOSED")); await tick(); assert.equal(closed, false);
  allow.resolve(); assert.equal((await pending).created, true); await closing;
  await assert.rejects(store.get("p", "missing"), code("RENDER_JOB_CLOSED")); await store.close();
});

test("filesystem ledger preserves terminal output, isolates project reads and recovers every active state once", async () => {
  const root = await temp(); let store = await FileSystemRenderJobStore.open(root);
  const active: RenderJobRecord[] = []; const tokens: string[] = [];
  try {
    for (const state of ["queued", "running", "stopping", "publishing"]) {
      const { record } = await store.submit(input(state)); active.push(record);
      if (state !== "queued") {
        const owner = await store.claim("p", record.id); tokens.push(owner.token);
        await store.progress("p", record.id, owner.token, { phase: "rendering", fraction: 0.4 });
        if (state === "stopping") await store.requestStop("p", record.id, "cancelled");
        if (state === "publishing") await store.beginPublication("p", record.id, owner.token);
      }
    }
    const success = (await store.submit({ ...input("success"), render: { operation: "preview", frame: 45 } })).record;
    const owner = await store.claim("p", success.id); tokens.push(owner.token);
    await store.beginPublication("p", success.id, owner.token);
    const final = await store.finish("p", success.id, owner.token, { state: "succeeded", result: receipt(success) });
    const raw = await readFile(join(root, "jobs.json"), "utf8");
    for (const token of tokens) assert.equal(raw.includes(token), false);
    await store.close(); store = await FileSystemRenderJobStore.open(root);
    assert.deepEqual(await store.get("p", success.id), final);
    for (const original of active) {
      const recovered = (await store.get("p", original.id))!;
      assert.equal(recovered.state, "interrupted"); assert.equal(recovered.interruptedFrom, original.input.submissionId);
      assert.equal(recovered.outcomeUnknown, original.input.submissionId !== "queued");
      assert.equal((await store.submit(original.input)).record.id, original.id);
      await assert.rejects(store.claim("p", original.id), code("RENDER_JOB_STATE"));
    }
    const once = await store.list("p"); await store.close(); store = await FileSystemRenderJobStore.open(root);
    assert.deepEqual(await store.list("p"), once); assert.equal((await store.list("foreign")).total, 0);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("crashed writer leaves a lock; verified-owner cleanup permits recovery without automatic replay", { timeout: 15000 }, async () => {
  const root = await temp();
  try {
    const script = `import { FileSystemRenderJobStore } from ${JSON.stringify(new URL("./filesystem-render-job-store.ts", import.meta.url).href)};
      const store = await FileSystemRenderJobStore.open(process.argv[1]);
      const { record } = await store.submit(JSON.parse(process.argv[2]));
      const owner = await store.claim(record.input.projectId, record.id);
      await store.beginPublication(record.input.projectId, record.id, owner.token);
      process.stdout.write(JSON.stringify({ pid: process.pid, jobId: record.id }));
      process.exit(0);`; // Deliberately omit close; the child process owns only this test directory.
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, JSON.stringify(input())], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); const evidence = JSON.parse(child.stdout);
    const lock = JSON.parse(await readFile(join(root, "writer.lock"), "utf8")); assert.equal(lock.pid, evidence.pid);
    await assert.rejects(FileSystemRenderJobStore.open(root), code("EEXIST"));
    // Explicit operator recovery in this fixture: spawnSync proved our exact child has exited.
    await rm(join(root, "writer.lock")); const store = await FileSystemRenderJobStore.open(root);
    try {
      const recovered = (await store.get("p", evidence.jobId))!;
      assert.equal(recovered.state, "interrupted"); assert.equal(recovered.interruptedFrom, "publishing"); assert.equal(recovered.outcomeUnknown, true);
      assert.ok(recovered.publicationStartedAt); assert.equal((await store.submit(input())).created, false);
    } finally { await store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt or semantically inconsistent persisted jobs fail closed even with a recomputed checksum", async () => {
  const root = await temp(), store = await FileSystemRenderJobStore.open(root);
  const { record } = await store.submit(input()); const owner = await store.claim("p", record.id);
  await store.beginPublication("p", record.id, owner.token);
  await store.finish("p", record.id, owner.token, { state: "succeeded", result: receipt(record) }); await store.close();
  const path = join(root, "jobs.json"), original = JSON.parse(await readFile(path, "utf8"));
  try {
    for (const mutate of [
      (v: any) => { v.contentHash = "0".repeat(64); },
      (v: any) => { v.schemaVersion = "9.0.0"; },
      (v: any) => { v.records.push(structuredClone(v.records[0])); },
      (v: any) => { v.records[0].input.snapshot.id = "replaced"; },
      (v: any) => { v.records[0].result = null; },
      (v: any) => { v.records[0].progress = null; },
      (v: any) => { v.records[0].result.inputHash = "c".repeat(64); },
      (v: any) => { v.records[0].startedAt = "2099-01-01T00:00:00.000Z"; },
      (v: any) => { v.records[0].outcomeUnknown = true; },
    ]) {
      const changed = structuredClone(original); mutate(changed);
      if (changed.contentHash === original.contentHash) changed.contentHash = hashToolInput({ schemaVersion: changed.schemaVersion, records: changed.records });
      const bytes = JSON.stringify(changed); await writeFile(path, bytes);
      await assert.rejects(FileSystemRenderJobStore.open(root), code("RENDER_JOB_CORRUPT"));
      assert.equal(await readFile(path, "utf8"), bytes); assert.equal((await readdir(root)).includes("writer.lock"), false);
    }
    await writeFile(path, JSON.stringify(original)); const reopened = await FileSystemRenderJobStore.open(root); await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const afterPublication of [false, true]) {
  test(`terminal persistence failure ${afterPublication ? "after" : "before"} ledger publication never acknowledges success and recovers disk authority`, async () => {
    const root = await temp(); let store = await FileSystemRenderJobStore.open(root);
    try {
      const { record } = await store.submit(input()), owner = await store.claim("p", record.id);
      const candidate = receipt(record);
      await store.beginPublication("p", record.id, owner.token, candidate);
      await assert.rejects(store.finish("p", record.id, owner.token, { state: "succeeded", result: { ...candidate, sizeBytes: candidate.sizeBytes + 1 } }),
        code("RENDER_JOB_INVALID"));
      const internal = store as unknown as { writeLedger(text: string): Promise<void> }, originalWrite = internal.writeLedger.bind(store);
      internal.writeLedger = async text => { if (afterPublication) await originalWrite(text); throw new Error("Injected filesystem failure"); };
      await assert.rejects(store.finish("p", record.id, owner.token, { state: "succeeded", result: receipt(record) }), code("RENDER_JOB_PERSISTENCE_UNCERTAIN"));
      await assert.rejects(store.get("p", record.id), code("RENDER_JOB_RECOVERY_REQUIRED"));
      await assert.rejects(store.submit(input("new")), code("RENDER_JOB_RECOVERY_REQUIRED"));
      await store.close(); store = await FileSystemRenderJobStore.open(root);
      const recovered = (await store.get("p", record.id))!;
      assert.equal(recovered.state, afterPublication ? "succeeded" : "interrupted");
      assert.equal(recovered.outcomeUnknown, !afterPublication);
      assert.deepEqual(await store.garbageCollectionProtection(), { artifactIds: [candidate.artifactId], untrackedPublication: undefined });
      assert.deepEqual((await store.submit(input())).record, recovered);
      await assert.rejects(store.finish("p", record.id, owner.token, { state: "succeeded", result: receipt(record) }), code("RENDER_JOB_NOT_OWNED"));
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("pruning frees detailed-record capacity and keeps checksummed, project-bound submission tombstones", async () => {
  const root = await temp(), options = { maxJobs: 1, maxLedgerBytes: 18 * 1024 };
  let store = await FileSystemRenderJobStore.open(root, options);
  try {
    const { record } = await store.submit(input());
    await store.requestStop("p", record.id, "cancelled");
    await assert.rejects(store.submit(input("next")), code("RENDER_JOB_CAPACITY"));
    await store.releaseRetention("p", record.id);
    await store.releaseRetention("p", record.id, true);
    const pruned = await store.prune("p", record.id, "c".repeat(64));
    assert.equal((await store.submit(input("next", "foreign"))).created, true);
    await store.close();

    store = await FileSystemRenderJobStore.open(root, options);
    assert.deepEqual(await store.findSubmission("p", record.input.submissionId), pruned);
    assert.equal(await store.inspectRetention("foreign", record.id), undefined);
    await assert.rejects(store.submit(input()), code("RENDER_JOB_PRUNED"));
    await store.close();

    const path = join(root, "jobs.json");
    const { contentHash: _hash, ...saved } = JSON.parse(await readFile(path, "utf8"));
    delete saved.pruned[0].release.completedAt;
    await writeFile(path, JSON.stringify({ ...saved, contentHash: hashToolInput(saved) }));
    await assert.rejects(FileSystemRenderJobStore.open(root, options), code("RENDER_JOB_CORRUPT"));
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("actual filesystem rename failure poisons the ledger and never acknowledges or retains an uncommitted submission", async () => {
  const root = await temp(); let store = await FileSystemRenderJobStore.open(root);
  try {
    await rename(join(root, "jobs.json"), join(root, "original.json")); await mkdir(join(root, "jobs.json"));
    await assert.rejects(store.submit(input()), code("RENDER_JOB_PERSISTENCE_UNCERTAIN"));
    await assert.rejects(store.list("p"), code("RENDER_JOB_RECOVERY_REQUIRED"));
    assert.equal((await readdir(root)).some(name => name.endsWith(".tmp")), false);
    await store.close(); await rm(join(root, "jobs.json"), { recursive: true }); await rename(join(root, "original.json"), join(root, "jobs.json"));
    store = await FileSystemRenderJobStore.open(root); assert.equal((await store.list("p")).total, 0);
    assert.equal((await store.submit(input())).created, true);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ledger reader rejects oversized/symlink files and failed startup releases only its own lock", async () => {
  const root = await temp(), store = await FileSystemRenderJobStore.open(root);
  try {
    await assert.rejects(FileSystemRenderJobStore.open(root), code("EEXIST"));
    await store.submit(input()); await store.close();
    await rename(join(root, "jobs.json"), join(root, "original.json"));
    await symlink(join(root, "original.json"), join(root, "jobs.json"));
    await assert.rejects(FileSystemRenderJobStore.open(root));
    assert.equal((await readdir(root)).includes("writer.lock"), false);
    await rm(join(root, "jobs.json")); await writeFile(join(root, "jobs.json"), " ".repeat(1025));
    await assert.rejects(FileSystemRenderJobStore.open(root, { maxLedgerBytes: 1024 }), code("RENDER_JOB_CORRUPT"));
    await rm(join(root, "jobs.json")); await rename(join(root, "original.json"), join(root, "jobs.json"));
    const reopened = await FileSystemRenderJobStore.open(root); await reopened.close();
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("closing does not remove an externally replaced writer lock", async () => {
  const root = await temp(), store = await FileSystemRenderJobStore.open(root);
  try {
    await rename(join(root, "writer.lock"), join(root, "old.lock")); await writeFile(join(root, "writer.lock"), "replacement");
    await assert.rejects(store.close(), code("RENDER_JOB_LOCK_CHANGED"));
    assert.equal(await readFile(join(root, "writer.lock"), "utf8"), "replacement");
  } finally { await store.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("terminal record validation rejects inconsistent optional evidence rather than accepting null placeholders", async () => {
  const store = new InMemoryRenderJobStore();
  try {
    const { record } = await store.submit(input()); const owner = await store.claim("p", record.id);
    const final = await store.finish("p", record.id, owner.token, { state: "failed", diagnostic: { code: "RENDER_FAILED", message: "Render failed" } });
    for (const key of ["diagnostic", "stop", "progress", "result"]) assert.throws(() => validateJobRecord({ ...final, [key]: null } as unknown as RenderJobRecord));
    validateJobRecord(final);
  } finally { await store.close(); }
});
