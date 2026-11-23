import type { TimelineFrameRange, TimelineInspectionInterval, TimelineInspectionIssue, TimelineInspectionOptions, TimelineInspectionReport } from "../contracts/inspection";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { firstSequenceAudioClips, firstSequencePngClips, firstSequenceShots } from "./project-timeline";
import { SnapshotInspectionError } from "./snapshot-inspection";

const MAX_TIMELINE_INTERVALS = 2000;
const frames = (startFrame: number, durationFrames: number): TimelineFrameRange => ({ startFrame, endFrame: startFrame + durationFrames });

function captionGaps(intervals: readonly TimelineInspectionInterval[]): TimelineInspectionIssue[] {
  const narration = intervals.filter(item => item.kind === "narration" && item.gain > 0);
  const issues: TimelineInspectionIssue[] = [];
  let index = 0;
  for (const item of intervals) {
    if (item.kind !== "caption") continue;
    const uncovered: TimelineFrameRange[] = [];
    let cursor = item.startFrame;
    while (index < narration.length && narration[index].endFrame <= cursor) index++;
    for (let i = index; i < narration.length && narration[i].startFrame < item.endFrame; i++) {
      const source = narration[i];
      if (cursor < source.startFrame) uncovered.push({ startFrame: cursor, endFrame: source.startFrame });
      cursor = Math.max(cursor, source.endFrame);
      if (cursor >= item.endFrame) break;
    }
    if (cursor < item.endFrame) uncovered.push({ startFrame: cursor, endFrame: item.endFrame });
    if (uncovered.length) issues.push({ level: "warning", code: "TIMELINE_CAPTION_NARRATION_GAP", captionId: item.captionId,
      message: "Caption extends outside declared positive-gain narration intervals", uncovered });
  }
  return issues;
}

/** Exact interval inspection on the first sequence after the host validates the snapshot document. */
export function inspectProjectTimeline(saved: ProjectSnapshot, options: TimelineInspectionOptions = {}): TimelineInspectionReport {
  const project = saved.document, sequence = project.sequences[0], revisionId = project.revisions.at(-1)?.id;
  if (saved.contentHash !== hashProject(project)) throw new SnapshotInspectionError("INSPECT_SNAPSHOT_CORRUPT", "Snapshot content hash does not match its document");
  if (!revisionId || saved.projectId !== project.project.id || !sequence)
    throw new SnapshotInspectionError("INSPECT_SNAPSHOT_INVALID", "Snapshot project, revision or sequence identity is missing or inconsistent");
  const { startFrame, durationFrames } = options.range ?? { startFrame: 0, durationFrames: sequence.durationFrames };
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(durationFrames) || durationFrames < 1 ||
      durationFrames > sequence.durationFrames - startFrame)
    throw new SnapshotInspectionError("INSPECT_TIMELINE_RANGE_INVALID", "Select a nonempty frame range inside the first sequence");
  const range = frames(startFrame, durationFrames);
  const intervals: TimelineInspectionInterval[] = [];
  const add = (interval: TimelineInspectionInterval) => {
    const start = Math.max(interval.startFrame, range.startFrame), end = Math.min(interval.endFrame, range.endFrame);
    if (start >= end) return;
    if (intervals.length === MAX_TIMELINE_INTERVALS)
      throw new SnapshotInspectionError("INSPECT_TIMELINE_WORK_LIMIT", "Select a range intersecting at most 2,000 timeline intervals");
    if ("sourceStartFrame" in interval) interval.sourceStartFrame += start - interval.startFrame;
    intervals.push({ ...interval, startFrame: start, endFrame: end });
  };
  const shots = firstSequenceShots(project);
  const starts = new Map(shots.map(shot => [shot.id, shot.startFrame]));
  for (const shot of shots) add({ kind: "shot", shotId: shot.id, sceneId: shot.sceneId,
    sourceStartFrame: shot.inFrame ?? 0, ...frames(shot.startFrame, shot.durationFrames) });
  for (const { clip, artifactId } of firstSequencePngClips(project)) add({ kind: "png", clipId: clip.id, assetId: clip.assetId,
    artifactId, ...frames(clip.startFrame, clip.durationFrames) });
  for (const { clip, source } of firstSequenceAudioClips(project)) add({ kind: "narration", clipId: clip.id, assetId: clip.assetId,
    artifactId: source.artifactId, gain: clip.gain ?? 1, sourceStartFrame: clip.inFrame ?? 0, ...frames(clip.startFrame, clip.durationFrames) });
  for (const cue of sequence.captions ?? []) add({ kind: "caption", captionId: cue.id, ...frames(cue.startFrame, cue.durationFrames) });
  for (const transition of sequence.transitions ?? []) {
    const start = starts.get(transition.toShotId);
    if (start !== undefined) add({ kind: "crossfade", fromShotId: transition.fromShotId, toShotId: transition.toShotId,
      ...frames(start, transition.durationFrames) });
  }
  intervals.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const requireNarrationForCaptions = options.requireNarrationForCaptions === true;
  const issues = requireNarrationForCaptions ? captionGaps(intervals) : [];
  return { schemaVersion: "1.0.0", inspector: { id: "project-graph.timeline", version: "1.0.0" },
    snapshotId: saved.id, snapshotHash: saved.contentHash, projectId: saved.projectId, revisionId,
    sequenceId: sequence.id, fps: sequence.fps, sequenceFrames: sequence.durationFrames, range, intervals, issues,
    outcome: issues.length ? "issues-found" : "no-issues-detected",
    coverage: { mode: "exact-intervals", requireNarrationForCaptions, checks: ["snapshot-integrity", "first-sequence-intervals",
      ...(requireNarrationForCaptions ? ["declared-caption-narration-coverage"] : [])],
      notChecked: ["audio-waveform", "speech-alignment", "caption-layout", "final-pixels", "scientific-accuracy", "presentation-quality"] } };
}
