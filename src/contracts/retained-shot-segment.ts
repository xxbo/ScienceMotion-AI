import type { DeliveryProfile, DeliveryRange } from "./creative-delivery";
import type { RenderJobSubmission } from "./render-job";

export const RETAINED_SHOT_SEGMENT_VERSION = "1.0.0" as const;

/** Immutable one-source export. It does not choose a position, trim or transition in an edit. */
export interface RetainedShotSegment {
  schemaVersion: typeof RETAINED_SHOT_SEGMENT_VERSION;
  projectId: string;
  source: {
    snapshot: RenderJobSubmission["snapshot"] & { artifactId: string };
    scope: { kind: "sequence" | "scene"; id: string };
    /** Half-open source-frame interval. Media frame zero is startFrame. */
    range: DeliveryRange;
  };
  origin: { kind: "render-job"; jobId: string; inputHash: string };
  renderer: RenderJobSubmission["renderer"];
  profile: DeliveryProfile;
  media: {
    artifactId: string;
    contentHash: string;
    sizeBytes: number;
    mediaType: "video/mp4";
    codec: "h264";
    pixelFormat: "yuv420p";
    frameCount: number;
    silent: true;
  };
}
