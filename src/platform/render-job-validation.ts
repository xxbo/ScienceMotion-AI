import { RENDER_JOB_SCHEMA_VERSION, RENDER_JOB_STATES, type RenderJobRecord, type RenderJobSubmission, type RenderJobReceipt } from "../contracts/render-job";
import { assertFiniteJson } from "./project-creative-edits";
import { hashToolInput } from "./tool-execution-store";

export class RenderJobError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RenderJobError"; }
}
export const jobFail = (code: string, message: string): never => { throw new RenderJobError(code, message); };
export const activeJobStates = new Set(["queued", "running", "stopping", "publishing"]);
export const MAX_RENDER_JOB_RECORD_BYTES = 16 * 1024;
export const progressPhases = ["bundling", "selecting", "rendering", "encoding"];
const invalid = (message: string): never => jobFail("RENDER_JOB_INVALID", message);
export function jobObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !keys.includes(key))) invalid("Expected an object with only documented job fields");
}
export function jobIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 128) invalid("Invalid bounded job identity");
}
export function jobInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("Invalid bounded job integer");
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid("Invalid SHA-256 job evidence");
}
export function jobCopy<T>(value: T): T {
  try {
    assertFiniteJson(value);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_RENDER_JOB_RECORD_BYTES) invalid("Job input/evidence exceeds 16 KiB");
    return JSON.parse(text) as T;
  } catch (error) { if (error instanceof RenderJobError) throw error; return invalid("Job evidence must be bounded finite JSON"); }
}
export function validateJobSubmission(input: RenderJobSubmission): void {
  jobObject(input, ["projectId", "submissionId", "runId", "callId", "toolVersion", "snapshot", "render", "profile", "renderer"]);
  for (const value of [input.projectId, input.submissionId, input.runId, input.callId, input.toolVersion]) jobIdentity(value);
  jobObject(input.snapshot, ["id", "revisionId", "contentHash"]);
  jobIdentity(input.snapshot.id); jobIdentity(input.snapshot.revisionId); hash(input.snapshot.contentHash);
  jobObject(input.renderer, ["id", "version"]); jobIdentity(input.renderer.id); jobIdentity(input.renderer.version);
  jobObject(input.profile, ["width", "height", "fps"]);
  jobInteger(input.profile.width, 1, 7680); jobInteger(input.profile.height, 1, 7680);
  if (typeof input.profile.fps !== "number" || !Number.isFinite(input.profile.fps) || input.profile.fps <= 0 || input.profile.fps > 120) invalid("Invalid render FPS");
  jobObject(input.render, ["operation", "frame", "startFrame", "durationFrames", "sceneId"]);
  if (input.render.sceneId !== undefined) jobIdentity(input.render.sceneId);
  if (input.render.operation === "preview") {
    jobObject(input.render, ["operation", "frame", "sceneId"]); jobInteger(input.render.frame);
  } else if (input.render.operation === "video") {
    jobObject(input.render, ["operation", "startFrame", "durationFrames", "sceneId"]);
    jobInteger(input.render.startFrame); jobInteger(input.render.durationFrames, 1, 900);
    jobInteger(input.render.startFrame + input.render.durationFrames);
  } else invalid("Job operation must be preview or video");
}
export function validateJobProgress(value: unknown): void {
  jobObject(value, ["phase", "fraction"]);
  if (!progressPhases.includes(value.phase as string) || (value.fraction !== undefined &&
      (typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1))) invalid("Invalid render progress");
}
export function validateJobDiagnostic(value: unknown): void {
  jobObject(value, ["code", "message"]); jobIdentity(value.code);
  if (typeof value.message !== "string" || !value.message.trim() || Buffer.byteLength(value.message) > 2048) invalid("Invalid bounded job diagnostic");
}
export function validateJobReceipt(receipt: RenderJobReceipt, record: RenderJobRecord): void {
  jobObject(receipt, ["jobId", "inputHash", "artifactId", "contentHash", "sizeBytes", "mediaType", "rendererId", "rendererVersion"]);
  hash(receipt.contentHash); jobInteger(receipt.sizeBytes, 8, 64 * 1024 * 1024);
  if (receipt.jobId !== record.id || receipt.inputHash !== record.inputHash || receipt.artifactId !== `sha256:${receipt.contentHash}` ||
      receipt.rendererId !== record.input.renderer.id || receipt.rendererVersion !== record.input.renderer.version ||
      receipt.mediaType !== (record.input.render.operation === "preview" ? "image/png" : "video/mp4")) invalid("Result receipt differs from the admitted job identity or output declaration");
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid("Invalid canonical job timestamp");
  return Date.parse(value);
}
/** Validate persisted invariants as well as schema. A checksum alone cannot establish a coherent job history. */
export function validateJobRecord(record: RenderJobRecord): void {
  jobCopy(record);
  jobObject(record, ["schemaVersion", "id", "input", "inputHash", "state", "revision", "createdAt", "updatedAt", "startedAt", "stop",
    "publicationStartedAt", "completedAt", "progress", "result", "diagnostic", "interruptedFrom", "outcomeUnknown"]);
  if (record.schemaVersion !== RENDER_JOB_SCHEMA_VERSION || !RENDER_JOB_STATES.includes(record.state)) invalid("Unsupported job version/state");
  jobIdentity(record.id); validateJobSubmission(record.input); hash(record.inputHash);
  if (hashToolInput(record.input) !== record.inputHash) invalid("Job input hash mismatch");
  jobInteger(record.revision);
  const created = timestamp(record.createdAt), updated = timestamp(record.updatedAt);
  if (updated < created || typeof record.outcomeUnknown !== "boolean") invalid("Invalid job timestamps/outcome");
  for (const value of [record.startedAt, record.publicationStartedAt, record.completedAt])
    if (value !== undefined && (timestamp(value) < created || timestamp(value) > updated)) invalid("Job timestamps are out of order");
  const terminal = !activeJobStates.has(record.state);
  if (terminal !== (record.completedAt !== undefined) || (terminal && record.completedAt !== record.updatedAt)) invalid("Terminal job requires its completion timestamp");
  if (record.startedAt && record.publicationStartedAt && timestamp(record.publicationStartedAt) < timestamp(record.startedAt)) invalid("Publication precedes execution");
  if (record.stop !== undefined) {
    jobObject(record.stop, ["reason", "requestedAt"]);
    if (!["cancelled", "timed-out"].includes(record.stop.reason) || timestamp(record.stop.requestedAt) < timestamp(record.startedAt ?? record.createdAt) ||
        timestamp(record.stop.requestedAt) > updated || record.publicationStartedAt) invalid("Invalid stop/publication evidence");
  }
  if (record.progress !== undefined) {
    jobObject(record.progress, ["phase", "fraction", "observedAt"]);
    const { observedAt, ...progress } = record.progress; validateJobProgress(progress);
    if (!record.startedAt || timestamp(observedAt) < timestamp(record.startedAt) || timestamp(observedAt) > updated ||
        (progress.phase === "encoding" && record.input.render.operation !== "video")) invalid("Progress does not belong to this execution");
  }
  if (record.diagnostic !== undefined) validateJobDiagnostic(record.diagnostic);
  if (record.result !== undefined) validateJobReceipt(record.result, record);
  if ((record.result !== undefined) !== (record.state === "succeeded")) invalid("Only successful jobs carry results");
  if ((record.diagnostic !== undefined) !== (terminal && record.state !== "succeeded")) invalid("Unsuccessful terminal jobs require diagnostics");
  if ((record.interruptedFrom !== undefined) !== (record.state === "interrupted")) invalid("Invalid interruption evidence");
  const prior = record.state === "interrupted" ? record.interruptedFrom! : record.state;
  if (record.state === "interrupted" && !activeJobStates.has(prior)) invalid("Interruption requires a previously active state");
  if ((prior === "queued" && (record.startedAt || record.stop || record.publicationStartedAt || record.progress)) ||
      (["running", "stopping", "publishing", "succeeded", "failed"].includes(prior) && !record.startedAt) ||
      (["queued", "running"].includes(prior) && (record.stop || record.publicationStartedAt)) ||
      (prior === "stopping" && (!record.stop || record.publicationStartedAt)) ||
      (["publishing", "succeeded"].includes(prior) && (!record.publicationStartedAt || record.stop)) ||
      (["cancelled", "timed-out"].includes(prior) && (record.stop?.reason !== prior || record.publicationStartedAt))) invalid("Inconsistent job state evidence");
  const uncertain = record.state === "interrupted" ? prior !== "queued" : record.state === "failed" && !!record.publicationStartedAt;
  if (record.outcomeUnknown !== uncertain || (record.state === "queued" ? record.revision !== 0 : record.revision === 0)) invalid("Invalid job revision/uncertainty");
}
