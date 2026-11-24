import { isDeepStrictEqual } from "node:util";
import type { CreativeRepairChecks, CreativeRepairFinding, CreativeRepairReports } from "../contracts/creative-repair";
import type { TimelineFrameRange } from "../contracts/inspection";
import type { ProjectSnapshot } from "./project-snapshots";

export const inspectionTools = { model: "inspect.snapshot", layout: "inspect.layout", timeline: "inspect.timeline" } as const;
export type RepairCheck = keyof typeof inspectionTools;
type InspectionReport = NonNullable<CreativeRepairReports[RepairCheck]>;
const inspectors = { model: "project-graph.model", layout: "remotion.browser-layout", timeline: "project-graph.timeline" };

export function inspectionInput(check: RepairCheck, snapshotId: string, checks: CreativeRepairChecks, baseline?: CreativeRepairReports) {
  if (check === "timeline") {
    const range = baseline?.timeline?.range;
    return { ...checks.timeline, snapshotId, ...(range ? { range: { startFrame: range.startFrame, durationFrames: range.endFrame - range.startFrame } } : {}) };
  }
  const frames = baseline?.[check]?.coverage.checkedFrames ?? checks[check]?.frames;
  return frames ? { snapshotId, frames } : { snapshotId };
}

export function matchesInspection(check: RepairCheck, report: InspectionReport, snapshot: ProjectSnapshot, checks: CreativeRepairChecks,
  baseline?: CreativeRepairReports): boolean {
  const sequence = snapshot.document.sequences[0];
  if (!report || !Array.isArray(report.issues) || report.inspector?.id !== inspectors[check] || report.snapshotId !== snapshot.id || report.snapshotHash !== snapshot.contentHash ||
    report.projectId !== snapshot.projectId || report.revisionId !== snapshot.document.revisions.at(-1)?.id || report.sequenceId !== sequence.id)
    return false;
  if ("issuesTruncated" in report && report.issuesTruncated) return false;
  if (report.outcome !== (report.issues.length ? "issues-found" : "no-issues-detected")) return false;
  const previous = baseline?.[check];
  if (previous && !isDeepStrictEqual([report.schemaVersion, report.inspector, report.coverage.mode, report.coverage.checks, report.coverage.notChecked],
    [previous.schemaVersion, previous.inspector, previous.coverage.mode, previous.coverage.checks, previous.coverage.notChecked])) return false;

  if (check === "timeline" && "range" in report) {
    const requested = checks.timeline?.range ?? { startFrame: 0, durationFrames: sequence.durationFrames };
    const range = baseline?.timeline?.range ?? { startFrame: requested.startFrame, endFrame: requested.startFrame + requested.durationFrames };
    return report.fps === sequence.fps && report.sequenceFrames === sequence.durationFrames &&
      (!baseline?.timeline || (report.fps === baseline.timeline.fps && report.sequenceFrames === baseline.timeline.sequenceFrames)) &&
      report.coverage.requireNarrationForCaptions === (checks.timeline?.requireNarrationForCaptions === true) &&
      isDeepStrictEqual(report.range, range) && report.issues.every(issue => issue.uncovered.every(gap => coversRange([range], gap)));
  }
  if (check === "timeline" || !("frames" in report) || (check === "layout") !== ("cost" in report) ||
      report.coverage.totalFrames !== sequence.durationFrames) return false;
  const checked = report.coverage.checkedFrames;
  const checkedSet = new Set(checked);
  if (!isDeepStrictEqual(report.frames.map(frame => frame.frame), checked) || checkedSet.size !== checked.length ||
      checked.some(frame => !Number.isSafeInteger(frame) || frame < 0 || frame >= sequence.durationFrames) ||
      report.issues.some(issue => "frames" in issue ? issue.frames.some(frame => !checkedSet.has(frame)) : !checkedSet.has(issue.frame))) return false;
  const frames = baseline?.[check]?.coverage.checkedFrames ?? checks[check]?.frames;
  if (frames && !isDeepStrictEqual(checked, [...frames].sort((a, b) => a - b))) return false;
  if (previous && "frames" in previous && previous.coverage.totalFrames !== report.coverage.totalFrames) return false;
  if ("cost" in report && previous && "cost" in previous) {
    const surfaces = (layout: typeof report) => layout.frames.map(frame => [frame.frame, frame.sceneId, frame.viewport, frame.environment]);
    return isDeepStrictEqual(surfaces(report), surfaces(previous));
  }
  return true;
}

const frameRange = (frame: number): TimelineFrameRange => ({ startFrame: frame, endFrame: frame + 1 });
function findingKey(finding: CreativeRepairFinding): string {
  return JSON.stringify([finding.check, finding.source, finding.code, finding.level, finding.nodeId, finding.trackId, finding.captionId, finding.sceneId]);
}

function mergeRanges(ranges: TimelineFrameRange[]): TimelineFrameRange[] {
  const merged: TimelineFrameRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)) {
    const last = merged.at(-1);
    if (last && range.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, range.endFrame);
    else merged.push({ ...range });
  }
  return merged;
}

export function repairFindings(reports: CreativeRepairReports): CreativeRepairFinding[] {
  const findings = new Map<string, CreativeRepairFinding>();
  const add = (finding: CreativeRepairFinding) => {
    const key = findingKey(finding);
    const previous = findings.get(key);
    if (previous) previous.ranges = [...previous.ranges, ...finding.ranges];
    else findings.set(key, finding);
  };
  for (const { frames, ...issue } of reports.model?.issues ?? []) add({ check: "model", ...issue, ranges: frames.map(frameRange) });
  for (const { frame, ...issue } of reports.layout?.issues ?? []) add({ check: "layout", ...issue, ranges: [frameRange(frame)] });
  for (const { uncovered, ...issue } of reports.timeline?.issues ?? []) add({ check: "timeline", ...issue, ranges: uncovered });
  return [...findings.values()].map(finding => ({ ...finding, ranges: mergeRanges(finding.ranges) }));
}

function coversRange(ranges: readonly TimelineFrameRange[], target: TimelineFrameRange): boolean {
  return ranges.some(range => range.startFrame <= target.startFrame && range.endFrame >= target.endFrame);
}

export function compareRepairFindings(before: readonly CreativeRepairFinding[], after: readonly CreativeRepairFinding[],
  targets: readonly CreativeRepairFinding[]): "improved" | "regressed" | "no-progress" {
  const original = new Map(before.map(finding => [findingKey(finding), finding.ranges]));
  const current = new Map(after.map(finding => [findingKey(finding), finding.ranges]));
  for (const [key, ranges] of current) {
    if (ranges.some(range => !coversRange(original.get(key) ?? [], range))) return "regressed";
  }
  return targets.some(finding => finding.ranges.some(range => !coversRange(current.get(findingKey(finding)) ?? [], range))) ? "improved" : "no-progress";
}
