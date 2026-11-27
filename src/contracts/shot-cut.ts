import type { DeliveryProfile, DeliveryRange } from "./creative-delivery";
import type { RetainedShotSegment } from "./retained-shot-segment";

export const SHOT_CUT_VERSION = "1.0.0" as const;

export interface ShotCutSpan {
  segmentId: string;
  projectId: string;
  source: RetainedShotSegment["source"];
  renderer: RetainedShotSegment["renderer"];
  mediaArtifactId: string;
  /** Half-open range in the output, not in the source snapshot. */
  output: DeliveryRange;
}

/** P2.4-B appends two complete segments. There are no placement or trim controls yet. */
export interface ShotCutPlan {
  schemaVersion: typeof SHOT_CUT_VERSION;
  profile: DeliveryProfile;
  durationFrames: number;
  spans: [ShotCutSpan, ShotCutSpan];
}

export interface ShotCutFrame {
  outputFrame: number;
  segmentId: string;
  mediaFrame: number;
  sourceFrame: number;
}

export interface ShotCutReport {
  plan: ShotCutPlan;
  media: {
    mediaType: "video/mp4";
    codec: "h264";
    sampleEntry: "avc3";
    pixelFormat: "yuv420p";
    silent: true;
    contentHash: string;
    sizeBytes: number;
    frameCount: number;
    durationSeconds: number;
    timescale: number;
  };
  verification: {
    mode: "stream-copy";
    allDecodedFramesMatch: true;
    /** SHA-256 over the decoded RGB bytes of each frame, in output order. */
    rgbFrameHashes: string[];
    seam: {
      before: ShotCutFrame & { rgbHash: string };
      after: ShotCutFrame & { rgbHash: string };
    };
  };
}
