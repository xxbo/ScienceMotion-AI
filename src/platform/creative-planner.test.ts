import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentToolManifest } from "../contracts/agent-tool";
import type { CreativeHost } from "../contracts/creative-host";
import type { CreativePlanner } from "../contracts/creative-planner";
import { openCreativeHost } from "./creative-host";
import { planCreativeStep } from "./creative-planner";

const brief = "Explain how a cache returns a piece of data that it already holds.";
const proposal = (toolId: string, input: unknown, toolVersion = "1.0.0") => ({ kind: "invoke", toolId, toolVersion, input });
const planner = (decision: unknown): CreativePlanner => ({ propose: async () => JSON.stringify(decision) });

async function openWorkspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-planner-"));
  let host: CreativeHost | undefined;
  t.after(async () => {
    try { await host?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  host = await openCreativeHost({ directory });
  return host;
}

test("planner preflight uses the live scoped catalogue and leaves invocation to the caller", async t => {
  const host = await openWorkspace(t);
  const session = host.createSession({ projectId: "example", permissions: ["project.read", "project.write", "snapshot.restore"],
    toolIds: ["project.create", "project.inspect", "project.snapshot.restore"] });
  const decision = await planCreativeStep(session, {
    async propose(context) {
      assert.equal(context.protocolVersion, "1.0.0");
      assert.equal(context.projectId, "example");
      assert.equal(context.brief, brief);
      assert.deepEqual(context.catalogue.tools.map(tool => tool.id), ["project.create", "project.inspect"]);
      const manifest = context.catalogue.tools[0];
      assert.ok(manifest.inputSchema.properties);
      return JSON.stringify(proposal(manifest.id, { name: "Cache", episodeId: "cache-brief" }, manifest.version));
    },
  }, { brief });
  assert.equal(decision.kind, "invoke");
  const before = await session.invoke({ toolId: "project.inspect", toolVersion: "1.0.0", input: {}, runId: "test", callId: "before" });
  assert.equal(before.diagnostics[0]?.code, "PROJECT_NOT_FOUND");
  const { toolId, toolVersion, input } = decision;
  const created = await session.invoke({ toolId, toolVersion, input, runId: "test", callId: "approved" });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
});

test("planner rejects hidden tools, mismatched versions, invalid inputs and authority fields", async t => {
  const host = await openWorkspace(t);
  const session = host.createSession({ projectId: "example", permissions: ["project.read"], toolIds: ["project.inspect", "project.create"] });
  const allowListProbe: CreativePlanner = {
    async propose(context) {
      assert.deepEqual(context.catalogue.tools.map(tool => tool.id), ["project.inspect"]);
      (context.catalogue.tools as AgentToolManifest[]).push({ ...context.catalogue.tools[0], id: "project.create" });
      return JSON.stringify(proposal("project.create", { name: "Cache", episodeId: "e" }));
    },
  };
  await assert.rejects(() => planCreativeStep(session, allowListProbe, { brief }), { code: "PLANNER_TOOL_NOT_DISCOVERED" });
  for (const [decision, code] of [
    [proposal("project.inspect", {}, "2.0.0"), "PLANNER_TOOL_VERSION_MISMATCH"],
    [proposal("project.inspect", { projectId: "foreign" }), "PLANNER_TOOL_INPUT_INVALID"],
    [{ ...proposal("project.inspect", {}), runId: "chosen-by-planner" }, "PLANNER_DECISION_INVALID"],
  ] as const) await assert.rejects(() => planCreativeStep(session, planner(decision), { brief }), { code });

  const widerSession = host.createSession({ projectId: "example", permissions: ["project.read", "project.write"], toolIds: ["project.inspect", "project.create"] });
  await assert.rejects(() => planCreativeStep(widerSession, {
    async propose(context) {
      assert.equal(context.catalogue.total, 2);
      assert.equal(context.catalogue.limit, 1);
      assert.deepEqual(context.catalogue.tools.map(tool => tool.id), ["project.create"]);
      return JSON.stringify(proposal("project.inspect", {}));
    },
  }, { brief, query: { limit: 1 } }), { code: "PLANNER_TOOL_NOT_DISCOVERED" });
});

test("planner validates JSON replies and supports finish and needs-input decisions", async t => {
  const host = await openWorkspace(t);
  const session = host.createSession({ projectId: "example" });
  const finish = { kind: "finish", summary: "The supplied material needs no edits." };
  const question = { kind: "needs-input", question: "Which approved narration should appear in this project?" };
  assert.deepEqual(await planCreativeStep(session, planner(finish), { brief }), finish);
  assert.deepEqual(await planCreativeStep(session, planner(question), { brief }), question);
  await assert.rejects(() => planCreativeStep(session, planner(finish), { brief: " " }), { code: "PLANNER_BRIEF_INVALID" });
  for (const raw of ["```json\n{}\n```", "1e400", "{}", '{"kind":"finish","summary":" "}']) {
    await assert.rejects(() => planCreativeStep(session, { propose: async () => raw }, { brief }), { code: "PLANNER_DECISION_INVALID" });
  }
  await assert.rejects(() => planCreativeStep(session, { propose: async () => "中".repeat(350_000) }, { brief }),
    { code: "PLANNER_DECISION_TOO_LARGE" });
});

test("planner rechecks a selected manifest and observes caller cancellation", async t => {
  const host = await openWorkspace(t);
  const session = host.createSession({ projectId: "example", permissions: ["project.read"], toolIds: ["project.inspect"] });
  const changed = { ...session, manifest: async (toolId: string) => ({ ...(await session.manifest(toolId))!, version: "2.0.0" }) };
  await assert.rejects(() => planCreativeStep(changed, planner(proposal("project.inspect", {})), { brief }), { code: "PLANNER_TOOL_CHANGED" });

  const controller = new AbortController();
  const cancelled = new Error("Cancelled by caller");
  await assert.rejects(() => planCreativeStep(session, {
    async propose(_context, signal) {
      assert.equal(signal, controller.signal);
      controller.abort(cancelled);
      return JSON.stringify(proposal("project.inspect", {}));
    },
  }, { brief, signal: controller.signal }), cancelled);
});
