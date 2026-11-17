import type { ProjectGraphLayoutRequest, ProjectGraphPreviewRequest, ProjectGraphRenderProgress, ProjectGraphVideoRequest } from "./renderer";

export type RenderWorkerOperation = "preview" | "video" | "layout";
export type RenderWorkerRequest = ProjectGraphPreviewRequest | ProjectGraphVideoRequest | ProjectGraphLayoutRequest;
type SerializedRequest<T> = T extends unknown ? Omit<T, "signal" | "onProgress"> : never;
export interface RenderWorkerPolicy {
  timeoutMs: number;
  maxConcurrentJobs: number;
  maxOutputBytes: number;
  /** V8 old-space only: this is not a total RSS limit for Chromium/FFmpeg. */
  maxOldSpaceMb: number;
  killGraceMs: number;
}
export interface RenderWorkerEvent {
  jobId: string; operation: RenderWorkerOperation; projectId: string; snapshotHash: string;
  state: "starting" | "running" | "completed" | "cancelled" | "timed-out" | "failed";
  processId?: number; elapsedMs: number; progress?: ProjectGraphRenderProgress; code?: string;
}
/** Private file/IPC protocol between trusted application-owned processes. No workspace/store handles. */
export interface RenderWorkerJob {
  protocolVersion: "1.0.0"; jobId: string; operation: RenderWorkerOperation; entryPoint: string;
  maxOutputBytes: number; request: SerializedRequest<RenderWorkerRequest>;
}
export interface RenderWorkerReceipt {
  protocolVersion: "1.0.0"; type: "result"; jobId: string; operation: RenderWorkerOperation;
  projectId: string; revisionId: string; snapshotHash: string;
  rendererId: string; rendererVersion: string; bytes: number; sha256: string;
}
