/** Browser layout evidence describes boxes, not visible ink, occlusion or artistic quality. */
export interface LayoutRect { x: number; y: number; width: number; height: number }
export interface LayoutNodeMeasurement {
  nodeId: string;
  type: "text" | "shape" | "path" | "chart";
  opacity: number;
  declared: { width: number; height: number };
  elementBounds: LayoutRect;
  contentBounds: LayoutRect;
  boundsKind: "text-line-boxes" | "element-box";
  viewportOverflow: { left: number; top: number; right: number; bottom: number };
  text?: {
    lineCount: number;
    lineBoxes: LayoutRect[];
    lineBoxesTruncated: boolean;
    layoutWidth: number;
    layoutHeight: number;
    overflowX: number;
    overflowY: number;
    requestedFontFamily: string;
    computedFontFamily: string;
    fontSize: number;
    fontWeight: string;
    firstFamilyStatus: "generic" | "available-likely" | "fallback-likely" | "unverified";
    fontProbeWidths: number[];
  };
}
export interface LayoutFrameMeasurement {
  frame: number;
  sceneId?: string;
  projectId: string;
  viewport: LayoutRect;
  environment: { userAgent: string; devicePixelRatio: number; fontsStatus: string };
  nodes: LayoutNodeMeasurement[];
}
export interface LayoutInspectionIssue {
  level: "warning" | "error";
  code: string;
  message: string;
  frame: number;
  nodeId?: string;
  sceneId?: string;
}
export interface SnapshotLayoutInspectionReport {
  schemaVersion: "1.0.0";
  inspector: { id: "remotion.browser-layout"; version: "1.0.0" };
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
  frames: LayoutFrameMeasurement[];
  issues: LayoutInspectionIssue[];
  issuesTruncated: boolean;
  omittedIssueOccurrences: number;
  cost: { elapsedMs: number; browserFrames: number; encodedImageFrames: 0; visualModelCalls: 0 };
}
