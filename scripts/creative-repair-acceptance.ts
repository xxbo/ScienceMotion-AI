import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativeRepairChecks, CreativeRepairPlanner, CreativeRepairPlannerContext } from "../src/contracts/creative-repair";
import type { ProjectDocument } from "../src/contracts/project";
import { openCreativeHost } from "../src/platform/creative-host";
import { repairCreativeSnapshot } from "../src/platform/creative-repair";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";

const output = resolve("out/creative-repair");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-creative-repair-"));
const directory = join(root, "workspace"), voicePath = join(root, "narration.wav");
const projectId = "repair-cache", brief = "Preserve the approved explanation. Repair diagnosed viewport and caption timing issues.";
const captionText = "CPU 算得快，却常常要等数据。缓存，把常用数据放得更近。";
const checks: CreativeRepairChecks = { model: {}, layout: {}, timeline: { requireNarrationForCaptions: true } };
const timelineOnly: CreativeRepairChecks = { timeline: checks.timeline };
const motionOnly: CreativeRepairChecks = { model: { frames: [10, 16, 20, 30, 39, 79] } };
const tools = ["project.create", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create", "graphics.2d.chart.create",
  "graphics.2d.edit", "animation.keyframes.set", "animation.keyframes.edit", "assets.import", "timeline.edit", "project.inspect",
  "project.snapshot.save", "project.snapshot.inspect", "project.snapshot.restore", "inspect.snapshot", "inspect.layout", "inspect.timeline", "execution.list"];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", newModelCalls: 0 };
const save = (name: string, data: unknown) => writeFile(join(output, name), JSON.stringify(data, null, 2) + "\n");
let host: CreativeHost | undefined, callNumber = 0;
const revision = (doc: ProjectDocument) => doc.revisions.at(-1)!.id;
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown = {}) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "verify-creative-repair", callId: `call-${++callNumber}` });
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

function proposal(context: CreativeRepairPlannerContext, toolId: string, edit: unknown): string {
  const selected = context.catalogue.tools.find(item => item.id === toolId);
  assert.ok(selected);
  return JSON.stringify({ kind: "invoke", toolId, toolVersion: selected.version,
    input: { baseRevisionId: context.repair.revisionId, edits: [edit] } });
}

function motion(context: CreativeRepairPlannerContext, regress = false) {
  const { document, findings } = context.repair;
  const issue = findings.find(item => item.check === "model" && item.code === "INSPECT_NODE_OUTSIDE_FRAME");
  if (!issue) return;
  const track = document.animationTracks.find(item => item.targetNodeId === issue.nodeId && item.targetProperty === "transform.position");
  assert.ok(track);
  const key = track.keyframes.find(item => issue.ranges.some(range => range.startFrame <= item.frame && item.frame < range.endFrame));
  assert.ok(key && Array.isArray(key.value));
  const [x, y, z] = key.value;
  const sequence = document.sequences[0];
  return proposal(context, "animation.keyframes.edit", { op: "update", trackId: track.id, frame: key.frame,
    changes: { value: [regress ? sequence.width + 500 : Math.min(x, sequence.width - 96), y, z] } });
}

function chart(context: CreativeRepairPlannerContext) {
  const finding = context.repair.findings.find(item => item.check === "layout" && item.code === "LAYOUT_VIEWPORT_OVERFLOW");
  if (!finding) return;
  const measurement = context.repair.reports.layout?.frames.flatMap(frame => frame.nodes)
    .find(node => node.nodeId === finding.nodeId && node.type === "chart" && node.viewportOverflow.right > 0);
  assert.ok(measurement);
  return proposal(context, "graphics.2d.edit", { kind: "chart", nodeId: measurement.nodeId,
    changes: { width: Math.floor(measurement.declared.width - measurement.viewportOverflow.right - 20) } });
}

function caption(context: CreativeRepairPlannerContext, leadingOnly = false) {
  const issue = context.repair.findings.find(item => item.check === "timeline" && item.code === "TIMELINE_CAPTION_NARRATION_GAP");
  if (!issue) return;
  const cue = context.repair.document.sequences[0].captions?.find(item => item.id === issue.captionId);
  assert.ok(cue);
  const originalEnd = cue.startFrame + cue.durationFrames;
  const startFrame = issue.ranges.find(range => range.startFrame === cue.startFrame)?.endFrame ?? cue.startFrame;
  const endFrame = leadingOnly ? originalEnd : issue.ranges.find(range => range.endFrame === originalEnd)?.startFrame ?? originalEnd;
  return proposal(context, "timeline.edit", { op: "set-caption", captionId: cue.id,
    caption: { text: cue.text, startFrame, durationFrames: endFrame - startFrame } });
}

const repairer: CreativeRepairPlanner = { async propose(context) {
  assert.equal(context.brief, brief);
  assert.ok(context.catalogue.tools.every(tool => !tool.execution.destructive && !tool.id.startsWith("project.snapshot.")));
  const response = motion(context) ?? chart(context) ?? caption(context);
  assert.ok(response, "Expected a supported finding");
  return response;
} };

try {
  execFileSync("ffmpeg", ["-v", "error", "-i", "docs/showcase/cpu-cache-30s.mp4", "-map", "0:a:0", "-t", "6", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", voicePath],
    { timeout: 15_000 });
  host = await openCreativeHost({ directory, assetImports: [{ projectId, sourceId: "voice", path: voicePath, mediaType: "audio/wav" }] });
  const editor = host.createSession({ projectId, toolIds: tools, allowDestructive: true,
    permissions: ["project.read", "project.write", "artifact.write", "snapshot.read", "snapshot.write", "snapshot.restore", "execution.read"] });
  await invoke(editor, "project.create", { name: "CPU cache repair", episodeId: "cache-loop", width: 640, height: 360, fps: 10, durationFrames: 80 });
  await invoke(editor, "project.scene.create", { sceneId: "cache", name: "缓存", startFrame: 0, durationFrames: 80 });
  await invoke(editor, "graphics.2d.text.create", { sceneId: "cache", nodeId: "title", text: "缓存，把常用数据放得更近", x: 40, y: 32,
    fontSize: 30, width: 550, height: 55 });
  await invoke(editor, "graphics.2d.shape.create", { sceneId: "cache", nodeId: "marker", primitive: "rect", x: 80, y: 255, width: 46, height: 30 });
  await invoke(editor, "graphics.2d.chart.create", { sceneId: "cache", nodeId: "latency", chartType: "bar", x: 322, y: 104, width: 350, height: 160,
    data: [{ label: "较远", value: 8 }, { label: "缓存", value: 2 }] });
  await invoke(editor, "animation.keyframes.set", { trackId: "position", targetNodeId: "marker", targetProperty: "transform.position",
    keyframes: [{ frame: 0, value: [80, 255, 0] }, { frame: 20, value: [720, 255, 0] }, { frame: 39, value: [480, 255, 0] }] });
  const imported = await invoke<{ revisionId: string }>(editor, "assets.import", { sourceId: "voice", assetId: "narration", mediaType: "audio/wav" });
  await invoke(editor, "timeline.edit", { baseRevisionId: imported.revisionId, edits: [
    { op: "place-clip", trackId: "voice", clip: { id: "voice-clip", assetId: "narration", startFrame: 10, durationFrames: 55 } },
    { op: "set-caption", captionId: "cue", caption: { text: captionText, startFrame: 4, durationFrames: 66 } },
  ] });
  const original = await invoke<ProjectDocument>(editor, "project.inspect");
  const before = await invoke<SnapshotReceipt>(editor, "project.snapshot.save", { snapshotId: "original", revisionId: revision(original) });

  const regressed = await repairCreativeSnapshot(editor, { async propose(context) { return motion(context, true)!; } },
    { snapshotId: before.id, brief, checks: motionOnly });
  await save("regressed.json", regressed);
  assert.equal(regressed.stop, "regressed");
  assert.equal(regressed.lastVerified?.snapshotHash, before.contentHash);
  assert.equal(regressed.repairsAttempted, 1);
  assert.equal(regressed.repairsVerified, 0);
  assert.ok(regressed.rejectedCandidate);
  const restored = await invoke<ProjectDocument>(editor, "project.snapshot.restore", { snapshotId: before.id,
    baseRevisionId: regressed.rejectedCandidate.revisionId, message: "Restore the verified fallback before the successful fixture" });
  const repeatBase = await invoke<SnapshotReceipt>(editor, "project.snapshot.save", { snapshotId: "repetition-baseline", revisionId: revision(restored) });

  const repeated = await repairCreativeSnapshot(editor, { async propose(context) { return caption(context, true)!; } },
    { snapshotId: repeatBase.id, brief, checks: timelineOnly });
  await save("repeated.json", repeated);
  assert.equal(repeated.stop, "repeated-proposal");
  assert.equal(repeated.repairsAttempted, 1);
  assert.equal(repeated.repairsVerified, 1);
  assert.deepEqual(repeated.lastVerified?.findings[0]?.ranges, [{ startFrame: 65, endFrame: 70 }]);

  const repaired = await repairCreativeSnapshot(editor, repairer, { snapshotId: repeated.lastVerified!.snapshotId, brief, checks });
  await save("repaired.json", repaired);
  assert.equal(repaired.stop, "verified", JSON.stringify(repaired.run.stop));
  assert.equal(repaired.repairsAttempted, 3);
  assert.equal(repaired.repairsVerified, 3);
  assert.deepEqual(repaired.lastVerified?.findings, []);
  assert.ok(repaired.baseline?.findings.some(item => item.check === "model" && item.nodeId === "marker"));
  assert.ok(repaired.baseline?.findings.some(item => item.check === "layout" && item.nodeId === "latency"));
  assert.ok(repaired.baseline?.findings.some(item => item.check === "timeline" && item.captionId === "cue"));

  const conflict = await repairCreativeSnapshot(editor, repairer, { snapshotId: before.id, brief, checks: motionOnly });
  await save("conflict.json", conflict);
  assert.equal(conflict.stop, "revision-conflict");
  assert.equal(conflict.lastVerified?.snapshotHash, before.contentHash);
  assert.equal(conflict.repairsAttempted, 1);
  assert.equal(conflict.repairsVerified, 0);
  assert.equal(revision(await invoke<ProjectDocument>(editor, "project.inspect")), repaired.lastVerified!.revisionId);

  const budget = await repairCreativeSnapshot(editor, { async propose() { assert.fail("Budget exhausted before proposing an edit"); } },
    { snapshotId: before.id, brief, checks: motionOnly, maxRepairs: 0 });
  await save("budget.json", budget);
  assert.equal(budget.stop, "repair-limit");
  assert.equal(budget.repairsAttempted, 0);
  assert.equal(budget.lastVerified?.snapshotHash, before.contentHash);

  await host.close();
  host = await openCreativeHost({ directory });
  const reader = host.createSession({ projectId, toolIds: ["project.snapshot.inspect", "execution.list"], permissions: ["snapshot.read", "execution.read"] });
  const draft = await invoke<ProjectSnapshot>(reader, "project.snapshot.inspect", { snapshotId: repaired.lastVerified!.snapshotId });
  const fallback = await invoke<ProjectSnapshot>(reader, "project.snapshot.inspect", { snapshotId: before.id });
  assert.equal(draft.contentHash, repaired.lastVerified?.snapshotHash);
  assert.equal(draft.contentHash, hashProject(draft.document));
  assert.equal(fallback.contentHash, before.contentHash);
  assert.deepEqual(fallback.document, original);
  assert.deepEqual(draft.document.editorial, original.editorial);
  assert.deepEqual(draft.document.assets, original.assets);
  assert.deepEqual(draft.document.clips, original.clips);
  assert.deepEqual(draft.document.nodes.filter(node => node.id !== "latency"), original.nodes.filter(node => node.id !== "latency"));
  const chartData = (document: ProjectDocument) => document.nodes.find(node => node.id === "latency")?.components[0].data.chartData;
  assert.deepEqual(chartData(draft.document), chartData(original));
  assert.deepEqual(draft.document.sequences[0].captions, [{ id: "cue", text: captionText, startFrame: 10, durationFrames: 55 }]);
  const runIds = new Set([regressed, repeated, repaired, conflict, budget].map(record => record.run.runId));
  const records = (await invoke<ToolExecutionRecord[]>(reader, "execution.list")).filter(record => runIds.has(record.runId));
  assert.equal(records.filter(record => record.runId === conflict.run.runId && record.toolId === "project.snapshot.save").length, 0);
  assert.equal(records.filter(record => record.runId === repeated.run.runId && record.toolId === "timeline.edit").length, 1);
  await save("executions.json", records);
  await save("original-snapshot.json", fallback);
  await save("repaired-snapshot.json", draft);
  Object.assign(evidence, { status: "passed", fixed: repaired.repairsVerified, remaining: repaired.lastVerified?.findings,
    repaired: { id: draft.id, contentHash: draft.contentHash }, fallback: { id: fallback.id, contentHash: fallback.contentHash },
    stops: { regression: regressed.stop, repeat: repeated.stop, conflict: conflict.stop, budget: budget.stop } });
  console.log("PASS: inspection-driven repairs verified on the same coverage with a retained fallback and bounded stops");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    try { await save("evidence.json", evidence); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
