import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const projectPath = process.argv[2] ?? "projects/cpu-cache/project.json";
const [projectText, schemaText] = await Promise.all([
  readFile(projectPath, "utf8"),
  readFile("schemas/project.schema.json", "utf8"),
]);
const project = JSON.parse(projectText);
const schema = JSON.parse(schemaText);
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

if (!validate(project)) {
  console.error("Project schema validation failed:");
  for (const error of validate.errors ?? []) console.error(`- ${error.instancePath || "/"}: ${error.message}`);
  process.exit(1);
}

const errors = [];
const unique = (items, label) => {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) errors.push(`${label} contains duplicate IDs`);
  return new Set(ids);
};
const sequences = unique(project.sequences, "sequences");
const sequenceMembership = new Map();
const scenes = unique(project.scenes, "scenes");
const nodes = unique(project.nodes, "nodes");
const assets = unique(project.assets, "assets");
const shots = unique(project.shots ?? [], "shots");
const clips = unique(project.clips ?? [], "clips");
const revisions = unique(project.revisions, "revisions");
const prefabs = unique(project.prefabs ?? [], "prefabs");
unique(project.constraints ?? [], "constraints");
unique(project.animationTracks ?? [], "animationTracks");
unique(project.dependencies ?? [], "dependencies");

const rootOwners = new Map();
for (const scene of project.scenes) {
  for (const id of scene.rootNodeIds) {
    if (!nodes.has(id)) errors.push(`scene ${scene.id} references missing root node ${id}`);
    const count = (rootOwners.get(id) ?? 0) + 1;
    rootOwners.set(id, count);
    if (count > 1) errors.push(`node ${id} is a root in more than one scene`);
    const rootNode = project.nodes.find((node) => node.id === id);
    if (rootNode?.parentId) errors.push(`scene root node ${id} must not have a parent`);
  }
}
for (const node of project.nodes) {
  if (node.parentId && !nodes.has(node.parentId)) errors.push(`node ${node.id} references missing parent ${node.parentId}`);
  if (node.parentId) {
    const parent = project.nodes.find((item) => item.id === node.parentId);
    if (parent && !(parent.childIds ?? []).includes(node.id)) errors.push(`parent/child mismatch: ${node.parentId} does not list child ${node.id}`);
  } else if (rootOwners.get(node.id) !== 1) {
    errors.push(`root node ${node.id} must belong to exactly one scene`);
  }
  const childSet = new Set(node.childIds ?? []);
  if (childSet.size !== (node.childIds ?? []).length) errors.push(`node ${node.id} contains duplicate child IDs`);
  for (const id of node.childIds ?? []) {
    if (!nodes.has(id)) errors.push(`node ${node.id} references missing child ${id}`);
    const child = project.nodes.find((item) => item.id === id);
    if (child && child.parentId !== node.id) errors.push(`parent/child mismatch: ${node.id} lists ${id} but child points to ${child.parentId ?? "no parent"}`);
  }
}
for (const shot of project.shots ?? []) {
  if (!scenes.has(shot.sceneId)) errors.push(`shot ${shot.id} references missing scene ${shot.sceneId}`);
}
for (const sequence of project.sequences) {
  const localShots = new Set();
  for (const id of sequence.shotIds) {
    if (!shots.has(id)) errors.push(`sequence ${sequence.id} references missing shot ${id}`);
    if (localShots.has(id)) errors.push(`sequence ${sequence.id} contains duplicate shot ${id}`);
    localShots.add(id);
    const count = (sequenceMembership.get(id) ?? 0) + 1;
    sequenceMembership.set(id, count);
    if (count > 1) errors.push(`shot ${id} belongs to more than one sequence`);
    const shot = project.shots.find((item) => item.id === id);
    if (shot && shot.startFrame + shot.durationFrames > sequence.durationFrames) {
      errors.push(`shot ${id} exceeds sequence ${sequence.id} duration`);
    }
  }
}
for (const shot of project.shots ?? []) {
  if (!sequenceMembership.has(shot.id)) errors.push(`shot ${shot.id} is not assigned to any sequence`);
}
for (const track of project.tracks ?? []) {
  for (const id of track.clipIds) if (!clips.has(id)) errors.push(`track ${track.id} references missing clip ${id}`);
}
for (const clip of project.clips ?? []) {
  if (!assets.has(clip.assetId)) errors.push(`clip ${clip.id} references missing asset ${clip.assetId}`);
  if (!Number.isInteger(clip.startFrame) || clip.startFrame < 0) errors.push(`clip ${clip.id} has invalid start frame`);
  if (!Number.isInteger(clip.durationFrames) || clip.durationFrames < 1) errors.push(`clip ${clip.id} has invalid duration`);
  if (clip.inFrame !== undefined && (!Number.isInteger(clip.inFrame) || clip.inFrame < 0)) errors.push(`clip ${clip.id} has invalid source in-frame`);
}
for (const prefab of project.prefabs ?? []) {
  if (prefab.rootNodeIds.length === 0) errors.push(`prefab ${prefab.id} has no root nodes`);
  const localRoots = new Set();
  for (const id of prefab.rootNodeIds) {
    if (!nodes.has(id)) errors.push(`prefab ${prefab.id} references missing root node ${id}`);
    if (localRoots.has(id)) errors.push(`prefab ${prefab.id} contains duplicate root node ${id}`);
    localRoots.add(id);
  }
}
for (const track of project.animationTracks ?? []) {
  if (!nodes.has(track.targetNodeId)) errors.push(`animation track ${track.id} references missing node ${track.targetNodeId}`);
  const frames = track.keyframes.map((keyframe) => keyframe.frame);
  if (new Set(frames).size !== frames.length) errors.push(`animation track ${track.id} contains duplicate keyframe frames`);
  for (let index = 1; index < frames.length; index++) {
    if (frames[index] <= frames[index - 1]) errors.push(`animation track ${track.id} keyframes must be sorted by ascending frame`);
  }
  for (const frame of frames) {
    if (frame < 0) errors.push(`animation track ${track.id} has a negative frame`);
    const maxDuration = Math.max(...project.sequences.map((sequence) => sequence.durationFrames));
    if (frame > maxDuration) errors.push(`animation track ${track.id} exceeds all sequence durations`);
  }
}
const sceneByNode = new Map();
for (const scene of project.scenes) {
  const pending = [...scene.rootNodeIds];
  const seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    sceneByNode.set(id, scene.id);
    pending.push(...(project.nodes.find((node) => node.id === id)?.childIds ?? []));
  }
}
for (const constraint of project.constraints ?? []) {
  if (!nodes.has(constraint.sourceNodeId)) errors.push(`constraint ${constraint.id} references missing source node ${constraint.sourceNodeId}`);
  if (!nodes.has(constraint.targetNodeId)) errors.push(`constraint ${constraint.id} references missing target node ${constraint.targetNodeId}`);
  if (constraint.sourceNodeId === constraint.targetNodeId && constraint.type !== "custom") errors.push(`constraint ${constraint.id} cannot target its own source node`);
  if (constraint.enabled && sceneByNode.has(constraint.sourceNodeId) && sceneByNode.has(constraint.targetNodeId) && sceneByNode.get(constraint.sourceNodeId) !== sceneByNode.get(constraint.targetNodeId)) {
    errors.push(`constraint ${constraint.id} crosses scene boundaries`);
  }
  if (constraint.type === "distance" && (typeof constraint.parameters.distance !== "number" || !Number.isFinite(constraint.parameters.distance) || constraint.parameters.distance < 0)) {
    errors.push(`constraint ${constraint.id} requires a non-negative distance`);
  }
  if (constraint.type === "follow-path" && (typeof constraint.parameters.pathNodeId !== "string" || !nodes.has(constraint.parameters.pathNodeId))) {
    errors.push(`constraint ${constraint.id} requires an existing pathNodeId`);
  }
}
const entityExists = (type, id) => ({ node: nodes, scene: scenes, shot: shots, asset: assets, prefab: prefabs, clip: clips }[type]?.has(id) ?? false);
for (const dependency of project.dependencies ?? []) {
  if (!entityExists(dependency.fromType, dependency.fromId)) errors.push(`dependency ${dependency.id} references missing source ${dependency.fromType}:${dependency.fromId}`);
  if (!entityExists(dependency.toType, dependency.toId)) errors.push(`dependency ${dependency.id} references missing target ${dependency.toType}:${dependency.toId}`);
  if (dependency.fromType === dependency.toType && dependency.fromId === dependency.toId) errors.push(`dependency ${dependency.id} cannot reference itself`);
}
for (const revision of project.revisions) {
  if (revision.parentRevisionId && !revisions.has(revision.parentRevisionId)) errors.push(`revision ${revision.id} references missing parent revision`);
}

// Validate node hierarchy for cycles and reciprocal parent/child consistency.
const visiting = new Set();
const visited = new Set();
const byId = new Map(project.nodes.map((node) => [node.id, node]));
function visit(id) {
  if (visiting.has(id)) {
    errors.push(`node hierarchy contains a cycle at ${id}`);
    return;
  }
  if (visited.has(id)) return;
  visiting.add(id);
  const node = byId.get(id);
  for (const childId of node?.childIds ?? []) {
    const child = byId.get(childId);
    if (child && child.parentId !== id) errors.push(`parent/child mismatch: ${id} -> ${childId}`);
    visit(childId);
  }
  visiting.delete(id);
  visited.add(id);
}
for (const node of project.nodes) if (!node.parentId) visit(node.id);
for (const node of project.nodes) if (!visited.has(node.id)) visit(node.id);

if (errors.length) {
  console.error("Project semantic validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Valid project: ${project.project.id}`);
console.log(`Sequences: ${project.sequences.length}; scenes: ${project.scenes.length}; nodes: ${project.nodes.length}; assets: ${project.assets.length}`);
console.log("Schema, references, and scene hierarchy validation passed.");
