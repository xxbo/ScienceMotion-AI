import type { ProjectAnimationTrack, ProjectDocument, Scene, SceneConstraint, SceneNode } from "../contracts/project";
import { sampleAnimationTrack, validateAnimationTrack } from "./animation";
import { compileMotionPath, type MotionPath, type Point2D } from "./motion-path";
import { ProjectEditError } from "./project-edit-error";

export interface FollowPathBinding {
  constraintId: string;
  guide: SceneNode;
  anchor: Point2D;
  progressTrack: ProjectAnimationTrack;
  path: MotionPath;
}
export interface PreparedFollowPaths {
  byNode: ReadonlyMap<string, FollowPathBinding>;
  issues: Array<{ constraintId: string; nodeId: string; guideNodeId: string; code: string; message: string; frame?: number; durationFrames?: number }>;
}
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const point = (value: unknown): value is Point2D =>
  Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);

/** The progress block opts a previously reserved follow-path constraint into 2D motion. */
export function isActiveFollowPath(constraint: SceneConstraint): boolean {
  return constraint.type === "follow-path" && constraint.enabled &&
    plainRecord(constraint.parameters) && Object.hasOwn(constraint.parameters, "progress");
}

export function prepareFollowPaths(project: ProjectDocument): PreparedFollowPaths {
  const byNode = new Map<string, FollowPathBinding>(), issues: PreparedFollowPaths["issues"] = [];
  const active = (project.constraints ?? []).filter(isActiveFollowPath);
  if (!active.length) return { byNode, issues };

  const nodes = new Map(project.nodes.map(node => [node.id, node]));
  const owningScene = new Map<string, Scene>();
  for (const scene of project.scenes) {
    const pending = [...scene.rootNodeIds];
    while (pending.length) {
      const id = pending.pop()!;
      if (owningScene.has(id)) continue;
      owningScene.set(id, scene);
      for (const child of nodes.get(id)?.childIds ?? []) pending.push(child);
    }
  }
  const counts = new Map<string, number>();
  for (const { sourceNodeId } of active) counts.set(sourceNodeId, (counts.get(sourceNodeId) ?? 0) + 1);
  const competing = new Set(project.animationTracks.filter(track => track.enabled !== false &&
    track.targetProperty === "transform.position").map(track => track.targetNodeId));
  const paths = new Map<unknown, MotionPath>();
  for (const constraint of active) {
    const { id, sourceNodeId, targetNodeId, parameters, engine } = constraint;
    const invalid = (message: string, code = "FOLLOW_PATH_BINDING_INVALID", details: { frame?: number; durationFrames?: number } = {}) =>
      new ProjectEditError(code, message, details);
    try {
      if (engine !== undefined || project.project.coordinateSystem !== "screen-y-down")
        throw invalid("2D path following needs a renderer-neutral constraint in screen-y-down coordinates");
      const source = nodes.get(sourceNodeId), guide = nodes.get(targetNodeId);
      if (!source) throw invalid("The follower node does not exist. Choose a node in the guide's scene and parent.");
      if (!guide || source === guide || guide.type !== "path" || parameters.pathNodeId !== targetNodeId)
        throw invalid("Choose a separate SVG path node. The binding's pathNodeId must match its target path node.", "FOLLOW_PATH_GUIDE_INVALID");
      const scene = owningScene.get(sourceNodeId);
      if (!scene || scene !== owningScene.get(targetNodeId) || source.parentId !== guide.parentId)
        throw invalid("Path follower and guide must share one scene and immediate parent");
      if (counts.get(sourceNodeId) !== 1 || competing.has(sourceNodeId))
        throw invalid("Path following cannot share a node with another enabled position driver. Edit the existing binding or choose another follower.");
      if (counts.has(targetNodeId)) throw invalid("A path guide cannot itself follow a path. Choose a guide without a path binding of its own.");
      if (Object.keys(parameters).some(key => !["pathNodeId", "progress", "anchor"].includes(key)))
        throw invalid("Unexpected path-following parameter");
      const anchor = parameters.anchor === undefined ? [0, 0] as Point2D : parameters.anchor;
      if (!point(anchor)) throw invalid("Path anchor must be a finite [x, y] point");
      const { progress } = parameters;
      if (!plainRecord(progress) || Object.keys(progress).some(key => !["keyframes", "loop"].includes(key)) ||
          !Array.isArray(progress.keyframes) || (progress.loop !== undefined && typeof progress.loop !== "boolean"))
        throw invalid("Path progress requires a keyframe track and optional boolean loop", "FOLLOW_PATH_TIMING_INVALID");
      const progressTrack: ProjectAnimationTrack = {
        id, targetNodeId: sourceNodeId, targetProperty: "followPath.progress", keyframes: progress.keyframes, loop: progress.loop,
      };
      const errors = validateAnimationTrack(progressTrack);
      if (errors.length) throw invalid(errors[0], "FOLLOW_PATH_TIMING_INVALID");
      const outsideProgress = progressTrack.keyframes.find(key => typeof key.value !== "number" || !Number.isFinite(key.value) || key.value < 0 || key.value > 1);
      if (outsideProgress) throw invalid("Path progress keys must be numbers in [0, 1]", "FOLLOW_PATH_TIMING_INVALID", { frame: outsideProgress.frame });
      const outsideScene = progressTrack.keyframes.find(key => key.frame > scene.durationFrames);
      if (outsideScene) throw invalid("Path progress exceeds the scene duration", "FOLLOW_PATH_TIMING_INVALID", { frame: outsideScene.frame, durationFrames: scene.durationFrames });
      const data = guide.components.find(component => component.kind === "geometry")?.data?.pathData;
      let path = paths.get(data);
      if (!path) {
        try { path = compileMotionPath(data); }
        catch (error) { throw invalid(error instanceof Error ? error.message : String(error), "FOLLOW_PATH_GUIDE_INVALID"); }
        paths.set(data, path);
      }
      byNode.set(sourceNodeId, { constraintId: id, guide, anchor: [...anchor], progressTrack, path });
    } catch (error) {
      issues.push({ constraintId: id, nodeId: sourceNodeId, guideNodeId: targetNodeId,
        code: error instanceof ProjectEditError ? error.code : "FOLLOW_PATH_BINDING_INVALID",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ProjectEditError ? error.details : {}),
      });
    }
  }
  return { byNode, issues };
}

export function assertValidFollowPaths(project: ProjectDocument, editedConstraintIds?: ReadonlySet<string>): void {
  const { issues } = prepareFollowPaths(project);
  const issue = issues.find(item => editedConstraintIds?.has(item.constraintId)) ?? issues[0];
  if (issue) {
    const { code, message, nodeId, ...details } = issue;
    throw new ProjectEditError(code, `Follow-path ${issue.constraintId} on ${nodeId}. ${message}`, { ...details, followerNodeId: nodeId });
  }
}

export function sampleFollowPath(binding: FollowPathBinding, sceneFrame: number): Point2D {
  const sample = sampleAnimationTrack(binding.progressTrack, sceneFrame);
  if (!sample || typeof sample.value !== "number") throw new Error("Path progress did not sample a number");
  // CSS easing may overshoot. A bounded motion path stops at its endpoints.
  return binding.path.pointAt(Math.max(0, Math.min(1, sample.value)));
}
