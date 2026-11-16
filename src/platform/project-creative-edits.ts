import type { CreativePatchOperation, ProjectPatchOperation } from "../contracts/project-patch";
import type { ProjectDocument } from "../contracts/project";
import { validateAnimationTrack } from "./animation";
import { assertAssetReferences, assertProjectAsset } from "./project-assets";

export const creativeOperations = new Set([
  "add-scene", "update-scene", "remove-scene", "add-shot", "update-shot", "remove-shot", "put-animation-track", "remove-animation-track",
]);
export const isCreativeOperation = (op: ProjectPatchOperation): op is CreativePatchOperation => creativeOperations.has(op.op);
export interface CreativeChanges { scenes: Set<string>; shots: Set<string>; animations: Set<string> }
const nonempty = (value: unknown, label: string): void => { if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Invalid ${label}`); };
const integer = (value: number, label: string, min = 1): void => { if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${label}`); };
function onlyKeys(value: object, allowed: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported operation/change fields");
}
export function assertFiniteJson(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || active.has(value) ||
      (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new Error("Creative edits require finite JSON data");
  active.add(value);
  for (const child of Array.isArray(value) ? Array.from(value) : Object.values(value)) assertFiniteJson(child, active);
  active.delete(value);
}
function dependencyUses(project: ProjectDocument, type: "scene" | "shot", id: string): boolean {
  return project.dependencies.some((d) => (d.fromType === type && d.fromId === id) || (d.toType === type && d.toId === id));
}
/** Mutates only applyProjectPatch's private working copy. Final validation precedes its revision append. */
export function applyCreativeOperation(project: ProjectDocument, op: CreativePatchOperation, changed: CreativeChanges): void {
  switch (op.op) {
    case "add-scene":
      onlyKeys(op, ["op", "scene"]);
      if (project.scenes.some((s) => s.id === op.scene.id)) throw new Error(`Scene already exists: ${op.scene.id}`);
      if (!Array.isArray(op.scene.rootNodeIds) || op.scene.rootNodeIds.length) throw new Error("New scenes must be empty; add nodes explicitly");
      project.scenes.push(structuredClone(op.scene)); changed.scenes.add(op.scene.id); break;
    case "update-scene": {
      onlyKeys(op, ["op", "sceneId", "changes"]); onlyKeys(op.changes, ["name", "durationFrames", "metadata"]);
      const scene = project.scenes.find((s) => s.id === op.sceneId);
      if (!scene) throw new Error(`Scene not found: ${op.sceneId}`);
      Object.assign(scene, structuredClone(op.changes)); changed.scenes.add(scene.id); break;
    }
    case "remove-scene": {
      onlyKeys(op, ["op", "sceneId"]);
      const index = project.scenes.findIndex((s) => s.id === op.sceneId);
      if (index < 0) throw new Error(`Scene not found: ${op.sceneId}`);
      if (project.scenes[index].rootNodeIds.length || (project.shots ?? []).some((s) => s.sceneId === op.sceneId) || dependencyUses(project, "scene", op.sceneId)) throw new Error("Scene is in use; remove consumers explicitly");
      project.scenes.splice(index, 1); changed.scenes.add(op.sceneId); break;
    }
    case "add-shot": {
      onlyKeys(op, ["op", "sequenceId", "shot"]);
      const sequence = project.sequences.find((s) => s.id === op.sequenceId);
      if (!sequence) throw new Error(`Sequence not found: ${op.sequenceId}`);
      if ((project.shots ?? []).some((s) => s.id === op.shot.id)) throw new Error(`Shot already exists: ${op.shot.id}`);
      (project.shots ??= []).push(structuredClone(op.shot)); sequence.shotIds.push(op.shot.id); changed.shots.add(op.shot.id); break;
    }
    case "update-shot": {
      onlyKeys(op, ["op", "shotId", "changes"]); onlyKeys(op.changes, ["name", "sceneId", "startFrame", "durationFrames", "transitionIn", "transitionOut"]);
      const shot = (project.shots ?? []).find((s) => s.id === op.shotId);
      if (!shot) throw new Error(`Shot not found: ${op.shotId}`);
      Object.assign(shot, structuredClone(op.changes)); changed.shots.add(shot.id); break;
    }
    case "remove-shot": {
      onlyKeys(op, ["op", "shotId"]);
      if (!(project.shots ?? []).some((s) => s.id === op.shotId)) throw new Error(`Shot not found: ${op.shotId}`);
      if (dependencyUses(project, "shot", op.shotId)) throw new Error("Shot is in use; remove dependencies explicitly");
      project.shots = project.shots!.filter((s) => s.id !== op.shotId);
      for (const sequence of project.sequences) sequence.shotIds = sequence.shotIds.filter((id) => id !== op.shotId);
      changed.shots.add(op.shotId); break;
    }
    case "put-animation-track": {
      onlyKeys(op, ["op", "track"]);
      const errors = validateAnimationTrack(op.track);
      if (errors.length) throw new Error(errors.join("; "));
      const index = project.animationTracks.findIndex((t) => t.id === op.track.id);
      if (index < 0) project.animationTracks.push(structuredClone(op.track)); else project.animationTracks[index] = structuredClone(op.track);
      changed.animations.add(op.track.id); break;
    }
    case "remove-animation-track": {
      onlyKeys(op, ["op", "trackId"]);
      const index = project.animationTracks.findIndex((t) => t.id === op.trackId);
      if (index < 0) throw new Error(`Animation track not found: ${op.trackId}`);
      project.animationTracks.splice(index, 1); changed.animations.add(op.trackId); break;
    }
  }
}
/** Semantic gate for the 1.3 editing path. Renderer-specific component support remains adapter-owned. */
export function assertCreativeDocument(project: ProjectDocument): void {
  if (project.schemaVersion !== "1.1.0") throw new Error("Unsupported creative project format");
  nonempty(project.project.id, "project ID"); integer(project.project.timebase.fps, "project FPS");
  const unique = <T extends { id: string }>(items: T[], label: string): Map<string, T> => {
    if (!Array.isArray(items)) throw new Error(`Invalid ${label} collection`);
    const map = new Map<string, T>();
    for (const item of items) { nonempty(item?.id, `${label} ID`); if (map.has(item.id)) throw new Error(`Duplicate ${label} ID: ${item.id}`); map.set(item.id, item); }
    return map;
  };
  const scenes = unique(project.scenes, "scene"), nodes = unique(project.nodes, "node"), shots = unique(project.shots ?? [], "shot");
  const sequences = unique(project.sequences, "sequence"), tracks = unique(project.animationTracks, "animation"), assets = unique(project.assets, "asset");
  const prefabs = unique(project.prefabs, "prefab"), clips = unique(project.clips ?? [], "clip");
  unique(project.constraints, "constraint"); unique(project.dependencies, "dependency"); unique(project.tracks ?? [], "track");
  if (!sequences.size) throw new Error("At least one sequence is required");
  const sceneOf = new Map<string, string>();
  for (const scene of scenes.values()) {
    onlyKeys(scene, ["id", "name", "durationFrames", "rootNodeIds", "metadata"]);
    nonempty(scene.name, "scene name"); integer(scene.durationFrames, "scene duration");
    if (!Array.isArray(scene.rootNodeIds)) throw new Error("Scene rootNodeIds must be an array");
    if (scene.metadata !== undefined && (!scene.metadata || typeof scene.metadata !== "object" || Array.isArray(scene.metadata))) throw new Error("Invalid scene metadata");
    const visit = (id: string, parentId?: string): void => {
      const node = nodes.get(id);
      if (!node || node.parentId !== parentId || sceneOf.has(id)) throw new Error(`Invalid hierarchy or scene ownership at ${id}`);
      sceneOf.set(id, scene.id);
      if (node.childIds !== undefined && !Array.isArray(node.childIds)) throw new Error("Node childIds must be an array");
      for (const child of node.childIds ?? []) visit(child, id);
    };
    for (const root of scene.rootNodeIds) visit(root);
  }
  if (sceneOf.size !== nodes.size) throw new Error("Every node must belong to exactly one scene");
  for (const node of nodes.values()) {
    nonempty(node.name, "node name");
    if (!["group", "text", "shape", "path", "mesh", "image", "video", "camera", "light", "emitter", "simulation", "custom"].includes(node.type)) throw new Error("Invalid node type");
    if (node.prefabId && !prefabs.has(node.prefabId)) throw new Error("Node references a missing prefab");
    for (const key of ["position", "rotation", "scale", "pivot"] as const) {
      const v = node.transform?.[key]; if (key === "pivot" && v === undefined) continue;
      if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`Invalid node transform ${node.id}:${key}`);
    }
    if (!Array.isArray(node.components)) throw new Error("Node components must be an array");
    for (const component of node.components) {
      if (!component || typeof component.kind !== "string" || !component.data || typeof component.data !== "object" || Array.isArray(component.data)) throw new Error("Invalid node component");
      assertFiniteJson(component.data);
    }
  }
  const memberships = new Set<string>();
  for (const seq of sequences.values()) {
    nonempty(seq.name, "sequence name"); integer(seq.durationFrames, "sequence duration"); integer(seq.width, "sequence width"); integer(seq.height, "sequence height");
    if (seq.fps !== project.project.timebase.fps) throw new Error("Creative editing requires a common project/sequence FPS");
    for (const id of seq.shotIds) {
      const shot = shots.get(id); if (!shot || memberships.has(id)) throw new Error(`Invalid shot membership: ${id}`);
      memberships.add(id); onlyKeys(shot, ["id", "name", "sceneId", "startFrame", "durationFrames", "transitionIn", "transitionOut"]); nonempty(shot.name, "shot name"); integer(shot.startFrame, "shot start", 0); integer(shot.durationFrames, "shot duration");
      for (const value of [shot.transitionIn, shot.transitionOut]) if (value !== undefined && typeof value !== "string") throw new Error("Invalid shot transition");
      const scene = scenes.get(shot.sceneId);
      if (!scene || shot.durationFrames > scene.durationFrames || shot.startFrame + shot.durationFrames > seq.durationFrames) throw new Error(`Shot exceeds scene/sequence bounds: ${id}`);
    }
  }
  if (memberships.size !== shots.size) throw new Error("Every shot must belong to exactly one sequence");
  const targets = new Set<string>();
  for (const track of tracks.values()) {
    onlyKeys(track, ["id", "targetNodeId", "targetProperty", "keyframes", "loop", "enabled"]);
    const errors = validateAnimationTrack(track); if (errors.length) throw new Error(errors.join("; "));
    const sceneId = sceneOf.get(track.targetNodeId); if (!sceneId) throw new Error(`Animation target not found: ${track.targetNodeId}`);
    if (track.keyframes.at(-1)!.frame > scenes.get(sceneId)!.durationFrames) throw new Error(`Animation exceeds scene duration: ${track.id}`);
    const target = JSON.stringify([track.targetNodeId, track.targetProperty]);
    if (track.enabled !== false && targets.has(target)) throw new Error("Multiple enabled tracks target the same property");
    if (track.enabled !== false) targets.add(target);
    if (["transform.position", "transform.rotation", "transform.scale", "transform.pivot"].includes(track.targetProperty) && track.keyframes.some((k) => !Array.isArray(k.value) || k.value.length !== 3 || !k.value.every(Number.isFinite))) throw new Error("Transform keyframes require three numeric values");
    if (track.targetProperty === "opacity" && track.keyframes.some((k) => typeof k.value !== "number" || k.value < 0 || k.value > 1)) throw new Error("Opacity keyframes must be in [0, 1]");
  }
  for (const prefab of prefabs.values()) {
    if (!prefab.rootNodeIds.length || new Set(prefab.rootNodeIds).size !== prefab.rootNodeIds.length) throw new Error("Invalid prefab roots");
    for (const id of prefab.rootNodeIds) if (!nodes.has(id)) throw new Error("Missing prefab root");
  }
  for (const constraint of project.constraints) {
    const a = sceneOf.get(constraint.sourceNodeId), b = sceneOf.get(constraint.targetNodeId);
    if (!a || !b || (constraint.enabled && a !== b)) throw new Error("Invalid constraint scene references");
  }
  const entities = { node: nodes, scene: scenes, shot: shots, asset: assets, prefab: prefabs, clip: clips };
  for (const d of project.dependencies) if (!entities[d.fromType]?.has(d.fromId) || !entities[d.toType]?.has(d.toId)) throw new Error("Dangling project dependency");
  for (const asset of project.assets) assertProjectAsset(asset);
  assertAssetReferences(project);
}
