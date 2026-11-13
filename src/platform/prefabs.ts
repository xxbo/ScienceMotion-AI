import type { ProjectDocument, SceneNode } from "../contracts/project";

export interface InstantiatePrefabOptions {
  instanceIdPrefix: string;
  nameSuffix?: string;
  position?: [number, number, number];
}

export interface PrefabInstantiationResult {
  project: ProjectDocument;
  createdNodeIds: string[];
  createdConstraintIds: string[];
  createdDependencyIds: string[];
  createdAnimationTrackIds: string[];
}

/**
 * Clones a prefab subtree, remapping node references in hierarchy,
 * constraints, and internal node-to-node dependency edges.
 * The source project is never mutated.
 */
export function instantiatePrefab(
  source: ProjectDocument,
  prefabId: string,
  sceneId: string,
  options: InstantiatePrefabOptions
): PrefabInstantiationResult {
  const prefab = source.prefabs.find((item) => item.id === prefabId);
  if (!prefab) throw new Error(`Prefab not found: ${prefabId}`);
  if (!source.scenes.some((item) => item.id === sceneId)) throw new Error(`Scene not found: ${sceneId}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(options.instanceIdPrefix)) throw new Error("Invalid instance ID prefix");
  if (prefab.rootNodeIds.length === 0) throw new Error("Prefab must contain at least one root node");

  const byId = new Map(source.nodes.map((node) => [node.id, node]));
  const collected = new Set<string>();
  const active = new Set<string>();
  const collect = (id: string): void => {
    if (active.has(id)) throw new Error(`Prefab hierarchy contains a cycle at ${id}`);
    if (collected.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error(`Prefab references missing node: ${id}`);
    active.add(id);
    collected.add(id);
    for (const childId of node.childIds ?? []) collect(childId);
    active.delete(id);
  };
  for (const rootId of prefab.rootNodeIds) {
    const root = byId.get(rootId);
    if (!root) throw new Error(`Prefab references missing root node: ${rootId}`);
    if (root.parentId && prefab.rootNodeIds.includes(root.parentId)) {
      throw new Error("Prefab root nodes cannot be children of another prefab root");
    }
    collect(rootId);
  }

  const idMap = new Map([...collected].map((id) => [id, `${options.instanceIdPrefix}__${id}`]));
  const generatedIds = [
    ...[...idMap.values()],
    ...source.constraints.filter((item) => collected.has(item.sourceNodeId) && collected.has(item.targetNodeId)).map((item) => `${options.instanceIdPrefix}__${item.id}`),
    ...source.dependencies.filter((item) => item.fromType === "node" && item.toType === "node" && collected.has(item.fromId) && collected.has(item.toId)).map((item) => `${options.instanceIdPrefix}__${item.id}`),
    ...source.animationTracks.filter((item) => collected.has(item.targetNodeId)).map((item) => `${options.instanceIdPrefix}__${item.id}`),
  ];
  if (new Set(generatedIds).size !== generatedIds.length) throw new Error("Prefab contains colliding generated IDs");
  const existingIds = new Set([
    ...source.nodes.map((item) => item.id),
    ...source.constraints.map((item) => item.id),
    ...source.dependencies.map((item) => item.id),
    ...source.animationTracks.map((item) => item.id),
  ]);
  for (const id of generatedIds) if (existingIds.has(id)) throw new Error(`Prefab instance ID already exists: ${id}`);

  const clones: SceneNode[] = [...collected].map((oldId) => {
    const original = byId.get(oldId)!;
    const clone = structuredClone(original);
    clone.id = idMap.get(oldId)!;
    clone.name = options.nameSuffix ? `${clone.name} ${options.nameSuffix}` : clone.name;
    clone.prefabId = prefab.id;
    clone.parentId = original.parentId && idMap.has(original.parentId) ? idMap.get(original.parentId) : undefined;
    clone.childIds = (original.childIds ?? []).map((id) => idMap.get(id)!).filter(Boolean);
    if (!original.parentId && options.position) {
      clone.transform.position = [
        clone.transform.position[0] + options.position[0],
        clone.transform.position[1] + options.position[1],
        clone.transform.position[2] + options.position[2],
      ];
    }
    return clone;
  });

  const clonedConstraints = source.constraints
    .filter((item) => collected.has(item.sourceNodeId) && collected.has(item.targetNodeId))
    .map((item) => ({
      ...structuredClone(item),
      id: `${options.instanceIdPrefix}__${item.id}`,
      sourceNodeId: idMap.get(item.sourceNodeId)!,
      targetNodeId: idMap.get(item.targetNodeId)!,
    }));

  const clonedDependencies = source.dependencies
    .filter((item) => item.fromType === "node" && item.toType === "node" && collected.has(item.fromId) && collected.has(item.toId))
    .map((item) => ({
      ...structuredClone(item),
      id: `${options.instanceIdPrefix}__${item.id}`,
      fromId: idMap.get(item.fromId)!,
      toId: idMap.get(item.toId)!,
    }));

  const clonedAnimationTracks = source.animationTracks
    .filter((item) => collected.has(item.targetNodeId))
    .map((item) => ({
      ...structuredClone(item),
      id: `${options.instanceIdPrefix}__${item.id}`,
      targetNodeId: idMap.get(item.targetNodeId)!,
    }));

  const project = structuredClone(source);
  project.nodes.push(...clones);
  project.animationTracks.push(...clonedAnimationTracks);
  project.constraints.push(...clonedConstraints);
  project.dependencies.push(...clonedDependencies);
  project.scenes.find((item) => item.id === sceneId)!.rootNodeIds.push(...prefab.rootNodeIds.map((id) => idMap.get(id)!));

  return {
    project,
    createdNodeIds: clones.map((node) => node.id),
    createdConstraintIds: clonedConstraints.map((item) => item.id),
    createdDependencyIds: clonedDependencies.map((item) => item.id),
    createdAnimationTrackIds: clonedAnimationTracks.map((item) => item.id),
  };
}
