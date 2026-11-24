import type { ToolDiagnostic } from "./agent-tool";
import type { CreativeRepairReport } from "./creative-repair";
import type { RenderJobRecord, RenderJobSubmission } from "./render-job";

export type DeliverySnapshot = RenderJobSubmission["snapshot"];
export type DeliveryProfile = RenderJobSubmission["profile"];
export interface DeliveryRange { startFrame: number; durationFrames: number }
export type DeliveryFrameReason = "repair-finding" | "shot-boundary" | "crossfade" | "caption-boundary" | "export-range";
export interface DeliveryFrame { frame: number; reasons: DeliveryFrameReason[] }
export interface DeliveryFrameSelection { frames: DeliveryFrame[]; candidateCount: number; omittedCount: number }

export interface DeliveryVisualObservation {
  frame: number;
  level: ToolDiagnostic["level"];
  message: string;
}
export interface DeliveryVisualReviewer {
  id: string;
  review(input: { projectId: string; snapshot: DeliverySnapshot;
    previews: Array<DeliveryFrame & { artifactId: string; png: Uint8Array }> }, signal?: AbortSignal): Promise<readonly DeliveryVisualObservation[]>;
}
export interface CreativeDeliveryOptions {
  approved: DeliverySnapshot;
  repair?: CreativeRepairReport;
  range?: DeliveryRange;
  maxPreviewFrames?: number;
  reviewer?: DeliveryVisualReviewer;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface DeliveryPreviewEvidence {
  frame: number;
  job: RenderJobRecord;
  rgbaHash: string;
}
export interface DeliveryVideoEvidence {
  codec: string;
  frames: number;
  durationSeconds: number;
  rgbHash: string;
  audio?: { codec: string; sampleRate: number; channels: number; samples: number; pcmHash: string };
}
export interface CreativeDeliveryReport {
  schemaVersion: "1.0.0";
  projectId: string;
  snapshot: DeliverySnapshot;
  renderContentHash: string;
  range: DeliveryRange;
  profile: DeliveryProfile;
  selection: DeliveryFrameSelection;
  previews: DeliveryPreviewEvidence[];
  video: { job: RenderJobRecord; decoded: DeliveryVideoEvidence };
  review?: { reviewerId: string; snapshot: DeliverySnapshot; observations: Array<DeliveryVisualObservation & { artifactId: string }> };
}
export interface CreativeDeliveryRecoveryReport {
  schemaVersion: "1.0.0";
  sourceSnapshot: DeliverySnapshot;
  restored: CreativeDeliveryReport;
  comparison: { previewFrames: number[]; rgbHash: string; pcmHash?: string };
}
