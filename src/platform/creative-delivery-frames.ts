import type { DeliveryFrameReason, DeliveryFrameSelection, DeliveryRange } from "../contracts/creative-delivery";
import type { CreativeRepairFinding } from "../contracts/creative-repair";
import type { ProjectDocument } from "../contracts/project";
import { firstSequenceShots } from "./project-timeline";

const reasons = ["repair-finding", "shot-boundary", "crossfade", "caption-boundary", "export-range"] as const;

/** The caller supplies the validated first-sequence export range and preview limit. */
export function selectDeliveryFrames(document: ProjectDocument, range: DeliveryRange, limit: number,
  findings: readonly CreativeRepairFinding[] = []): DeliveryFrameSelection {
  const start = range.startFrame;
  const end = start + range.durationFrames;
  const sequence = document.sequences[0];
  const byFrame = new Map<number, Set<DeliveryFrameReason>>();
  const byReason = new Map<DeliveryFrameReason, number[]>(reasons.map(reason => [reason, []]));
  const add = (frame: number, reason: DeliveryFrameReason) => {
    if (!Number.isSafeInteger(frame) || frame < start || frame >= end) return;
    const tags = byFrame.get(frame) ?? new Set<DeliveryFrameReason>();
    if (!tags.has(reason)) byReason.get(reason)!.push(frame);
    tags.add(reason);
    byFrame.set(frame, tags);
  };
  const midpoint = (from: number, to: number, reason: DeliveryFrameReason) => {
    const left = Math.max(start, from), right = Math.min(end, to);
    if (left < right) add(left + Math.floor((right - left - 1) / 2), reason);
  };
  const boundary = (frame: number, reason: DeliveryFrameReason) => { add(frame - 1, reason); add(frame, reason); };

  for (const finding of findings) for (const range of finding.ranges)
    midpoint(range.startFrame, range.endFrame, "repair-finding");
  const shots = firstSequenceShots(document);
  const cuts = new Set(shots.flatMap(shot => [shot.startFrame, shot.startFrame + shot.durationFrames]));
  for (const cut of [...cuts].sort((a, b) => a - b))
    if (cut > 0 && cut < sequence.durationFrames) boundary(cut, "shot-boundary");
  const shotsById = new Map(shots.map(shot => [shot.id, shot]));
  for (const cut of sequence.transitions ?? []) {
    const incoming = shotsById.get(cut.toShotId);
    if (!incoming) continue;
    const from = incoming.startFrame, to = from + cut.durationFrames;
    midpoint(from, to, "crossfade");
    boundary(from, "crossfade");
    boundary(to, "crossfade");
  }
  for (const caption of sequence.captions ?? []) {
    boundary(caption.startFrame, "caption-boundary");
    boundary(caption.startFrame + caption.durationFrames, "caption-boundary");
  }
  add(start, "export-range");
  add(end - 1, "export-range");
  midpoint(start, end, "export-range");

  // Sample across categories so numerous findings cannot crowd out cuts or captions.
  const selected = new Set<number>();
  const buckets = [...byReason.values()];
  const depth = Math.max(...buckets.map(bucket => bucket.length));
  for (let row = 0; row < depth && selected.size < limit; row++) {
    for (const bucket of buckets) {
      if (bucket[row] !== undefined) selected.add(bucket[row]);
      if (selected.size === limit) break;
    }
  }
  const frames = [...selected].sort((a, b) => a - b).map(frame => ({ frame, reasons: reasons.filter(reason => byFrame.get(frame)!.has(reason)) }));
  return { frames, candidateCount: byFrame.size, omittedCount: byFrame.size - frames.length };
}
