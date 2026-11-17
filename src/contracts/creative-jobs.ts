import type { RenderJobPage, RenderJobRecord } from "./render-job";

/** Host API 1.0.0, exposed by local-client protocol 1.1.0. Authority and resolved identities are host-owned. */
export const CREATIVE_JOBS_VERSION = "1.0.0" as const;
export type CreativeJobSubmission = { submissionId: string; runId: string; callId: string; toolVersion: string } & (
  | { toolId: "render.preview"; input: { snapshotId: string; frame: number; sceneId?: string } }
  | { toolId: "render.video"; input: { snapshotId: string; startFrame: number; durationFrames: number; sceneId?: string } }
);
export interface CreativeRenderJobs {
  submit(request: CreativeJobSubmission): Promise<{ created: boolean; record: RenderJobRecord }>;
  get(jobId: string): Promise<RenderJobRecord | undefined>;
  list(query?: { offset?: number; limit?: number }): Promise<RenderJobPage>;
  cancel(jobId: string): Promise<{ accepted: boolean; record: RenderJobRecord }>;
}
/** Trusted launch limits for native background jobs; per-project FIFO with round-robin dispatch. */
export interface CreativeJobPolicy {
  /** Waiting jobs, excluding reserved execution slots. Zero disables waiting. */
  maxQueuedJobs: number;
  /** Slots include claim, rendering, cleanup and serialized publication. */
  maxConcurrentJobs: number;
  timeoutMs: number;
  /** Legacy input only: one running slot plus N - 1 waiting slots. Do not mix with the new counts. */
  maxActiveJobs?: number;
}
