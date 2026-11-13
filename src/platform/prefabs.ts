import type { Prefab, ProjectDocument, SceneNode } from "../contracts/project";

export interface InstantiatePrefabOptions {
  instanceIdPrefix: string;
  nameSuffix?: string;
  position?: [number, number, number];
}

/**
 * Clones a prefab's node subtree with deterministic IDs and remapped internal
 * parent/child references. The source project is never mutated.
 */
export function instantiatePrefab(
  source: ProjectDocument,
  prefabId: string,
  sceneId: string,
  options: InstantiatePrefabOptions
): { project: ProjectDocument; createdNodeIds: string[] } {
  const prefab = source.prefabs.find((item) => item.id === prefabId);
  if (!prefab) throw new Error(`Prefab not found: ${prefabId}`);
  const scene = source.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(options.instanceIdPrefix)) throw new Error("Invalid instance ID prefix");

  const byId = new Map(source.nodes.map((node) => [node.id, node]));
  const collected = new Set<string>();
  const collect = (id: string): void => {
    if (collected.has(id)) throw new Error(`Prefab hierarchy contains a cycle at ${id}`);
    const node = byId.get(id);
    if (!node) throw new Error(`Prefab references missing node: ${id}`);
    collected.add(id);
    for (const childId of node.childIds ?? []) collect(childId);
  };
  for (const rootId of prefab.rootNodeIds) collect(rootId);

  const idMap = new Map([...collected].map((id) => [id, `${options.instanceIdPrefix}__${id}`]));
  for (const newId of idMap.values()) {
    if (source.nodes.some((node) => node.id === newId)) throw new Error(`Prefab instance node already exists: ${newId}`);
  }

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

  const project = structuredClone(source);
  project.nodes.push(...clones);
  scene.rootNodeIds.push(...prefab.rootNodeIds.map((id) => idMap.get(id)!));
  return { project, createdNodeIds: clones.map((node) => node.id) };
}
