import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentTool, ToolCallContext, ToolExecutionRecord, ToolResult } from "../contracts/agent-tool";
import { InMemoryToolExecutionStore, hashToolInput } from "./tool-execution-store";
import { FileSystemToolExecutionStore } from "./filesystem-tool-execution-store";
import { LocalToolExecutor } from "./tool-execution";

const ctx: ToolCallContext = { projectId: "p", runId: "r", callId: "c", idempotencyKey: "once" };
const ok = (output: unknown = { value: 1 }): ToolResult => ({ ok: true, output, diagnostics: [] });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function tool(execute: AgentTool["execute"], execution: Partial<AgentTool["manifest"]["execution"]> = {}): AgentTool {
  return { manifest: { id: "project.test.mutate", namespace: "project.test", version: "1.0.0", name: "Test", description: "Mutation fixture", category: "test",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: { deterministic: true, stateful: true, destructive: false, cost: "low", idempotent: true, ...execution } }, execute };
}
function record(id = "record-1", key = "key"): ToolExecutionRecord {
  return { id, projectId: "p", runId: "r", callId: id, toolId: "project.test.mutate", toolVersion: "1.0.0", inputHash: hashToolInput({}),
    idempotencyKey: key, status: "started", startedAt: "2026-01-01T00:00:00.000Z" };
}

test("canonical input hash orders keys and rejects lossy non-JSON inputs", () => {
  assert.equal(hashToolInput({ b: 2, a: [1, 3] }), hashToolInput({ a: [1, 3], b: 2 }));
  for (const value of [undefined, NaN, Infinity, new Date(), { a: undefined }, [undefined], 1n]) assert.throws(() => hashToolInput(value));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; assert.throws(() => hashToolInput(cycle));
});

test("atomic reservations elect one owner and reject foreign finalization", async () => {
  const store = new InMemoryToolExecutionStore();
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => store.reserve(record(`r${index}`))));
  assert.equal(results.filter((item) => item.acquired).length, 1);
  const owner = results.find((item) => item.acquired)!;
  assert.ok(owner.acquired);
  const final = { ...owner.record, status: "succeeded" as const, result: ok(), completedAt: new Date().toISOString() };
  await assert.rejects(() => store.finish(final, "foreign"), /not owned/);
  await assert.rejects(() => store.finish({ ...final, inputHash: hashToolInput({ changed: true }) }, owner.token), /immutable/);
  await store.finish(final, owner.token);
  await assert.rejects(() => store.finish(final, owner.token), /terminal/);
  assert.equal((await store.list()).length, 1);
});

test("50 concurrent identical callers mutate once and receive isolated results", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store });
  const gate = deferred(); let mutations = 0;
  const operation = tool(async () => { mutations++; await gate.promise; return ok({ nodes: ["created"] }); });
  const calls = Array.from({ length: 50 }, (_, index) => executor.invoke(operation, {}, { ...ctx, callId: `c${index}` }));
  await tick(); assert.equal(mutations, 1); gate.resolve();
  const results = await Promise.all(calls); assert.ok(results.every((item) => item.ok));
  (results[0].output as { nodes: string[] }).nodes.push("external");
  assert.deepEqual(results[1].output, { nodes: ["created"] });
  assert.equal((await store.list()).length, 1);
  assert.deepEqual((await executor.invoke(operation, {}, { ...ctx, callId: "replay" })).output, { nodes: ["created"] });
});

test("same key with different input conflicts during admission, running and after completion", async () => {
  const admitted = deferred();
  class SlowStore extends InMemoryToolExecutionStore { override async reserve(r: ToolExecutionRecord) { await admitted.promise; return super.reserve(r); } }
  const executor = new LocalToolExecutor({ executionStore: new SlowStore() });
  const gate = deferred(); let count = 0;
  const operation = tool(async () => { count++; await gate.promise; return ok(); });
  const first = executor.invoke(operation, { value: 1 }, ctx);
  assert.equal((await executor.invoke(operation, { value: 2 }, ctx)).diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
  admitted.resolve(); await tick();
  assert.equal((await executor.invoke(operation, { value: 2 }, ctx)).diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
  gate.resolve(); assert.ok((await first).ok); await tick();
  assert.equal((await executor.invoke(operation, { value: 2 }, { ...ctx, callId: "later" })).diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
  assert.equal(count, 1);
});

test("two executors sharing one store share ownership and concurrency", async () => {
  const store = new InMemoryToolExecutionStore();
  const a = new LocalToolExecutor({ executionStore: store }); const b = new LocalToolExecutor({ executionStore: store });
  const gate = deferred(); let count = 0;
  const operation = tool(async () => { count++; await gate.promise; return ok(); }, { maxConcurrency: 1 });
  const first = a.invoke(operation, {}, ctx); const duplicate = b.invoke(operation, {}, { ...ctx, callId: "other" });
  assert.equal((await b.invoke(operation, {}, { ...ctx, callId: "new", idempotencyKey: "new" })).diagnostics[0].code, "TOOL_CONCURRENCY_LIMIT");
  gate.resolve(); assert.ok((await first).ok); assert.ok((await duplicate).ok); assert.equal(count, 1);
});

test("duplicate caller cancellation does not cancel the owning invocation", async () => {
  const executor = new LocalToolExecutor(); const gate = deferred(); const follower = new AbortController();
  const operation = tool(async (_input, context) => { await gate.promise; assert.equal(context.signal?.aborted, false); return ok(); });
  const owner = executor.invoke(operation, {}, ctx);
  const pending = executor.invoke(operation, {}, { ...ctx, callId: "follower", signal: follower.signal });
  follower.abort(); assert.equal((await pending).diagnostics[0].code, "TOOL_CANCELLED");
  gate.resolve(); assert.ok((await owner).ok);
});

test("cancelled before admission creates no execution record or tool effect", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store });
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const result = await executor.invoke(tool(async () => { calls++; return ok(); }), {}, { ...ctx, signal: controller.signal });
  assert.equal(result.diagnostics[0].code, "TOOL_CANCELLED"); assert.equal(calls, 0); assert.deepEqual(await store.list(), []);
});

test("cancellation during async admission records cancellation without starting tool", async () => {
  const admission = deferred();
  class SlowStore extends InMemoryToolExecutionStore { override async reserve(r: ToolExecutionRecord) { await admission.promise; return super.reserve(r); } }
  const store = new SlowStore(); const executor = new LocalToolExecutor({ executionStore: store }); const controller = new AbortController(); let calls = 0;
  const pending = executor.invoke(tool(async () => { calls++; return ok(); }), {}, { ...ctx, signal: controller.signal });
  await tick(); controller.abort(); admission.resolve();
  assert.equal((await pending).diagnostics[0].code, "TOOL_CANCELLED"); assert.equal(calls, 0);
  assert.equal((await store.list())[0].status, "cancelled");
});

test("in-flight cancellation signals tool, preserves uncertainty and prevents replay", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store }); const started = deferred();
  const controller = new AbortController(); let observed = false;
  const operation = tool(async (_input, context) => new Promise((resolve) => {
    context.signal!.addEventListener("abort", () => { observed = true; resolve(ok()); }, { once: true }); started.resolve();
  }));
  const pending = executor.invoke(operation, {}, { ...ctx, signal: controller.signal });
  await started.promise; controller.abort(); const result = await pending;
  assert.equal(result.diagnostics[0].code, "TOOL_CANCELLED"); assert.equal(observed, true);
  assert.equal(result.metadata?.outcomeUnknown, true); await tick();
  assert.equal((await executor.invoke(operation, {}, { ...ctx, callId: "retry" })).diagnostics[0].code, "TOOL_RECOVERY_REQUIRED");
});

test("timeout keeps capacity until non-cooperative work settles and late success cannot overwrite evidence", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store }); const gate = deferred();
  const operation = tool(async () => { await gate.promise; return ok(); }, { timeoutMs: 10, maxConcurrency: 1 });
  assert.equal((await executor.invoke(operation, {}, ctx)).diagnostics[0].code, "TOOL_TIMEOUT");
  assert.equal((await store.list())[0].status, "timed-out");
  assert.equal((await executor.invoke(operation, {}, { ...ctx, callId: "second", idempotencyKey: "second" })).diagnostics[0].code, "TOOL_CONCURRENCY_LIMIT");
  gate.resolve(); await tick();
  assert.equal((await store.list())[0].status, "timed-out");
  assert.ok((await executor.invoke(operation, {}, { ...ctx, callId: "third", idempotencyKey: "third" })).ok);
});

test("admission failure releases slots and never executes or overwrites a foreign record", async () => {
  class FailingOnce extends InMemoryToolExecutionStore { fail = true; override async reserve(r: ToolExecutionRecord) { if (this.fail) { this.fail = false; throw new Error("disk unavailable"); } return super.reserve(r); } }
  const store = new FailingOnce(); const executor = new LocalToolExecutor({ executionStore: store }); let calls = 0;
  const operation = tool(async () => { calls++; return ok(); }, { maxConcurrency: 1 });
  assert.equal((await executor.invoke(operation, {}, ctx)).diagnostics[0].code, "TOOL_EXECUTION_STORE_FAILED");
  await tick(); assert.ok((await executor.invoke(operation, {}, ctx)).ok); assert.equal(calls, 1);
});

test("terminal evidence failure never returns success or permits blind repeat", async () => {
  class RejectFinish extends InMemoryToolExecutionStore { override async finish(): Promise<void> { throw new Error("write failed"); } }
  const store = new RejectFinish(); const executor = new LocalToolExecutor({ executionStore: store }); let calls = 0;
  const operation = tool(async () => { calls++; return ok(); });
  const result = await executor.invoke(operation, {}, ctx);
  assert.equal(result.diagnostics[0].code, "TOOL_EXECUTION_STORE_FAILED"); assert.equal(result.metadata?.outcomeUnknown, true);
  await tick(); assert.equal((await executor.invoke(operation, {}, { ...ctx, callId: "later" })).diagnostics[0].code, "TOOL_ALREADY_RUNNING");
  assert.equal(calls, 1); assert.equal((await store.list())[0].status, "started");
});

test("input and context mutations after admission cannot change execution identity", async () => {
  const executor = new LocalToolExecutor(); const input = { value: 1 }; const caller = { ...ctx };
  const pending = executor.invoke(tool(async (value, context) => ok({ value, project: context.projectId })), input, caller);
  input.value = 99; caller.projectId = "different";
  assert.deepEqual((await pending).output, { value: { value: 1 }, project: "p" });
});

test("tuple identities avoid colon-separated project/run collisions", async () => {
  const executor = new LocalToolExecutor(); let calls = 0; const operation = tool(async () => { calls++; return ok(); });
  const a = { projectId: "a:b", runId: "c", callId: "d" };
  const b = { projectId: "a", runId: "b:c", callId: "d" };
  assert.ok((await executor.invoke(operation, {}, a)).ok); assert.ok((await executor.invoke(operation, {}, b)).ok); assert.equal(calls, 2);
});

test("retry is bounded and receives a fresh input copy each time", async () => {
  const executor = new LocalToolExecutor({ maxAttempts: 3 }); let calls = 0;
  const result = await executor.invoke(tool(async (input) => {
    assert.deepEqual(input, { value: 1 }); (input as { value: number }).value = 2; calls++;
    return calls === 1 ? { ok: false, diagnostics: [], metadata: { retryable: true } } : ok();
  }), { value: 1 }, ctx);
  assert.ok(result.ok); assert.equal(result.metadata?.attempt, 2); assert.equal(calls, 2);
});

test("throwing observation callback cannot change a persisted successful outcome", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store, onEvent: () => { throw new Error("observer"); } });
  assert.ok((await executor.invoke(tool(async () => ok()), {}, ctx)).ok);
  assert.equal((await store.list())[0].status, "succeeded");
});

test("persistent success survives close/reopen and replays without executing", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-restart-")); let store = await FileSystemToolExecutionStore.open(root);
  try {
    let calls = 0; const operation = tool(async () => { calls++; return ok(); });
    assert.ok((await new LocalToolExecutor({ executionStore: store }).invoke(operation, {}, ctx)).ok);
    await store.close(); store = await FileSystemToolExecutionStore.open(root);
    assert.ok((await new LocalToolExecutor({ executionStore: store }).invoke(operation, {}, { ...ctx, callId: "restarted" })).ok);
    assert.equal(calls, 1); assert.equal((await store.list())[0].status, "succeeded");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("unfinished persisted records become interrupted and keep idempotency keys reserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-interrupted-")); let store = await FileSystemToolExecutionStore.open(root);
  try {
    const key = JSON.stringify([ctx.projectId, "project.test.mutate", "1.0.0", ctx.idempotencyKey]);
    await store.reserve(record("left-started", key)); // Simulate a session with no terminal evidence.
    await store.close(); store = await FileSystemToolExecutionStore.open(root);
    let calls = 0;
    const result = await new LocalToolExecutor({ executionStore: store }).invoke(tool(async () => { calls++; return ok(); }), {}, ctx);
    assert.equal(result.diagnostics[0].code, "TOOL_RECOVERY_REQUIRED"); assert.equal(calls, 0);
    assert.equal((await store.list())[0].status, "interrupted");
    await store.close(); store = await FileSystemToolExecutionStore.open(root);
    assert.equal((await store.list())[0].status, "interrupted");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("filesystem ledger enforces one writer and rejects corrupt history", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-ledger-")); const store = await FileSystemToolExecutionStore.open(root);
  try {
    await assert.rejects(() => FileSystemToolExecutionStore.open(root), /EEXIST/);
    await store.reserve(record()); await store.close();
    const path = join(root, "executions.json"); const ledger = JSON.parse(await readFile(path, "utf8"));
    ledger.records[0].inputHash = "0".repeat(64); await writeFile(path, JSON.stringify(ledger));
    await assert.rejects(() => FileSystemToolExecutionStore.open(root), /integrity/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failed filesystem publish poisons the store rather than retrying uncertain writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-publish-")); const store = await FileSystemToolExecutionStore.open(root);
  try {
    // Force the fixed ledger destination to be a directory so rename fails.
    const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, "executions.json"));
    await assert.rejects(() => store.reserve(record()));
    await assert.rejects(() => store.reserve(record("another", "another")), /uncertain/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("persisted same call/key conflicts never overwrite the successful owner", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store });
  const operation = tool(async (input) => ok(input));
  assert.ok((await executor.invoke(operation, { value: 1 }, ctx)).ok); await tick();
  const before = await store.list();
  assert.equal((await executor.invoke(operation, { value: 2 }, ctx)).diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await store.list(), before);
});

test("non-JSON successful output becomes failed evidence, never an unrecorded host throw", async () => {
  const store = new InMemoryToolExecutionStore(); const executor = new LocalToolExecutor({ executionStore: store });
  const result = await executor.invoke(tool(async () => ok({ invalid: Infinity })), {}, ctx);
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, "TOOL_EXECUTION_FAILED");
  assert.equal((await store.list())[0].status, "failed");
});

test("rejected async event observers cannot cause an unhandled rejection or false failure", async () => {
  const executor = new LocalToolExecutor({ onEvent: async () => { throw new Error("observer unavailable"); } });
  assert.ok((await executor.invoke(tool(async () => ok()), {}, ctx)).ok); await tick();
});

test("local host call limit bounds simultaneous different tool identities", async () => {
  const executor = new LocalToolExecutor({ maxConcurrentCalls: 1 }); const gate = deferred();
  const one = tool(async () => { await gate.promise; return ok(); });
  const two = tool(async () => ok()); two.manifest.id = "project.test.other";
  const pending = executor.invoke(one, {}, ctx);
  assert.equal((await executor.invoke(two, {}, { ...ctx, callId: "second" })).diagnostics[0].code, "TOOL_CONCURRENCY_LIMIT");
  gate.resolve(); assert.ok((await pending).ok);
});

test("shutdown stops admission and drains timed-out underlying work before storage can close", async () => {
  const executor = new LocalToolExecutor(); const gate = deferred();
  const operation = tool(async () => { await gate.promise; return ok(); }, { timeoutMs: 10 });
  assert.equal((await executor.invoke(operation, {}, ctx)).diagnostics[0].code, "TOOL_TIMEOUT");
  let drained = false; const shutdown = executor.shutdown().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  assert.equal((await executor.invoke(operation, {}, { ...ctx, callId: "new" })).diagnostics[0].code, "TOOL_GATEWAY_CLOSED");
  gate.resolve(); await shutdown; assert.equal(drained, true);
});
