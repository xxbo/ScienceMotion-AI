import type { CreativePlannerContext, CreativeRunOptions, CreativeRunReport } from "./creative-planner";
import type { SnapshotInspectionReport, TimelineFrameRange, TimelineInspectionOptions, TimelineInspectionReport } from "./inspection";
import type { SnapshotLayoutInspectionReport } from "./layout-inspection";
import type { ProjectDocument } from "./project";

export interface CreativeRepairReports {
  model?: SnapshotInspectionReport;
  layout?: SnapshotLayoutInspectionReport;
  timeline?: TimelineInspectionReport;
}

export interface CreativeRepairChecks {
  model?: { frames?: readonly number[] };
  layout?: { frames?: readonly number[] };
  timeline?: TimelineInspectionOptions;
}

export interface CreativeRepairFinding {
  check: keyof CreativeRepairReports;
  source?: string;
  code: string;
  level: "warning" | "error";
  message: string;
  nodeId?: string;
  trackId?: string;
  captionId?: string;
  sceneId?: string;
  ranges: TimelineFrameRange[];
}

export interface CreativeRepairCheckpoint {
  snapshotId: string;
  snapshotHash: string;
  revisionId: string;
  findings: CreativeRepairFinding[];
}

export interface CreativeRepairPlannerContext extends CreativePlannerContext {
  /** Read-only evidence from the retained snapshot against which the proposal will be checked. */
  repair: CreativeRepairCheckpoint & { document: ProjectDocument; reports: CreativeRepairReports };
}

export interface CreativeRepairPlanner {
  propose(context: CreativeRepairPlannerContext, signal?: AbortSignal): Promise<string>;
}

export interface CreativeRepairOptions extends CreativeRunOptions {
  snapshotId: string;
  checks?: CreativeRepairChecks;
  maxRepairs?: number;
}

export type CreativeRepairStop = "verified" | "unresolved" | "needs-input" | "out-of-scope" | "repeated-proposal" |
  "repair-limit" | "no-progress" | "regressed" | "incomparable-inspection" | "revision-conflict" | "tool-failed" | "execution-stopped";

export interface CreativeRepairReport {
  schemaVersion: "1.0.0";
  stop: CreativeRepairStop;
  baseline?: CreativeRepairCheckpoint;
  lastVerified?: CreativeRepairCheckpoint;
  rejectedCandidate?: CreativeRepairCheckpoint;
  repairsAttempted: number;
  repairsVerified: number;
  run: CreativeRunReport;
}
