import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativePlanner, CreativePlannerContext } from "../src/contracts/creative-planner";
import type { ProjectDocument } from "../src/contracts/project";
import { openCreativeHost } from "../src/platform/creative-host";
import { runCreativePlan } from "../src/platform/creative-runner";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { hashToolInput } from "../src/platform/tool-execution-store";
import { creativeLoopTopics } from "./fixtures/creative-loop-topics";

const output = resolve("out/planning-run");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-planning-run-"));
const topic = creativeLoopTopics.find(item => item.id === "cache-loop")!;
const projectId = "cache-planning-draft", draftId = "cache-draft", reconciliationProject = "cache-lost-receipt";
const scenes = [
  { id: "cache-hit", name: "缓存命中", text: "命中时从缓存返回数据", startFrame: 0 },
  { id: "locality", name: "时间局部性", text: "程序可能重复访问近期数据", startFrame: 120 },
];
const limits = { maxTurns: 20, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 };
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", newModelCalls: 0 };

const saveJson = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const projectInput = { name: topic.name, episodeId: topic.id, width: 640, height: 360, fps: 20, durationFrames: 240 };
function call(context: CreativePlannerContext, toolId: string, input: unknown) {
  const selected = context.catalogue.tools.find(tool => tool.id === toolId);
  assert.ok(selected, `Adapter requires ${toolId}`);
  return JSON.stringify({ kind: "invoke", toolId, toolVersion: selected.version, input });
}

const adapter: CreativePlanner = {
  async propose(context) {
    assert.equal(context.brief, topic.brief);
    const prior = context.observation;
    if (!prior) return call(context, "project.inspect", {});
    if (!prior.result.ok) {
      if (prior.decision.toolId === "project.inspect" && prior.result.diagnostics.some(diagnostic => diagnostic.code === "PROJECT_NOT_FOUND"))
        return call(context, "project.create", projectInput);
      return JSON.stringify({ kind: "needs-input", question: "Which existing project state should the draft use?" });
    }
    if (prior.decision.toolId === "project.snapshot.save") {
      const receipt = prior.result.output as SnapshotReceipt;
      return JSON.stringify({ kind: "finish", summary: `Saved draft ${receipt.id}` });
    }
    if (prior.decision.toolId !== "project.inspect") return call(context, "project.inspect", {});
    const document = prior.result.output as ProjectDocument;
    for (const scene of scenes) {
      if (!document.scenes.some(item => item.id === scene.id))
        return call(context, "project.scene.create", { sceneId: scene.id, name: scene.name, startFrame: scene.startFrame, durationFrames: 120 });
      const nodeId = `${scene.id}-title`;
      if (!document.nodes.some(node => node.id === nodeId))
        return call(context, "graphics.2d.text.create", { sceneId: scene.id, nodeId, text: scene.text,
          x: 56, y: 56, width: 528, height: 64, fontSize: 32 });
    }
    return call(context, "project.snapshot.save", { snapshotId: draftId, revisionId: document.revisions.at(-1)!.id });
  },
};

function reader(host: CreativeHost, id: string) {
  return host.createSession({ projectId: id, permissions: ["project.read", "snapshot.read", "execution.read"],
    toolIds: ["project.inspect", "project.snapshot.inspect", "execution.list"] });
}
async function verifyWith<T>(session: CreativeSession, toolId: string, input: unknown = {}) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "creative-run-verification", callId: toolId });
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result.output as T;
}

let host: CreativeHost | undefined;
try {
  host = await openCreativeHost({ directory });
  const edit = host.createSession({ projectId, permissions: ["project.read", "project.write", "snapshot.write"],
    toolIds: ["project.inspect", "project.create", "project.scene.create", "graphics.2d.text.create", "project.snapshot.save"] });
  const run = await runCreativePlan(edit, adapter, { brief: topic.brief, limits });
  await saveJson("run.json", run);
  assert.equal(run.stop.reason, "finished", JSON.stringify(run.stop));
  assert.equal(run.turns[0].call?.result?.diagnostics[0]?.code, "PROJECT_NOT_FOUND");
  const saved = run.turns.find(turn => turn.decision.kind === "invoke" && turn.decision.toolId === "project.snapshot.save");
  assert.ok(saved?.call?.result?.ok && saved.decision.kind === "invoke");
  const receipt = saved.call.result.output as SnapshotReceipt;
  assert.equal(receipt.id, draftId);
  assert.deepEqual(run.turns.at(-1)?.decision, { kind: "finish", summary: `Saved draft ${draftId}` });
  const { revisionId } = saved.decision.input as { revisionId: string };

  const lostSession = host.createSession({ projectId: reconciliationProject, permissions: ["project.write"], toolIds: ["project.create"] });
  const lost = await runCreativePlan({ ...lostSession, async invoke(request) {
    const result = await lostSession.invoke(request);
    assert.ok(result.ok, JSON.stringify(result.diagnostics));
    throw new Error("Acceptance fixture discarded the acknowledged result");
  } }, { propose: async context => call(context, "project.create", projectInput) }, { brief: topic.brief, limits });
  await saveJson("uncertain-run.json", lost);
  assert.deepEqual(lost.stop, { reason: "outcome-unknown", callId: "turn-1", cause: "invocation-error" });
  assert.equal(lost.plannerTurns, 1);

  await host.close();
  host = await openCreativeHost({ directory });
  const reopened = reader(host, projectId);
  const draft = await verifyWith<ProjectSnapshot>(reopened, "project.snapshot.inspect", { snapshotId: draftId });
  assert.equal(draft.contentHash, receipt.contentHash);
  assert.equal(hashProject(draft.document), draft.contentHash);
  assert.equal(draft.document.revisions.at(-1)?.id, revisionId);
  assert.equal(draft.document.editorial.episodeId, topic.id);
  assert.deepEqual((draft.document.shots ?? []).map(shot => [shot.sceneId, shot.startFrame, shot.durationFrames]),
    scenes.map(scene => [scene.id, scene.startFrame, 120]));
  assert.deepEqual(draft.document.nodes.map(node => [node.id, node.components[0].data.text]),
    scenes.map(scene => [`${scene.id}-title`, scene.text]));
  assert.deepEqual(await verifyWith<ProjectDocument>(reopened, "project.inspect"), draft.document);
  const history = (await verifyWith<ToolExecutionRecord[]>(reopened, "execution.list")).filter(entry => entry.runId === run.runId);
  const calls = run.turns.filter(turn => turn.call);
  assert.equal(history.length, calls.length);
  assert.equal(calls.length, 12);
  for (const turn of calls) {
    assert.ok(turn.call && turn.decision.kind === "invoke" && turn.call.result);
    const entry = history.find(item => item.callId === turn.call!.callId);
    assert.ok(entry);
    assert.equal(entry.toolId, turn.decision.toolId);
    assert.equal(entry.toolVersion, turn.decision.toolVersion);
    assert.equal(entry.inputHash, hashToolInput(turn.decision.input));
    assert.equal(entry.status, turn.call.result.ok ? "succeeded" : "failed");
    assert.deepEqual(entry.result, turn.call.result);
  }

  const reconciliation = reader(host, reconciliationProject);
  const isolated = await verifyWith<ProjectDocument>(reconciliation, "project.inspect");
  const [committed, ...otherCalls] = (await verifyWith<ToolExecutionRecord[]>(reconciliation, "execution.list"))
    .filter(entry => entry.runId === lost.runId);
  assert.equal(otherCalls.length, 0);
  assert.equal(committed?.callId, "turn-1");
  assert.equal(committed.toolId, "project.create");
  assert.equal(committed.status, "succeeded");
  assert.equal(committed.inputHash, hashToolInput(projectInput));
  assert.equal((committed.result?.output as { revisionId: string }).revisionId, isolated.revisions.at(-1)?.id);
  assert.equal(isolated.revisions.length, 1);
  await saveJson("draft-snapshot.json", draft);
  await saveJson("executions.json", [...history, committed]);
  Object.assign(evidence, { status: "passed", approvedBrief: { id: topic.id, text: topic.brief }, runId: run.runId,
    turns: run.plannerTurns, calls: calls.length, draft: { id: draft.id, revisionId, contentHash: draft.contentHash, reopened: true },
    reconciliation: { runId: lost.runId, callId: committed.callId, status: committed.status, additionalCalls: otherCalls.length } });
  console.log("PASS: adaptive planning saved and reopened a two-shot draft and reconciled a lost tool response against its ledger");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    try { await saveJson("evidence.json", evidence); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
