import type { ProjectAnimationTrack, ProjectDocument, Scene, SceneNode } from "../contracts/project";
import { sampleAnimationTrack, validateAnimationTrack } from "./animation";
import { compileMotionPath, type MotionPath, type Point2D } from "./motion-path";

export interface FollowPathBinding {
  constraintId: string;
  guide: SceneNode;
  anchor: Point2D;
  progressTrack: ProjectAnimationTrack;
  path: MotionPath;
}
export interface PreparedFollowPaths {
  byNode: ReadonlyMap<string, FollowPathBinding>;
  issues: Array<{ constraintId: string; nodeId: string; message: string }>;
}
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const point = (value: unknown): value is Point2D =>
  Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);

/** The progress block opts a previously reserved follow-path constraint into 2D motion. */
export function prepareFollowPaths(project: ProjectDocument): PreparedFollowPaths {
  const byNode = new Map<string, FollowPathBinding>(), issues: PreparedFollowPaths["issues"] = [];
  const active = (project.constraints ?? []).filter(constraint => constraint.type === "follow-path" && constraint.enabled &&
    plainRecord(constraint.parameters) && Object.hasOwn(constraint.parameters, "progress"));
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
    try {
      if (engine !== undefined || project.project.coordinateSystem !== "screen-y-down")
        throw new Error("2D path following needs a renderer-neutral constraint in screen-y-down coordinates");
      const source = nodes.get(sourceNodeId), guide = nodes.get(targetNodeId);
      if (!source || !guide || source === guide || guide.type !== "path" || parameters.pathNodeId !== targetNodeId)
        throw new Error("Path following requires pathNodeId to match its target path node");
      const scene = owningScene.get(sourceNodeId);
      if (!scene || scene !== owningScene.get(targetNodeId) || source.parentId !== guide.parentId)
        throw new Error("Path follower and guide must share one scene and immediate parent");
      if (counts.get(sourceNodeId) !== 1 || competing.has(sourceNodeId))
        throw new Error("Path following cannot share a node with another enabled position driver");
      if (counts.has(targetNodeId)) throw new Error("A path guide cannot itself follow a path");
      if (Object.keys(parameters).some(key => !["pathNodeId", "progress", "anchor"].includes(key)))
        throw new Error("Unexpected path-following parameter");
      const anchor = parameters.anchor === undefined ? [0, 0] as Point2D : parameters.anchor;
      if (!point(anchor)) throw new Error("Path anchor must be a finite [x, y] point");
      const { progress } = parameters;
      if (!plainRecord(progress) || Object.keys(progress).some(key => !["keyframes", "loop"].includes(key)) ||
          !Array.isArray(progress.keyframes) || (progress.loop !== undefined && typeof progress.loop !== "boolean"))
        throw new Error("Path progress requires a keyframe track and optional boolean loop");
      const progressTrack: ProjectAnimationTrack = {
        id, targetNodeId: sourceNodeId, targetProperty: "followPath.progress", keyframes: progress.keyframes, loop: progress.loop,
      };
      const errors = validateAnimationTrack(progressTrack);
      if (errors.length) throw new Error(errors.join(". "));
      if (progressTrack.keyframes.some(key => typeof key.value !== "number" || !Number.isFinite(key.value) || key.value < 0 || key.value > 1))
        throw new Error("Path progress keys must be numbers in [0, 1]");
      if (progressTrack.keyframes.at(-1)!.frame > scene.durationFrames) throw new Error("Path progress exceeds the scene duration");
      const data = guide.components.find(component => component.kind === "geometry")?.data?.pathData;
      const path = paths.get(data) ?? compileMotionPath(data);
      paths.set(data, path);
      byNode.set(sourceNodeId, { constraintId: id, guide, anchor: [...anchor], progressTrack, path });
    } catch (error) {
      issues.push({ constraintId: id, nodeId: sourceNodeId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { byNode, issues };
}

export function assertValidFollowPaths(project: ProjectDocument): void {
  const issue = prepareFollowPaths(project).issues[0];
  if (issue) throw new Error(`Follow-path ${issue.constraintId} on ${issue.nodeId}. ${issue.message}`);
}

export function sampleFollowPath(binding: FollowPathBinding, sceneFrame: number): Point2D {
  const sample = sampleAnimationTrack(binding.progressTrack, sceneFrame);
  if (!sample || typeof sample.value !== "number") throw new Error("Path progress did not sample a number");
  // CSS easing may overshoot. A bounded motion path stops at its endpoints.
  return binding.path.pointAt(Math.max(0, Math.min(1, sample.value)));
}
