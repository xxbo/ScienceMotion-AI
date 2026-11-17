import type { ProjectGraphRenderProgress } from "./renderer";

export const RENDER_JOB_SCHEMA_VERSION = "1.0.0" as const;
export const RENDER_JOB_STATES = ["queued", "running", "stopping", "publishing", "succeeded", "failed", "cancelled", "timed-out", "interrupted"] as const;
export type RenderJobState = typeof RENDER_JOB_STATES[number];
export type RenderJobActiveState = Extract<RenderJobState, "queued" | "running" | "stopping" | "publishing">;
export type RenderJobStopReason = "cancelled" | "timed-out";

/** Resolved by a trusted host, not a wire request. B2 must authorize, validate and retain the snapshot before admission. */
export interface RenderJobSubmission {
  projectId: string;
  /** Idempotency scope is the JSON tuple [projectId, submissionId]. */
  submissionId: string;
  runId: string;
  callId: string;
  toolVersion: string;
  snapshot: { id: string; revisionId: string; contentHash: string };
  render: { operation: "preview"; frame: number; sceneId?: string } |
    { operation: "video"; startFrame: number; durationFrames: number; sceneId?: string };
  profile: { width: number; height: number; fps: number };
  renderer: { id: string; version: string };
}
/** Binds a published Artifact to the entire immutable request, including project/snapshot/profile/tool identity. */
export interface RenderJobReceipt {
  jobId: string;
  inputHash: string;
  artifactId: string;
  contentHash: string;
  sizeBytes: number;
  mediaType: "image/png" | "video/mp4";
  rendererId: string;
  rendererVersion: string;
}
export interface RenderJobDiagnostic { code: string; message: string }
export interface RenderJobRecord {
  schemaVersion: typeof RENDER_JOB_SCHEMA_VERSION;
  id: string;
  input: RenderJobSubmission;
  inputHash: string;
  state: RenderJobState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stop?: { reason: RenderJobStopReason; requestedAt: string };
  publicationStartedAt?: string;
  completedAt?: string;
  progress?: ProjectGraphRenderProgress & { observedAt: string };
  result?: RenderJobReceipt;
  diagnostic?: RenderJobDiagnostic;
  interruptedFrom?: RenderJobActiveState;
  outcomeUnknown: boolean;
}
export type RenderJobCompletion = { state: "succeeded"; result: RenderJobReceipt } |
  { state: "failed"; diagnostic: RenderJobDiagnostic } | { state: RenderJobStopReason };
export interface RenderJobPage { jobs: RenderJobRecord[]; total: number; offset: number; limit: number }
/** Internal single-writer service. Tokens authorize executor transitions; project scope is mandatory even for reads. */
export interface RenderJobStore {
  submit(input: RenderJobSubmission): Promise<{ created: boolean; record: RenderJobRecord }>;
  get(projectId: string, jobId: string): Promise<RenderJobRecord | undefined>;
  list(projectId: string, query?: { offset?: number; limit?: number }): Promise<RenderJobPage>;
  claim(projectId: string, jobId: string): Promise<{ token: string; record: RenderJobRecord }>;
  progress(projectId: string, jobId: string, token: string, value: ProjectGraphRenderProgress): Promise<{ updated: boolean; record: RenderJobRecord }>;
  requestStop(projectId: string, jobId: string, reason: RenderJobStopReason): Promise<{ accepted: boolean; record: RenderJobRecord }>;
  /** Persist the publication barrier after worker cleanup and before any Artifact publication. */
  beginPublication(projectId: string, jobId: string, token: string): Promise<RenderJobRecord>;
  /** Trusted executor acknowledgement after cleanup/publication; this ledger does not observe OS processes or Artifact bytes. */
  finish(projectId: string, jobId: string, token: string, completion: RenderJobCompletion): Promise<RenderJobRecord>;
  /** Stop new calls and drain admitted ledger operations. The caller must stop/drain its executors separately. */
  close(): Promise<void>;
}
