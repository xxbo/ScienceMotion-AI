import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeDeliveryReport, DeliverySnapshot } from "../src/contracts/creative-delivery";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativePlannerContext, CreativeRunReport } from "../src/contracts/creative-planner";
import type { CreativeRepairPlannerContext } from "../src/contracts/creative-repair";
import type { ProjectDocument } from "../src/contracts/project";
import { abortable } from "../src/platform/abortable";
import { verifyCreativeDelivery, verifyCreativeDeliveryRecovery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import { repairCreativeSnapshot } from "../src/platform/creative-repair";
import { runCreativePlan } from "../src/platform/creative-runner";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { hashToolInput } from "../src/platform/tool-execution-store";
import { prepareRenderBundle } from "../src/renderers/remotion/prepared-render-bundle";
import { acceptanceTopics, cutFrame, draftId, durationFrames, fixturePlanner, fixtureRepair, keyFrame, markerId, profile,
  trackId, voice, type AcceptanceTopic } from "./fixtures/creative-acceptance-topics";

const interactive = process.argv[2] === "--interactive";
assert.ok(process.argv.length === (interactive ? 3 : 2), "Run the local fixtures or pass --interactive for the water brief");
const outputRoot = resolve(interactive ? "out/p1-4-e-live" : "out/p1-4-e");
await mkdir(outputRoot, { recursive: true });
const output = interactive ? await mkdtemp(join(outputRoot, "run-")) : outputRoot;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const provenance = { mode: interactive ? "interactive-planner" : "deterministic-local-adapter", sourceCommit,
  reportedModelUsage: null, newModelCalls: interactive ? null : 0 };
const planningTools = ["project.inspect", "project.create", "project.scene.create", "graphics.2d.shape.create", "graphics.2d.text.create",
  "animation.keyframes.set", "timeline.edit", "project.snapshot.save"];
const repairTools = ["project.snapshot.inspect", "inspect.snapshot", "inspect.layout", "inspect.timeline",
  "animation.keyframes.edit", "timeline.edit", "project.snapshot.save"];
const comparisonFrames = [0, 16, 28, 40, 52, 64, 79, 82, 100, 159];
const trustedRun = `accept-p1-4-e-${randomUUID()}`;
const revision = (document: ProjectDocument) => document.revisions.at(-1)!.id;
const saveJson = (directory: string, name: string, data: unknown) => writeFile(join(directory, name), JSON.stringify(data, null, 2) + "\n");
let trustedCalls = 0, proposals = 0;

const consoleInput = interactive ? createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }) : undefined;
const answers = consoleInput?.[Symbol.asyncIterator]();
const transcript = join(output, "transcript.jsonl");
if (interactive) {
  await writeFile(transcript, "", { flag: "wx" });
  process.stdout.write(JSON.stringify({ type: "trial-started", output, profile, durationFrames, cutFrame, keyFrame, markerId, trackId, draftId }) + "\n");
}

async function ask(stage: "plan" | "repair", context: CreativePlannerContext | CreativeRepairPlannerContext, signal?: AbortSignal) {
  assert.ok(answers && signal);
  signal.throwIfAborted();
  const request = { type: "proposal-request", id: ++proposals, stage, context };
  const requestLine = JSON.stringify(request) + "\n";
  await appendFile(transcript, requestLine);
  process.stdout.write(requestLine);
  const answer = await abortable(signal, () => answers.next());
  assert.ok(!answer.done && Buffer.byteLength(answer.value) <= 1024 * 1024, "Expected one bounded proposal reply");
  const { id, decision } = JSON.parse(answer.value) as { id: number; decision: unknown };
  assert.equal(id, request.id, "Reply must match the outstanding proposal");
  assert.ok(decision && typeof decision === "object", "Reply must contain a planner decision");
  await appendFile(transcript, JSON.stringify({ type: "proposal-reply", id, decision }) + "\n");
  return JSON.stringify(decision);
}

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown = {}) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, `Missing scoped tool ${toolId}`);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: trustedRun, callId: `call-${++trustedCalls}` });
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function inspectSnapshot(session: CreativeSession, approved: DeliverySnapshot) {
  const saved = await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: approved.id });
  assert.equal(saved.projectId, session.projectId);
  assert.equal(saved.contentHash, approved.contentHash);
  assert.equal(hashProject(saved.document), approved.contentHash);
  assert.equal(revision(saved.document), approved.revisionId);
  return saved;
}

async function saveRevision(session: CreativeSession, id: string, revisionId: string): Promise<DeliverySnapshot> {
  const saved = await invoke<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId: id, revisionId });
  assert.equal(saved.id, id);
  assert.equal(saved.projectId, session.projectId);
  return { id, revisionId, contentHash: saved.contentHash };
}

const jobsOf = (report: CreativeDeliveryReport) => [...report.previews.map(item => item.job), report.video.job];

async function preserveDelivery(directory: string, label: string, report: CreativeDeliveryReport, artifacts: FileSystemArtifactStore) {
  await saveJson(directory, `${label}.json`, report);
  const media = join(directory, label);
  await mkdir(media, { recursive: true });
  for (const job of jobsOf(report)) {
    assert.ok(job.result);
    const data = await readVerifiedJobArtifact(artifacts, job.result);
    assert.ok(data);
    const render = job.input.render;
    await writeFile(join(media, render.operation === "preview" ? `preview-${render.frame}.png` : "delivery.mp4"), data);
  }
}

function runMetrics(report: CreativeRunReport) {
  return { runId: report.runId, turns: report.plannerTurns, toolCalls: report.turns.filter(turn => turn.call).length, elapsedMs: report.elapsedMs };
}

function verifyRuns(ledger: ToolExecutionRecord[], runs: CreativeRunReport[]) {
  for (const run of runs) {
    const records = ledger.filter(item => item.runId === run.runId);
    assert.equal(records.length, run.turns.filter(turn => turn.call).length);
    for (const { decision, call } of run.turns) {
      if (!call) continue;
      assert.ok(decision.kind === "invoke" && call.result);
      const entry = records.find(item => item.callId === call.callId);
      assert.ok(entry);
      assert.deepEqual([entry.projectId, entry.toolId, entry.toolVersion, entry.inputHash, entry.status, entry.result],
        [run.projectId, decision.toolId, decision.toolVersion, hashToolInput(decision.input), call.result.ok ? "succeeded" : "failed", call.result]);
    }
  }
}

async function runTopic(topic: AcceptanceTopic) {
  const started = performance.now();
  const target = join(output, topic.id);
  await mkdir(target, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "sciencemotion-p1-4-e-"));
  const directory = join(root, "workspace"), voicePath = join(root, "narration.wav");
  const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
  const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", topic, provenance, profile, durationFrames, comparisonFrames };
  const projectId = `p14e-${topic.id}`;
  let host: CreativeHost | undefined;
  const reader = () => host!.createSession({ projectId, toolIds: ["project.snapshot.inspect", "execution.list"], permissions: ["snapshot.read", "execution.read"] });
  const editor = () => host!.createSession({ projectId, toolIds: ["animation.keyframes.edit", "project.snapshot.save", "project.snapshot.restore"],
    permissions: ["project.read", "project.write", "snapshot.write", "snapshot.restore"], allowDestructive: true });
  const deliverySession = () => host!.createSession({ projectId, toolIds: ["project.snapshot.inspect", "render.preview", "render.video"],
    permissions: ["snapshot.read", "artifact.write"] });
  const restore = (snapshotId: string, baseRevisionId: string, message: string) =>
    invoke<ProjectDocument>(editor(), "project.snapshot.restore", { snapshotId, baseRevisionId, message });
  const repair = (snapshotId: string, regress = false) => repairCreativeSnapshot(host!.createSession({ projectId, toolIds: repairTools,
    permissions: ["snapshot.read", "snapshot.write", "project.read", "project.write"] }),
    { propose: (context, signal) => interactive ? ask("repair", context, signal) : Promise.resolve(fixtureRepair(context, regress)) },
    { snapshotId, brief: topic.brief, checks: { model: { frames: comparisonFrames }, layout: { frames: comparisonFrames },
      timeline: { requireNarrationForCaptions: topic.narrated } }, maxRepairs: regress ? 1 : 2,
      limits: { maxTurns: 30, timeoutMs: interactive ? 600_000 : 90_000 } });

  try {
    if (topic.narrated) {
      execFileSync("ffmpeg", ["-v", "error", "-ss", String(voice.sourceStartSeconds), "-i", voice.source,
        "-t", String(voice.durationFrames / profile.fps), "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", voicePath], { timeout: 15_000 });
      evidence.narration = { ...voice, wavHash: createHash("sha256").update(await readFile(voicePath)).digest("hex") };
    }
    host = await openCreativeHost({ directory, assetImports: topic.narrated ?
      [{ projectId, sourceId: voice.sourceId, path: voicePath, mediaType: "audio/wav", attribution: "ScienceMotion AI CPU-cache showcase" }] : [] });
    const plan = host.createSession({ projectId, toolIds: [...planningTools, ...(topic.narrated ? ["assets.import"] : [])],
      permissions: ["project.read", "project.write", "snapshot.write", "artifact.write"] });
    const planning = await runCreativePlan(plan, interactive ? { propose: (context, signal) => ask("plan", context, signal) } : fixturePlanner(topic),
      { brief: topic.brief, limits: { maxTurns: 32, timeoutMs: interactive ? 900_000 : 30_000 } });
    await saveJson(target, "planning.json", planning);
    assert.equal(planning.stop.reason, "finished", JSON.stringify(planning.stop));
    const saved = planning.turns.find(turn => turn.call?.result?.ok && turn.decision.kind === "invoke" && turn.decision.toolId === "project.snapshot.save");
    assert.ok(saved?.call?.result && saved.decision.kind === "invoke");
    const receipt = saved.call.result.output as SnapshotReceipt;
    const planned = { id: receipt.id, contentHash: receipt.contentHash, revisionId: (saved.decision.input as { revisionId: string }).revisionId };
    assert.equal(planned.id, draftId);
    const draft = await inspectSnapshot(reader(), planned);
    await saveJson(target, "draft.json", draft);
    const sequence = draft.document.sequences[0];
    assert.deepEqual([sequence.width, sequence.height, sequence.fps, sequence.durationFrames], [profile.width, profile.height, profile.fps, durationFrames]);
    assert.equal(draft.document.editorial.episodeId, topic.id);
    assert.deepEqual(draft.document.shots?.map(shot => [shot.startFrame, shot.durationFrames]), [[0, cutFrame], [cutFrame, cutFrame]]);
    assert.equal(sequence.transitions?.length, 1);
    assert.equal(sequence.transitions[0].type, "crossfade");
    const key = draft.document.animationTracks.find(item => item.id === trackId && item.targetNodeId === markerId
      && item.targetProperty === "transform.position")?.keyframes.find(item => item.frame === keyFrame);
    assert.ok(key && Array.isArray(key.value) && key.value.length === 3 && key.value[0] >= 0 && key.value[0] < profile.width - 24);

    const seededEdit = await invoke<{ revisionId: string }>(editor(), "animation.keyframes.edit", { baseRevisionId: planned.revisionId,
      edits: [{ op: "update", trackId, frame: keyFrame, changes: { value: [profile.width + 80, key.value[1], key.value[2]] } }] });
    const seeded = await saveRevision(editor(), "seeded-draft", seededEdit.revisionId);
    let candidate = seeded;
    const runs = [planning];
    if (topic.narrated) {
      const failure = await repair(seeded.id, true);
      await saveJson(target, "bounded-failure.json", failure);
      assert.equal(failure.stop, "regressed", JSON.stringify(failure.run.stop));
      assert.equal(failure.repairsAttempted, 1);
      assert.equal(failure.repairsVerified, 0);
      assert.equal(failure.lastVerified?.snapshotHash, seeded.contentHash);
      assert.ok(failure.rejectedCandidate);
      const rejected = failure.rejectedCandidate;
      runs.push(failure.run);
      await host.close();
      host = await openCreativeHost({ directory });
      await inspectSnapshot(reader(), seeded);
      await inspectSnapshot(reader(), { id: rejected.snapshotId, revisionId: rejected.revisionId, contentHash: rejected.snapshotHash });
      const fallback = await restore(seeded.id, rejected.revisionId, "Restore the verified baseline after the seeded regression.");
      assert.equal(fallback.revisions.at(-1)?.snapshotHash, seeded.contentHash);
      candidate = await saveRevision(editor(), "recovered-baseline", revision(fallback));
      evidence.boundedFailure = { stop: failure.stop, attempts: failure.repairsAttempted, fallback: seeded, rejected, recovered: candidate,
        ...runMetrics(failure.run) };
    }

    const repaired = await repair(candidate.id);
    await saveJson(target, "repair.json", repaired);
    runs.push(repaired.run);
    assert.equal(repaired.stop, "verified", JSON.stringify(repaired.run.stop));
    const findings = repaired.baseline?.findings;
    assert.ok(findings);
    assert.ok(findings.some(item => item.nodeId === markerId && item.code === "INSPECT_NODE_OUTSIDE_FRAME"));
    assert.ok(findings.some(item => item.nodeId === markerId && item.code === "LAYOUT_VIEWPORT_OVERFLOW"));
    if (topic.narrated) assert.ok(findings.some(item => item.captionId === "hit" && item.code === "TIMELINE_CAPTION_NARRATION_GAP"));
    assert.equal(repaired.repairsVerified, topic.narrated ? 2 : 1);
    assert.ok(repaired.lastVerified);
    assert.deepEqual(repaired.lastVerified.findings, []);
    const { snapshotId: id, revisionId, snapshotHash: contentHash } = repaired.lastVerified;
    const approval = { id, revisionId, contentHash };
    const deliveredAt = performance.now();
    const delivery = await verifyCreativeDelivery(deliverySession(), artifacts, { approved: approval, repair: repaired, maxPreviewFrames: 6, timeoutMs: 150_000 });
    const deliveryMs = Math.round(performance.now() - deliveredAt);
    await preserveDelivery(target, "approved", delivery, artifacts);
    assert.equal(delivery.video.decoded.frames, durationFrames);
    assert.equal(delivery.video.decoded.durationSeconds, durationFrames / profile.fps);
    const reasons = new Set(delivery.selection.frames.flatMap(item => item.reasons));
    for (const reason of ["repair-finding", "shot-boundary", "crossfade", "export-range"] as const) assert.ok(reasons.has(reason));
    assert.ok(new Set(delivery.previews.map(item => item.rgbaHash)).size > 1);
    const audio = delivery.video.decoded.audio;
    if (topic.narrated) {
      assert.ok(reasons.has("caption-boundary") && audio);
      assert.notEqual(audio.pcmHash, createHash("sha256").update(Buffer.alloc(audio.samples * audio.channels * 2)).digest("hex"));
    } else assert.equal(audio, undefined);

    await host.close();
    if (topic.narrated) await rm(voicePath);
    const recoveryStarted = performance.now();
    const preparedBundle = await prepareRenderBundle(resolve("src/index.ts"), join(root, "prepared"));
    host = await openCreativeHost({ directory, renderWorker: { preparedBundle } });
    const session = deliverySession();
    for (const job of jobsOf(delivery)) assert.deepEqual(await session.jobs.get(job.id), job);
    const reverted = await restore(seeded.id, approval.revisionId, "Reopen the draft before restoring the approved cut.");
    const restored = await restore(approval.id, revision(reverted), "Restore the verified delivery after reopening.");
    const restoredIdentity = await saveRevision(editor(), "restored-delivery", revision(restored));
    const recovery = await verifyCreativeDeliveryRecovery(session, artifacts, { reference: delivery, restored: restoredIdentity, timeoutMs: 150_000 });
    const recoveryMs = Math.round(performance.now() - recoveryStarted);
    assert.deepEqual(recovery.comparison.previewFrames, delivery.previews.map(item => item.frame));
    await preserveDelivery(target, "restored", recovery.restored, artifacts);
    await saveJson(target, "comparison.json", recovery.comparison);

    const ledger = await invoke<ToolExecutionRecord[]>(reader(), "execution.list");
    verifyRuns(ledger, runs);
    const runIds = new Set([...runs.map(run => run.runId), trustedRun]);
    await saveJson(target, "executions.json", ledger.filter(item => runIds.has(item.runId)));
    Object.assign(evidence, { status: "passed", planned, approval, restored: restoredIdentity, findings,
      restoredMedia: recovery.comparison, metrics: { planning: runMetrics(planning), inspectionAndRepair: runMetrics(repaired.run),
        trustedToolCalls: ledger.filter(entry => entry.runId === trustedRun).length,
        deliveryMs, recoveryMs, exportJobs: jobsOf(delivery).length + jobsOf(recovery.restored).length,
        encodedVideoFrames: delivery.video.decoded.frames + recovery.restored.video.decoded.frames,
        encodedPreviewFrames: delivery.previews.length + recovery.restored.previews.length } });
    if (!interactive) console.log(`PASS ${topic.id}: verified planning, repair, delivery and recovery`);
  } catch (error) {
    Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    Object.assign(evidence, { elapsedMs: Math.round(performance.now() - started) });
    try { await host?.close(); }
    finally {
      try { await saveJson(target, "evidence.json", evidence); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
  return evidence;
}

const selected = interactive ? acceptanceTopics.filter(topic => topic.id === "water-loop") : acceptanceTopics;
const results = [];
try {
  for (const topic of selected) results.push(await runTopic(topic));
  await saveJson(output, "evidence.json", { schemaVersion: "1.0.0", status: "passed", provenance, interactiveProposals: proposals, topics: results });
  if (interactive) process.stdout.write(JSON.stringify({ type: "trial-finished", output, proposals }) + "\n");
} catch (error) {
  await saveJson(output, "evidence.json", { schemaVersion: "1.0.0", status: "failed", provenance, interactiveProposals: proposals,
    passedTopics: results.map(result => result.topic), failure: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  consoleInput?.close();
}
