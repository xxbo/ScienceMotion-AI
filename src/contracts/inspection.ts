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
