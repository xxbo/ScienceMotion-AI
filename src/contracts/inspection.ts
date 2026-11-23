/** Inspection evidence is scoped to an immutable snapshot, never a claim about final pixels. */
export interface SnapshotInspectionIssue {
  level: "warning" | "error";
  code: string;
  message: string;
  source: "render-model" | "declared-geometry";
  nodeId?: string;
  trackId?: string;
  sceneId?: string;
  frames: number[];
}
export interface SnapshotInspectionReport {
  schemaVersion: "1.0.0";
  inspector: { id: "project-graph.model"; version: "1.0.0" };
  snapshotId: string;
  snapshotHash: string;
  projectId: string;
  revisionId: string;
  sequenceId: string;
  outcome: "issues-found" | "no-issues-detected";
  coverage: {
    selection: "automatic" | "explicit";
    mode: "all-frames" | "sampled-frames";
    totalFrames: number;
    checkedFrames: number[];
    omittedCandidateFrames: number;
    checks: string[];
    notChecked: string[];
  };
  frames: Array<{ frame: number; sceneId?: string; projectedElements: number; visibleCandidates: number }>;
  issues: SnapshotInspectionIssue[];
  issuesTruncated: boolean;
  omittedIssueOccurrences: number;
}

export interface TimelineFrameRange { startFrame: number; endFrame: number }
export interface TimelineInspectionOptions {
  range?: { startFrame: number; durationFrames: number };
  requireNarrationForCaptions?: boolean;
}
export type TimelineInspectionInterval = TimelineFrameRange & (
  | { kind: "shot"; shotId: string; sceneId: string; sourceStartFrame: number }
  | { kind: "png"; clipId: string; assetId: string; artifactId: string }
  | { kind: "narration"; clipId: string; assetId: string; artifactId: string; sourceStartFrame: number; gain: number }
  | { kind: "caption"; captionId: string }
  | { kind: "crossfade"; fromShotId: string; toShotId: string }
);
export interface TimelineInspectionIssue {
  level: "warning";
  code: "TIMELINE_CAPTION_NARRATION_GAP";
  message: string;
  captionId: string;
  uncovered: TimelineFrameRange[];
}
export interface TimelineInspectionReport {
  schemaVersion: "1.0.0";
  inspector: { id: "project-graph.timeline"; version: "1.0.0" };
  snapshotId: string;
  snapshotHash: string;
  projectId: string;
  revisionId: string;
  sequenceId: string;
  fps: number;
  sequenceFrames: number;
  range: TimelineFrameRange;
  coverage: { mode: "exact-intervals"; checks: string[]; notChecked: string[]; requireNarrationForCaptions: boolean };
  outcome: "issues-found" | "no-issues-detected";
  intervals: TimelineInspectionInterval[];
  issues: TimelineInspectionIssue[];
}
