import type { ProjectDocument } from "../contracts/project";
import type { SnapshotInspectionIssue, SnapshotInspectionReport } from "../contracts/inspection";
import { buildProjectRenderModel, type ProjectRenderElement } from "../renderers/remotion/project-render-model";
import type { ProjectSnapshot } from "./project-snapshots";
import { hashProject } from "./project-snapshots";
import { firstSequencePngClips, firstSequenceShots } from "./project-timeline";

export const MAX_INSPECTION_FRAMES = 120;
export const MAX_INSPECTION_ISSUES = 200;
const MAX_PROJECTION_WORK = 250_000;
export class SnapshotInspectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SnapshotInspectionError"; }
}
const reject = (code: string, message: string): never => { throw new SnapshotInspectionError(code, message); };

export function chooseInspectionFrames(project: ProjectDocument, requested?: readonly number[], maxFrames = MAX_INSPECTION_FRAMES) {
  const duration = project.sequences[0]?.durationFrames;
  if (!Number.isSafeInteger(duration) || duration < 1) reject("INSPECT_SEQUENCE_INVALID", "A bounded sequence duration is required");
  if (requested !== undefined) {
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > maxFrames ||
      requested.some((frame) => !Number.isSafeInteger(frame) || frame < 0 || frame >= duration) || new Set(requested).size !== requested.length)
      reject("INSPECT_FRAMES_INVALID", `Supply 1–${maxFrames} unique integer frames inside the first sequence`);
    return { frames: [...requested].sort((a, b) => a - b), omitted: 0 };
  }
  if (duration <= maxFrames) return { frames: Array.from({ length: duration }, (_, i) => i), omitted: 0 };
  const candidates = new Set<number>([0, duration - 1]);
  const add = (frame: number) => { if (Number.isSafeInteger(frame) && frame >= 0 && frame < duration) candidates.add(frame); };
  // Uniform probes complement scene boundaries and animation keys; this does not prove all intermediate frames.
  for (let i = 0; i < 25; i++) add(Math.round((duration - 1) * i / 24));
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const nodeScenes = new Map<string, string>();
  for (const scene of project.scenes) {
    const pending = [...scene.rootNodeIds];
    while (pending.length) {
      const id = pending.pop()!;
      if (nodeScenes.has(id)) continue;
      nodeScenes.set(id, scene.id);
      pending.push(...(byId.get(id)?.childIds ?? []));
    }
  }
  const keysByScene = new Map<string, Set<number>>();
  for (const track of project.animationTracks) if (track.enabled !== false) {
    const scene = nodeScenes.get(track.targetNodeId);
    if (!scene) continue;
    const keys = keysByScene.get(scene) ?? new Set<number>();
    for (const key of track.keyframes) keys.add(key.frame);
    keysByScene.set(scene, keys);
  }
  const shots = firstSequenceShots(project), clips = firstSequencePngClips(project);
  const candidateWork = shots.reduce((sum, shot) => sum + 4 + (keysByScene.get(shot.sceneId)?.size ?? 0) * 3, clips.length * 4);
  if (candidateWork > MAX_PROJECTION_WORK) reject("INSPECT_WORK_LIMIT", "Automatic frame selection exceeds its budget; request explicit frames");
  const addBoundary = (start: number, length: number) => {
    for (const frame of [start - 1, start, start + length - 1, start + length]) add(frame);
  };
  for (const shot of shots) {
    addBoundary(shot.startFrame, shot.durationFrames);
    for (const key of keysByScene.get(shot.sceneId) ?? []) {
      const relative = key - (shot.inFrame ?? 0);
      if (relative < 0 || relative >= shot.durationFrames) continue;
      for (const offset of [-1, 0, 1]) if (relative + offset >= 0 && relative + offset < shot.durationFrames) add(shot.startFrame + relative + offset);
    }
  }
  for (const { clip } of clips) addBoundary(clip.startFrame, clip.durationFrames);
  if (!project.shots?.length && project.sequences[0]?.trackIds === undefined) for (const key of keysByScene.get(project.scenes[0]?.id) ?? []) {
    for (const offset of [-1, 0, 1]) add(key + offset);
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  const frames = sorted.length <= maxFrames ? sorted : Array.from({ length: maxFrames },
    (_, i) => sorted[Math.round(i * (sorted.length - 1) / (maxFrames - 1))]);
  return { frames, omitted: sorted.length - frames.length };
}

/** Bounds of declared shape/chart rectangles after the renderer's composed affine transform. */
function geometryBounds(element: ProjectRenderElement): number[] | undefined {
  if (element.type !== "shape" && element.type !== "chart") return undefined;
  const match = /^matrix\(([^)]+)\)$/.exec(element.transform);
  const matrix = match?.[1].split(",").map(Number);
  if (!matrix || matrix.length !== 6 || !matrix.every(Number.isFinite)) return undefined;
  const [a, b, c, d, tx, ty] = matrix;
  const corners = [[0, 0], [element.width, 0], [0, element.height], [element.width, element.height]]
    .map(([x, y]) => [a * x + c * y + tx, b * x + d * y + ty]);
  if (!corners.flat().every(Number.isFinite)) return undefined;
  return [Math.min(...corners.map(([x]) => x)), Math.min(...corners.map(([, y]) => y)),
    Math.max(...corners.map(([x]) => x)), Math.max(...corners.map(([, y]) => y))];
}

/** The host authorizes and validates the snapshot before calling this pure, bounded inspector. */
export function inspectProjectSnapshot(saved: ProjectSnapshot, requestedFrames?: readonly number[]): SnapshotInspectionReport {
  const project = saved.document;
  if (saved.contentHash !== hashProject(project)) reject("INSPECT_SNAPSHOT_CORRUPT", "Snapshot content hash does not match its document");
  if (saved.projectId !== project.project.id || !project.revisions.at(-1)?.id)
    reject("INSPECT_SNAPSHOT_INVALID", "Snapshot project/revision identity is inconsistent");
  const selection = chooseInspectionFrames(project, requestedFrames);
  const animationWork = project.animationTracks.reduce((sum, track) => sum + 1 + track.keyframes.length, 0);
  if (selection.frames.length * Math.max(1, project.nodes.length) * (1 + animationWork) > MAX_PROJECTION_WORK)
    reject("INSPECT_WORK_LIMIT", "Inspection exceeds the model-work budget; request fewer frames");
  const sequence = project.sequences[0];
  const report: SnapshotInspectionReport = {
    schemaVersion: "1.0.0", inspector: { id: "project-graph.model", version: "1.0.0" },
    snapshotId: saved.id, snapshotHash: saved.contentHash, projectId: saved.projectId, revisionId: project.revisions.at(-1)!.id,
    sequenceId: sequence.id, outcome: "no-issues-detected",
    coverage: { selection: requestedFrames === undefined ? "automatic" : "explicit",
      mode: selection.frames.length === sequence.durationFrames ? "all-frames" : "sampled-frames",
      totalFrames: sequence.durationFrames, checkedFrames: selection.frames, omittedCandidateFrames: selection.omitted,
      checks: ["snapshot-integrity", "scene-selection", "render-model-diagnostics", "shape-chart-declared-bounds"],
      notChecked: ["browser-layout", "text-overflow", "svg-path-extents", "occlusion", "final-pixels", "asset-bytes", "audio", "scientific-accuracy", "presentation-quality",
        ...(selection.frames.length < sequence.durationFrames ? ["unsampled-frames"] : [])] },
    frames: [], issues: [], issuesTruncated: false, omittedIssueOccurrences: 0,
  };
  const issues = new Map<string, SnapshotInspectionIssue>();
  const add = (issue: Omit<SnapshotInspectionIssue, "frames">, frame: number) => {
    const key = JSON.stringify([issue.source, issue.code, issue.nodeId, issue.trackId, issue.sceneId]);
    const previous = issues.get(key);
    if (previous) { if (previous.frames.at(-1) !== frame) previous.frames.push(frame); return; }
    if (issues.size >= MAX_INSPECTION_ISSUES) { report.issuesTruncated = true; report.omittedIssueOccurrences++; return; }
    const item = { ...issue, frames: [frame] }; issues.set(key, item); report.issues.push(item);
  };
  for (const frame of selection.frames) {
    const model = buildProjectRenderModel(project, frame);
    const context = model.sceneId ? { sceneId: model.sceneId } : {};
    for (const issue of model.diagnostics) add({ ...issue, source: "render-model", ...context }, frame);
    const visible = model.elements.filter((element) => element.opacity > 0 && element.width > 0 && element.height > 0);
    report.frames.push({ frame, ...context, projectedElements: model.elements.length, visibleCandidates: visible.length });
    if (project.sequences.length > 1) add({ level: "warning", code: "INSPECT_MULTIPLE_SEQUENCES", source: "render-model",
      message: "The current renderer/inspector only supports the first sequence; multi-sequence selection requires review" }, frame);
    if (model.sceneId && !visible.length) add({ level: "warning", code: "INSPECT_NO_VISIBLE_CANDIDATES", source: "render-model", ...context,
      message: "The selected scene has no projected elements with positive opacity and dimensions" }, frame);
    for (const element of visible) {
      if (element.type !== "shape" && element.type !== "chart") continue;
      const bounds = geometryBounds(element);
      const base = { nodeId: element.id, ...context, source: "declared-geometry" as const };
      if (!bounds) {
        add({ ...base, level: "error", code: "INSPECT_NONFINITE_GEOMETRY", message: "Transformed geometry is not finite" }, frame); continue;
      }
      const [left, top, right, bottom] = bounds;
      if (right - left <= 0.000001 || bottom - top <= 0.000001)
        add({ ...base, level: "warning", code: "INSPECT_DEGENERATE_GEOMETRY", message: "Declared shape/chart bounds collapse after transformation" }, frame);
      else if (right <= 0 || bottom <= 0 || left >= model.width || top >= model.height)
        add({ ...base, level: "warning", code: "INSPECT_NODE_OUTSIDE_FRAME", message: "Declared shape/chart bounds are outside the frame; check whether this is intentional" }, frame);
      else if (left < -0.01 || top < -0.01 || right > model.width + 0.01 || bottom > model.height + 0.01)
        add({ ...base, level: "warning", code: "INSPECT_NODE_CLIPPED", message: "Declared shape/chart bounds cross the frame edge; this may be intentional" }, frame);
    }
  }
  if (report.issues.length || report.issuesTruncated) report.outcome = "issues-found";
  return report;
}
