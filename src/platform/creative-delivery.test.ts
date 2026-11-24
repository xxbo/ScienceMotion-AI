import assert from "node:assert/strict";
import test from "node:test";
import type { CreativeSession } from "../contracts/creative-host";
import type { CreativeJobSubmission, CreativeRenderJobs } from "../contracts/creative-jobs";
import type { RenderJobRecord, RenderJobSubmission } from "../contracts/render-job";
import { verifyCreativeDelivery } from "./creative-delivery";
import { selectDeliveryFrames } from "./creative-delivery-frames";
import { createEmptyProject } from "./empty-project";
import { InMemorySnapshotStore } from "./project-snapshots";
import { jobOutputReceipt } from "./render-job-output";
import { hashToolInput } from "./tool-execution-store";

const createdAt = "2026-11-24T00:00:00.000Z";
const profile = { width: 640, height: 360, fps: 10 };
const jobId = "delivery-job";
const artifacts = { get: async () => assert.fail("Unexpected artifact lookup"), read: async () => assert.fail("Unexpected artifact read") };
const project = () => createEmptyProject({ id: "p", name: "Delivery", episodeId: "e", durationFrames: 80, ...profile, createdAt });

function fixture(jobs: Partial<CreativeRenderJobs> = {}) {
  const document = project();
  const saved = new InMemorySnapshotStore().save(document, { id: "approved", createdAt });
  const approval = { id: saved.id, revisionId: document.revisions[0].id, contentHash: saved.contentHash };
  const session: Pick<CreativeSession, "projectId" | "manifest" | "invoke" | "jobs"> = {
    projectId: saved.projectId,
    manifest: async id => ({ id, version: "1.0.0", namespace: "test", name: id, description: id, category: "test",
      inputSchema: {}, outputSchema: {}, execution: { deterministic: true, stateful: false, destructive: false, cost: "low" } }),
    invoke: async () => ({ ok: true, output: saved, diagnostics: [] }),
    jobs: { submit: async () => assert.fail("Unexpected job submission"), get: async () => assert.fail("Unexpected job observation"),
      cancel: async () => assert.fail("Unexpected job cancellation"), list: async () => assert.fail("Unexpected job listing"), ...jobs },
  };
  return { session, approval };
}

function admission(request: CreativeJobSubmission, snapshot: RenderJobSubmission["snapshot"]): RenderJobRecord {
  assert.equal(request.toolId, "render.preview");
  const { runId, callId, submissionId, toolVersion } = request;
  const input: RenderJobSubmission = { runId, callId, submissionId, toolVersion, projectId: "p", snapshot, profile,
    renderer: { id: "renderer", version: "1.0.0" }, render: { operation: "preview", frame: request.input.frame } };
  return { id: jobId, schemaVersion: "1.0.0", input, inputHash: hashToolInput(input), state: "queued", revision: 0,
    createdAt, updatedAt: createdAt, outcomeUnknown: false };
}

test("delivery samples distinct in-range repair, cut, crossfade and caption frames under the preview cap", () => {
  const document = project();
  document.shots = [
    { id: "a", name: "A", sceneId: "a", startFrame: 0, durationFrames: 40 },
    { id: "b", name: "B", sceneId: "b", startFrame: 40, durationFrames: 40 },
  ];
  Object.assign(document.sequences[0], { shotIds: ["a", "b"], transitions: [{ type: "crossfade", fromShotId: "a", toShotId: "b", durationFrames: 5 }],
    captions: [{ id: "cue", text: "A timed cue", startFrame: 13, durationFrames: 52 }] });
  const selected = selectDeliveryFrames(document, { startFrame: 12, durationFrames: 56 }, 6, [{
    check: "model", code: "INSPECT_NODE_OUTSIDE_FRAME", level: "warning", message: "Marker overflow",
    ranges: [{ startFrame: 0, endFrame: 15 }, { startFrame: 24, endFrame: 25 }, { startFrame: 78, endFrame: 80 }],
  }]);
  assert.deepEqual(selected, { candidateCount: 11, omittedCount: 5, frames: [
    { frame: 12, reasons: ["caption-boundary", "export-range"] },
    { frame: 13, reasons: ["repair-finding", "caption-boundary"] },
    { frame: 24, reasons: ["repair-finding"] },
    { frame: 39, reasons: ["shot-boundary", "crossfade", "export-range"] },
    { frame: 40, reasons: ["shot-boundary", "crossfade"] },
    { frame: 42, reasons: ["crossfade"] },
  ] });
  assert.deepEqual(selectDeliveryFrames(project(), { startFrame: 79, durationFrames: 1 }, 8),
    { candidateCount: 1, omittedCount: 0, frames: [{ frame: 79, reasons: ["export-range"] }] });
});

test("delivery rejects a stale approved revision and out-of-bounds range before admission", async () => {
  const { session, approval } = fixture();
  await assert.rejects(verifyCreativeDelivery(session, artifacts, { approved: { ...approval, revisionId: "stale" } }),
    { code: "DELIVERY_SNAPSHOT_MISMATCH" });
  await assert.rejects(verifyCreativeDelivery(session, artifacts, { approved: approval, range: { startFrame: 79, durationFrames: 2 } }),
    { code: "DELIVERY_RANGE_INVALID" });
});

test("delivery rejects render admission bound to a different snapshot", async () => {
  const { session, approval } = fixture({
    async submit(request) { return { created: true, record: admission(request, { ...approval, contentHash: "a".repeat(64) }) }; },
  });
  await assert.rejects(verifyCreativeDelivery(session, artifacts, { approved: approval }), { code: "DELIVERY_JOB_MISMATCH", jobId });
});

test("delivery rejects an output receipt for a different job before reading artifacts", async () => {
  const { session, approval } = fixture({ async submit(request) {
    const record = admission(request, approval);
    record.result = { ...jobOutputReceipt(record, "b".repeat(64), 800), jobId: "other-job" };
    Object.assign(record, { state: "succeeded", revision: 3, startedAt: createdAt, publicationStartedAt: createdAt, completedAt: createdAt });
    return { created: true, record };
  } });
  await assert.rejects(verifyCreativeDelivery(session, artifacts, { approved: approval }), { code: "RENDER_JOB_INVALID" });
});

test("delivery cancels the admitted render and reports an unconfirmed stop when publication has started", async () => {
  for (const accepted of [true, false]) {
    const controller = new AbortController(), reason = new Error("Stop requested");
    let record: RenderJobRecord, cancellations = 0;
    const { session, approval } = fixture({
      async submit(request) {
        record = admission(request, approval);
        controller.abort(reason);
        return { created: true, record };
      },
      async cancel(id) {
        assert.equal(id, jobId);
        cancellations++;
        return { accepted, record: { ...record, state: accepted ? "cancelled" : "publishing" } };
      },
    });
    await assert.rejects(verifyCreativeDelivery(session, artifacts, { approved: approval, signal: controller.signal }),
      error => accepted ? error === reason : error instanceof Error && "code" in error && error.code === "DELIVERY_CANCEL_UNCONFIRMED");
    assert.equal(cancellations, 1);
  }
});
