import { isDeepStrictEqual } from "node:util";
import type { CreativePlannerDecision } from "../contracts/creative-planner";
import type { CreativeRepairFinding } from "../contracts/creative-repair";
import type { ProjectAnimationTrack, ProjectDocument } from "../contracts/project";
import { sampleAnimationTrack } from "./animation";
import { firstSequenceShots } from "./project-timeline";

export const repairToolIds: ReadonlySet<string> = new Set(["graphics.2d.edit", "project.patch.apply", "animation.keyframes.edit", "timeline.edit"]);
const boundsCodes = new Set(["INSPECT_DEGENERATE_GEOMETRY", "INSPECT_NONFINITE_GEOMETRY", "INSPECT_NODE_OUTSIDE_FRAME", "INSPECT_NODE_CLIPPED", "LAYOUT_VIEWPORT_OVERFLOW"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function keyAffectsFinding(document: ProjectDocument, track: ProjectAnimationTrack, key: number, finding: CreativeRepairFinding): boolean {
  const shots = firstSequenceShots(document);
  const interpolated = track.keyframes.find(item => item.frame === key)?.interpolation !== "step";
  for (const range of finding.ranges) for (let frame = range.startFrame; frame < range.endFrame; frame++) {
    const shot = shots.find(item => item.startFrame <= frame && frame < item.startFrame + item.durationFrames);
    const localFrame = shot ? frame - shot.startFrame + (shot.inFrame ?? 0) : frame;
    const sample = sampleAnimationTrack(track, localFrame);
    if (sample && (sample.fromFrame === key || (interpolated && sample.toFrame === key))) return true;
  }
  return false;
}

/** Return the diagnosed occurrences a single scope-checked edit is allowed to address. */
export function scopedRepairFindings(decision: Extract<CreativePlannerDecision, { kind: "invoke" }>, document: ProjectDocument,
  findings: readonly CreativeRepairFinding[]): CreativeRepairFinding[] {
  const { toolId, input } = decision;
  if (!object(input) || input.baseRevisionId !== document.revisions.at(-1)?.id) return [];
  const edits = toolId === "project.patch.apply" ? input.patches : input.edits;
  if (!Array.isArray(edits) || edits.length !== 1 || !object(edits[0])) return [];
  const edit = edits[0];
  const nodeBounds = (nodeId: unknown) => findings.filter(finding => finding.nodeId === nodeId && boundsCodes.has(finding.code));

  switch (toolId) {
    case "graphics.2d.edit": {
      if (typeof edit.nodeId !== "string" || !object(edit.changes)) return [];
      const dimensions = Object.entries(edit.changes);
      if (!dimensions.length || dimensions.some(([name, value]) => !["width", "height", "radius"].includes(name) || !finite(value) || value <= 0)) return [];
      return nodeBounds(edit.nodeId);
    }
    case "project.patch.apply": {
      if (input.projectId !== document.project.id || edit.op !== "update-node" || !object(edit.changes) ||
          Object.keys(edit.changes).length !== 1 || !Array.isArray(edit.changes.components)) return [];
      const node = document.nodes.find(item => item.id === edit.nodeId && item.type === "text");
      const index = node?.components.findIndex(component => component.kind === "text") ?? -1;
      if (!node || index < 0) return [];
      const candidate = edit.changes.components[index];
      if (!object(candidate) || !object(candidate.data)) return [];
      const expected = structuredClone(node.components);
      for (const dimension of ["width", "height"]) {
        const value = candidate.data[dimension];
        if (value !== undefined) {
          if (!finite(value) || value <= 0 || value > 10_000) return [];
          expected[index].data[dimension] = value;
        }
      }
      if (!isDeepStrictEqual(expected, edit.changes.components)) return [];
      return findings.filter(finding => finding.nodeId === node.id && finding.code === "LAYOUT_TEXT_OVERFLOW");
    }
    case "animation.keyframes.edit": {
      const key = edit.frame;
      if (edit.op !== "update" || typeof key !== "number" || !object(edit.changes) || Object.keys(edit.changes).length !== 1 ||
        !Array.isArray(edit.changes.value) || edit.changes.value.length !== 3 || !edit.changes.value.every(finite)) return [];
      const track = document.animationTracks.find(item => item.id === edit.trackId);
      if (!track || track.enabled === false || track.targetProperty !== "transform.position" || !track.keyframes.some(item => item.frame === key)) return [];
      return nodeBounds(track.targetNodeId).filter(finding => keyAffectsFinding(document, track, key, finding));
    }
    case "timeline.edit": {
      if (edit.op !== "set-caption" || !object(edit.caption)) return [];
      const original = document.sequences[0]?.captions?.find(cue => cue.id === edit.captionId);
      const { startFrame, durationFrames, text } = edit.caption;
      if (!original || text !== original.text || !finite(startFrame) || !Number.isSafeInteger(startFrame) ||
          !finite(durationFrames) || !Number.isSafeInteger(durationFrames) || durationFrames < 1) return [];
      const endFrame = startFrame + durationFrames;
      const originalEnd = original.startFrame + original.durationFrames;
      if (startFrame < original.startFrame || endFrame > originalEnd) return [];
      const removed = [{ startFrame: original.startFrame, endFrame: startFrame }, { startFrame: endFrame, endFrame: originalEnd }]
        .filter(range => range.startFrame < range.endFrame);
      return findings.filter(finding => finding.captionId === original.id && finding.code === "TIMELINE_CAPTION_NARRATION_GAP" &&
        removed.every(range => finding.ranges.some(gap => range.startFrame === gap.startFrame && range.endFrame === gap.endFrame)));
    }
    default: return [];
  }
}
