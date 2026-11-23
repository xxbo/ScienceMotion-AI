import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { AgentToolManifest, ToolResult } from "../contracts/agent-tool";
import type { CreativeInvocation } from "../contracts/creative-host";
import type { CreativePlanner, CreativePlannerDecision } from "../contracts/creative-planner";
import { runCreativePlan } from "./creative-runner";

const brief = "Create a draft from the approved cache brief.";
const decision = { kind: "invoke", toolId: "project.inspect", toolVersion: "1.0.0", input: {} } as const;
const propose = (value: CreativePlannerDecision): CreativePlanner => ({ propose: async () => JSON.stringify(value) });
const success = (output: unknown = {}) => ({ ok: true, output, diagnostics: [] });

function fixture(execute: (call: CreativeInvocation) => Promise<ToolResult> = async () => success()) {
  const calls: CreativeInvocation[] = [];
  const state = { discoveries: 0, version: "1.0.0" };
  const manifest = (): AgentToolManifest => ({ id: decision.toolId, version: state.version, name: "Inspect", description: "Read the project",
    namespace: "project", category: "workspace", inputSchema: { type: "object", additionalProperties: false }, outputSchema: {},
    execution: { deterministic: true, stateful: false, destructive: false, cost: "low" } });
  const session = {
    projectId: "example",
    async discover() { state.discoveries++; return { tools: [manifest()], total: 1, offset: 0, limit: 50 }; },
    async manifest() { return manifest(); },
    async invoke(call: CreativeInvocation) { calls.push(call); return execute(call); },
  };
  return { session, calls, state };
}

test("run feeds a confirmed result to the next proposal and keeps an isolated trace", async () => {
  const failure: ToolResult = { ok: false, diagnostics: [{ level: "error", code: "PROJECT_NOT_FOUND", message: "Project missing" }] };
  const { session, calls } = fixture(async () => failure);
  const report = await runCreativePlan(session, {
    async propose({ observation }) {
      if (!observation) return JSON.stringify(decision);
      assert.equal(observation.callId, "turn-1");
      assert.deepEqual(observation.decision, decision);
      assert.deepEqual(observation.result, failure);
      observation.result.diagnostics[0].code = "ADAPTER_CHANGE";
      return JSON.stringify({ kind: "finish", summary: "Confirmed absence of a project" });
    },
  }, { brief });
  assert.deepEqual(report.stop, { reason: "finished" });
  assert.equal(report.plannerTurns, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, report.runId);
  assert.deepEqual(report.turns[0].call, { callId: calls[0].callId, result: failure });
  assert.deepEqual(report.pinnedTools, [{ id: decision.toolId, version: decision.toolVersion }]);
  assert.equal(report.outputBytes, report.turns.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.decision)) +
    (item.call?.result ? Buffer.byteLength(JSON.stringify(item.call.result)) : 0), 0));
});

test("run records input requests, preflight failures and turn exhaustion", async () => {
  const { session, calls } = fixture();
  const question = { kind: "needs-input", question: "Which approved project brief should I use?" } as const;
  const needsInput = await runCreativePlan(session, propose(question), { brief });
  assert.deepEqual(needsInput.stop, { reason: "needs-input" });
  assert.deepEqual(needsInput.turns, [{ turn: 1, decision: question }]);
  const invalid = await runCreativePlan(session, { propose: async () => "{}" }, { brief });
  assert.equal(invalid.stop.reason, "planning-failed");
  assert.equal(invalid.stop.code, "PLANNER_DECISION_INVALID");
  assert.deepEqual(invalid.turns, []);
  assert.equal(calls.length, 0);

  const limited = await runCreativePlan(session, propose(decision), { brief, limits: { maxTurns: 1 } });
  assert.deepEqual(limited.stop, { reason: "turn-limit" });
  assert.equal(limited.plannerTurns, 1);
  assert.equal(calls.length, 1);
  await assert.rejects(() => runCreativePlan(session, propose(decision), { brief, limits: { timeoutMs: Infinity } }),
    { code: "PLANNER_RUN_LIMITS_INVALID" });
});

test("run enforces the aggregate UTF-8 output budget before a call and before the next proposal", async () => {
  const result = success({ text: "缓存".repeat(100) });
  const { session, calls } = fixture(async () => result);
  const decisionBytes = Buffer.byteLength(JSON.stringify(decision));
  const resultBytes = Buffer.byteLength(JSON.stringify(result));
  const blocked = await runCreativePlan(session, propose(decision), { brief, limits: { maxOutputBytes: decisionBytes - 1 } });
  assert.deepEqual(blocked.stop, { reason: "output-limit", source: "decision", bytes: decisionBytes });
  assert.equal(calls.length, 0);

  const omitted = await runCreativePlan(session, propose(decision), { brief, limits: { maxOutputBytes: decisionBytes + resultBytes - 1 } });
  assert.deepEqual(omitted.stop, { reason: "output-limit", source: "tool-result", bytes: resultBytes });
  assert.deepEqual(omitted.turns[0].call, { callId: "turn-1", omittedResult: { bytes: resultBytes, ok: true } });
  assert.equal(omitted.outputBytes, decisionBytes);
  assert.equal(omitted.plannerTurns, 1);
  assert.equal(calls.length, 1);

  const exact = await runCreativePlan(session, propose(decision), { brief, limits: { maxTurns: 1, maxOutputBytes: decisionBytes + resultBytes } });
  assert.deepEqual(exact.stop, { reason: "turn-limit" });
  assert.deepEqual(exact.turns[0].call?.result, result);
  assert.equal(exact.outputBytes, decisionBytes + resultBytes);
  assert.notEqual(exact.runId, omitted.runId);
});

test("run deadline releases a caller waiting on a late planner without starting a tool", async () => {
  const { session, calls } = fixture();
  let receivedSignal: AbortSignal | undefined;
  let respond!: (value: string) => void;
  const pending = new Promise<string>(resolve => { respond = resolve; });
  const report = await runCreativePlan(session, { propose: async (_context, signal) => { receivedSignal = signal; return pending; } },
    { brief, limits: { timeoutMs: 500 } });
  assert.deepEqual(report.stop, { reason: "deadline" });
  assert.ok(receivedSignal?.aborted);
  respond(JSON.stringify(decision));
  await setImmediate();
  assert.deepEqual(report.turns, []);
  assert.equal(calls.length, 0);
});

test("run distinguishes cancellation before work and during an unconfirmed invocation", async () => {
  const controller = new AbortController();
  let entered!: () => void, complete!: (result: ToolResult) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<ToolResult>(resolve => { complete = resolve; });
  const { session, calls, state } = fixture(async () => { entered(); return pending; });
  const running = runCreativePlan(session, propose(decision), { brief, signal: controller.signal });
  await started;
  controller.abort();
  const report = await running;
  assert.deepEqual(report.stop, { reason: "outcome-unknown", callId: "turn-1", cause: "cancelled" });
  assert.ok(calls[0].signal?.aborted);
  complete(success());
  await setImmediate();
  assert.deepEqual(report.turns[0].call, { callId: "turn-1" });
  assert.equal(calls.length, 1);

  const stopped = await runCreativePlan(session, propose(decision), { brief, signal: controller.signal });
  assert.deepEqual(stopped.stop, { reason: "cancelled" });
  assert.equal(stopped.plannerTurns, 0);
  assert.equal(state.discoveries, 1);
});

test("an uncertain tool result always stops, including when it cannot fit in the trace", async () => {
  const uncertain: ToolResult = { ok: false, diagnostics: [{ level: "error", code: "TOOL_RECOVERY_REQUIRED", message: "Check execution history" }],
    metadata: { outcomeUnknown: true } };
  const { session, calls } = fixture(async () => uncertain);
  const report = await runCreativePlan(session, propose(decision), { brief, limits: { maxOutputBytes: Buffer.byteLength(JSON.stringify(decision)) } });
  assert.deepEqual(report.stop, { reason: "outcome-unknown", callId: "turn-1", cause: "tool-result" });
  assert.deepEqual(report.turns[0].call, { callId: "turn-1", omittedResult: { ok: false, bytes: Buffer.byteLength(JSON.stringify(uncertain)) } });
  assert.equal(report.plannerTurns, 1);
  assert.equal(calls.length, 1);
});

test("run pins discovery and stops when a selected implementation changes between turns", async () => {
  const { session, calls, state } = fixture(async () => { state.version = "2.0.0"; return success(); });
  const report = await runCreativePlan(session, {
    async propose(context) {
      assert.equal(context.catalogue.tools[0].version, "1.0.0");
      return JSON.stringify(decision);
    },
  }, { brief });
  assert.equal(state.discoveries, 1);
  assert.equal(report.stop.reason, "planning-failed");
  assert.equal(report.stop.code, "PLANNER_TOOL_CHANGED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolVersion, "1.0.0");
});
