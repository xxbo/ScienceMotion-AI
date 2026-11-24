import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { ArtifactStore } from "../contracts/artifact";
import type { CreativeDeliveryOptions, CreativeDeliveryRecoveryReport, CreativeDeliveryReport, DeliveryFrameSelection,
  DeliveryProfile, DeliveryRange, DeliverySnapshot, DeliveryVisualReviewer } from "../contracts/creative-delivery";
import type { CreativeSession } from "../contracts/creative-host";
import type { CreativeJobSubmission } from "../contracts/creative-jobs";
import type { ProjectDocument } from "../contracts/project";
import type { RenderJobRecord, RenderJobSubmission } from "../contracts/render-job";
import { abortable } from "./abortable";
import { selectDeliveryFrames } from "./creative-delivery-frames";
import { verifyDeliveryPreview, verifyDeliveryVideo } from "./creative-delivery-media";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { firstSequenceAudioClips } from "./project-timeline";
import { readVerifiedJobArtifact } from "./render-job-output";
import { activeJobStates, validateJobRecord } from "./render-job-validation";

type Session = Pick<CreativeSession, "projectId" | "manifest" | "invoke" | "jobs">;
type ArtifactReader = Pick<ArtifactStore, "get" | "read">;
type Execution = Pick<CreativeDeliveryOptions, "signal" | "timeoutMs" | "reviewer">;
const MAX_PREVIEWS = 12;
const MAX_REVIEW_BYTES = 32 * 1024 * 1024;

export class CreativeDeliveryError extends Error {
  constructor(readonly code: string, message: string, readonly jobId?: string) { super(message); this.name = "CreativeDeliveryError"; }
}
const fail = (code: string, message: string, jobId?: string): never => { throw new CreativeDeliveryError(code, message, jobId); };

async function withinDelivery<T>(options: Execution, work: (signal: AbortSignal) => Promise<T>) {
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) fail("DELIVERY_DEADLINE_INVALID", "Invalid delivery deadline");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new CreativeDeliveryError("DELIVERY_DEADLINE", "Delivery verification reached its deadline")), timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try { signal.throwIfAborted(); return await work(signal); }
  finally { clearTimeout(timer); }
}

async function toolVersion(session: Session, toolId: string, signal: AbortSignal) {
  const tool = await abortable(signal, () => session.manifest(toolId));
  return tool?.version ?? fail("DELIVERY_TOOL_UNAVAILABLE", `The session cannot use ${toolId}`);
}

async function approvedSnapshot(session: Session, expected: DeliverySnapshot, runId: string, callId: string, signal: AbortSignal): Promise<ProjectSnapshot> {
  const toolId = "project.snapshot.inspect", version = await toolVersion(session, toolId, signal);
  const result = await abortable(signal, () => session.invoke({ toolId, toolVersion: version, input: { snapshotId: expected.id }, runId, callId, signal }));
  const saved = result.output as ProjectSnapshot | undefined;
  if (!result.ok || !saved?.document?.sequences?.[0] || saved.id !== expected.id || saved.projectId !== session.projectId ||
    saved.document.project.id !== saved.projectId || saved.document.revisions.at(-1)?.id !== expected.revisionId ||
    saved.contentHash !== expected.contentHash || hashProject(saved.document) !== expected.contentHash)
    return fail("DELIVERY_SNAPSHOT_MISMATCH", "Approval does not match a retained snapshot and revision in this session");
  return saved;
}

// Restore creates a new audit trail and update timestamp for the same authored project.
function renderContentHash(document: ProjectDocument) {
  return hashProject({ ...document, project: { ...document.project, updatedAt: document.project.createdAt }, revisions: [] });
}

function exportRange(document: ProjectDocument, requested?: DeliveryRange): DeliveryRange {
  const total = document.sequences[0].durationFrames;
  const { startFrame, durationFrames } = requested ?? { startFrame: 0, durationFrames: total };
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(durationFrames) || durationFrames < 1 ||
    durationFrames > 900 || durationFrames > total - startFrame)
    fail("DELIVERY_RANGE_INVALID", "Select up to 900 consecutive frames inside the approved first sequence");
  return { startFrame, durationFrames };
}

async function renderJob(session: Session, snapshot: DeliverySnapshot, profile: DeliveryProfile, runId: string,
  version: string, render: RenderJobSubmission["render"], signal: AbortSignal): Promise<RenderJobRecord & { result: NonNullable<RenderJobRecord["result"]> }> {
  const callId = render.operation === "preview" ? `preview-${render.frame}` : "video";
  const ids = { runId, submissionId: `${runId}-${callId}`, callId, toolVersion: version };
  const request: CreativeJobSubmission = render.operation === "preview"
    ? { ...ids, toolId: "render.preview", input: { snapshotId: snapshot.id, frame: render.frame } }
    : { ...ids, toolId: "render.video", input: { snapshotId: snapshot.id, startFrame: render.startFrame, durationFrames: render.durationFrames } };
  signal.throwIfAborted();
  let { record } = await session.jobs.submit(request);
  const jobId = record.id, inputHash = record.inputHash;
  const expected = { ...ids, projectId: session.projectId, snapshot, profile, render, renderer: record.input.renderer };
  if (!isDeepStrictEqual(record.input, expected)) return fail("DELIVERY_JOB_MISMATCH", "Render admission does not match the approved snapshot and range", jobId);
  try {
    signal.throwIfAborted();
    while (activeJobStates.has(record.state)) {
      await delay(50, undefined, { signal });
      const current = await abortable(signal, () => session.jobs.get(jobId));
      if (!current || current.id !== jobId || current.inputHash !== inputHash)
        return fail("DELIVERY_JOB_MISMATCH", "Render job identity changed while observing its result", jobId);
      record = current;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    if (activeJobStates.has(record.state)) {
      try {
        const stopped = await abortable(AbortSignal.timeout(5_000), () => session.jobs.cancel(jobId));
        if (stopped.record.id !== jobId || stopped.record.inputHash !== inputHash ||
          (!stopped.accepted && activeJobStates.has(stopped.record.state))) throw new Error("Cancellation was not accepted");
      }
      catch { return fail("DELIVERY_CANCEL_UNCONFIRMED", "The render cancellation could not be confirmed", jobId); }
    }
    throw signal.reason;
  }
  validateJobRecord(record);
  if (!isDeepStrictEqual(expected, record.input))
    return fail("DELIVERY_JOB_MISMATCH", "Render result differs from the admitted request", jobId);
  if (record.state !== "succeeded" || !record.result)
    return fail(record.diagnostic?.code ?? "DELIVERY_JOB_FAILED", record.diagnostic?.message ?? "Render job did not succeed", jobId);
  return { ...record, result: record.result };
}

async function deliver(session: Session, artifacts: ArtifactReader, source: ProjectSnapshot, approval: DeliverySnapshot, range: DeliveryRange,
  selection: DeliveryFrameSelection, runId: string, reviewer: DeliveryVisualReviewer | undefined, signal: AbortSignal): Promise<CreativeDeliveryReport> {
  const { width, height, fps } = source.document.sequences[0];
  const profile = { width, height, fps };
  const previewVersion = await toolVersion(session, "render.preview", signal);
  const videoVersion = await toolVersion(session, "render.video", signal);
  const reviewerId = reviewer?.id;
  if (reviewer && (typeof reviewerId !== "string" || !reviewerId.trim() || Buffer.byteLength(reviewerId) > 128))
    fail("DELIVERY_REVIEW_INVALID", "Use a bounded reviewer identity");
  const reportPreviews: CreativeDeliveryReport["previews"] = [];
  const reviewInputs: Parameters<DeliveryVisualReviewer["review"]>[0]["previews"] = [];
  let reviewBytes = 0;
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-delivery-"));
  try {
    const bytesFor = async (job: RenderJobRecord & { result: NonNullable<RenderJobRecord["result"]> }) =>
      (await abortable(signal, () => readVerifiedJobArtifact(artifacts, job.result))) ?? fail("DELIVERY_ARTIFACT_MISSING", "Render output is missing", job.id);
    for (const selected of selection.frames) {
      const { frame } = selected;
      const job = await renderJob(session, approval, profile, runId, previewVersion, { operation: "preview", frame }, signal);
      const bytes = await bytesFor(job);
      const file = join(directory, "preview.png");
      await writeFile(file, bytes, { signal });
      reportPreviews.push({ frame, job, rgbaHash: await verifyDeliveryPreview(file, profile, signal) });
      if (reviewer) {
        reviewBytes += bytes.byteLength;
        if (reviewBytes > MAX_REVIEW_BYTES) fail("DELIVERY_REVIEW_LIMIT", "Selected review previews exceed 32 MiB");
        reviewInputs.push({ ...selected, artifactId: job.result.artifactId, png: bytes });
      }
    }
    const job = await renderJob(session, approval, profile, runId, videoVersion, { operation: "video", ...range }, signal);
    const file = join(directory, "delivery.mp4");
    await writeFile(file, await bytesFor(job), { signal });
    const end = range.startFrame + range.durationFrames;
    const requireAudio = firstSequenceAudioClips(source.document).some(({ clip }) =>
      (clip.gain ?? 1) > 0 && clip.startFrame < end && clip.startFrame + clip.durationFrames > range.startFrame);
    const decoded = await verifyDeliveryVideo(file, profile, range, requireAudio, signal);
    const report: CreativeDeliveryReport = { schemaVersion: "1.0.0", projectId: source.projectId, snapshot: approval,
      renderContentHash: renderContentHash(source.document), range, profile, selection, previews: reportPreviews, video: { job, decoded } };
    if (reviewer && reviewerId) {
      const observations = await abortable(signal, () => reviewer.review(structuredClone({ projectId: source.projectId, snapshot: approval, previews: reviewInputs }), signal));
      const selected = new Map(reviewInputs.map(input => [input.frame, input.artifactId]));
      if (!Array.isArray(observations) || observations.length > 64 || observations.some(item =>
        !item || !selected.has(item.frame) || !["info", "warning", "error"].includes(item.level) ||
        typeof item.message !== "string" || !item.message.trim() || Buffer.byteLength(item.message) > 1024))
        fail("DELIVERY_REVIEW_INVALID", "Reviewer observations must name selected frames and contain bounded messages");
      report.review = { reviewerId, snapshot: approval, observations: observations.map(({ frame, level, message }) =>
        ({ frame, level, message, artifactId: selected.get(frame)! })) };
    }
    signal.throwIfAborted();
    return report;
  } catch (error) {
    if (signal.aborted && !(error instanceof CreativeDeliveryError)) throw signal.reason;
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Produce and verify retained deliverables for an explicitly approved snapshot. */
export async function verifyCreativeDelivery(session: Session, artifacts: ArtifactReader, options: CreativeDeliveryOptions): Promise<CreativeDeliveryReport> {
  const { approved, range: requested } = structuredClone({ approved: options.approved, range: options.range });
  const limit = options.maxPreviewFrames ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PREVIEWS) fail("DELIVERY_PREVIEW_LIMIT", "Select from one to twelve review frames");
  const repair = options.repair;
  const checkpoint = repair?.lastVerified;
  if (repair && (repair.run.projectId !== session.projectId || !checkpoint || checkpoint.snapshotId !== approved.id ||
    checkpoint.revisionId !== approved.revisionId || checkpoint.snapshotHash !== approved.contentHash))
    fail("DELIVERY_REPAIR_MISMATCH", "Repair evidence does not belong to the approved verified checkpoint");
  const findings = structuredClone([...(repair?.baseline?.findings ?? []), ...(checkpoint?.findings ?? [])]);
  const runId = randomUUID();
  return withinDelivery(options, async signal => {
    const source = await approvedSnapshot(session, approved, runId, "read-approved", signal);
    const range = exportRange(source.document, requested);
    const selection = selectDeliveryFrames(source.document, range, limit, findings);
    return deliver(session, artifacts, source, approved, range, selection, runId, options.reviewer, signal);
  });
}

/** Verify a retained restore in a reopened session using the previously verified range and frames. */
export async function verifyCreativeDeliveryRecovery(session: Session, artifacts: ArtifactReader,
  options: Execution & { reference: CreativeDeliveryReport; restored: DeliverySnapshot }): Promise<CreativeDeliveryRecoveryReport> {
  const { reference, restored } = structuredClone({ reference: options.reference, restored: options.restored });
  const runId = randomUUID();
  return withinDelivery(options, async signal => {
    if (reference.projectId !== session.projectId || restored.id === reference.snapshot.id)
      fail("DELIVERY_RESTORE_MISMATCH", "Recovery requires a new retained snapshot in the original project");
    const original = await approvedSnapshot(session, reference.snapshot, runId, "read-original", signal);
    const saved = await approvedSnapshot(session, restored, runId, "read-restored", signal);
    if (saved.document.revisions.at(-1)?.snapshotHash !== original.contentHash || restored.revisionId === reference.snapshot.revisionId ||
      renderContentHash(original.document) !== reference.renderContentHash || renderContentHash(saved.document) !== reference.renderContentHash)
      fail("DELIVERY_RESTORE_MISMATCH", "Restored snapshot lineage or authored content differs from the verified reference");
    const range = exportRange(saved.document, reference.range);
    const frames = reference.selection.frames.map(item => item.frame);
    if (!frames.length || frames.length > MAX_PREVIEWS || frames.some((frame, index) => !Number.isSafeInteger(frame) || frame < range.startFrame ||
      frame >= range.startFrame + range.durationFrames || (index > 0 && frame <= frames[index - 1])) ||
      !isDeepStrictEqual(frames, reference.previews.map(item => item.frame)))
      fail("DELIVERY_RESTORE_MISMATCH", "Reference preview frames are inconsistent with the verified export range");
    const recovered = await deliver(session, artifacts, saved, restored, range, reference.selection, runId, options.reviewer, signal);
    const pixels = (report: CreativeDeliveryReport) => report.previews.map(item => [item.frame, item.rgbaHash]);
    const audio = (report: CreativeDeliveryReport) => {
      const decoded = report.video.decoded.audio;
      return decoded && [decoded.sampleRate, decoded.channels, decoded.samples, decoded.pcmHash];
    };
    if (!isDeepStrictEqual(recovered.profile, reference.profile) || !isDeepStrictEqual(pixels(recovered), pixels(reference)) ||
      recovered.video.decoded.frames !== reference.video.decoded.frames || recovered.video.decoded.rgbHash !== reference.video.decoded.rgbHash ||
      !isDeepStrictEqual(audio(recovered), audio(reference))) fail("DELIVERY_RECOVERY_MEDIA_MISMATCH", "Restored previews, video or audio differ after decoding");
    const { rgbHash, audio: recoveredAudio } = recovered.video.decoded;
    return { schemaVersion: "1.0.0", sourceSnapshot: reference.snapshot, restored: recovered,
      comparison: { previewFrames: frames, rgbHash, ...(recoveredAudio ? { pcmHash: recoveredAudio.pcmHash } : {}) } };
  });
}
