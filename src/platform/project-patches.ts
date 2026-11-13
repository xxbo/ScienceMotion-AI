import type { ProjectDocument, SceneNode } from "../contracts/project";
import type { ProjectPatchDocument, ProjectPatchResult } from "../contracts/project-patch";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertUniqueNodeIds(nodes: SceneNode[]): void {
  const ids = nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) throw new Error("Patch would create duplicate node IDs");
}

function assertNoHierarchyCycles(nodes: SceneNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Patch would create a hierarchy cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const childId of byId.get(id)?.childIds ?? []) visit(childId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) if (!node.parentId) visit(node.id);
  for (const node of nodes) if (!visited.has(node.id)) visit(node.id);
}

function detachFromParent(nodes: SceneNode[], node: SceneNode): void {
  if (!node.parentId) return;
  const parent = nodes.find((item) => item.id === node.parentId);
  if (parent) parent.childIds = (parent.childIds ?? []).filter((id) => id !== node.id);
}

export function applyProjectPatch(
  source: ProjectDocument,
  patch: ProjectPatchDocument,
  options: { currentRevisionId: string; newRevisionId: string; createdAt: string; message: string }
): ProjectPatchResult {
  if (patch.schemaVersion !== source.schemaVersion) throw new Error("Patch schema version does not match project schema");
  if (patch.projectId !== source.project.id) throw new Error("Patch targets a different project");
  if (patch.baseRevisionId !== options.currentRevisionId) throw new Error("Revision conflict: project has changed since patch was created");

  const project = clone(source);
  const changed = new Set<string>();

  for (const operation of patch.patches) {
    if (operation.op === "add-node") {
      if (project.nodes.some((node) => node.id === operation.node.id)) throw new Error(`Node already exists: ${operation.node.id}`);
      const scene = project.scenes.find((item) => item.id === operation.sceneId);
      if (!scene) throw new Error(`Scene not found: ${operation.sceneId}`);
      if (operation.node.parentId && !project.nodes.some((node) => node.id === operation.node.parentId)) throw new Error("Parent node not found");
      project.nodes.push(clone(operation.node));
      if (operation.node.parentId) {
        const parent = project.nodes.find((node) => node.id === operation.node.parentId)!;
        parent.childIds = [...(parent.childIds ?? []), operation.node.id];
        changed.add(parent.id);
      } else {
        scene.rootNodeIds.push(operation.node.id);
      }
      changed.add(operation.node.id);
    } else if (operation.op === "update-node") {
      const node = project.nodes.find((item) => item.id === operation.nodeId);
      if (!node) throw new Error(`Node not found: ${operation.nodeId}`);
      if (operation.changes.id && operation.changes.id !== node.id) throw new Error("Node IDs are immutable");
      if (operation.changes.parentId !== undefined || operation.changes.childIds !== undefined) throw new Error("Use reparent-node to change hierarchy");
      Object.assign(node, clone(operation.changes));
      changed.add(node.id);
    } else if (operation.op === "remove-node") {
      const node = project.nodes.find((item) => item.id === operation.nodeId);
      if (!node) throw new Error(`Node not found: ${operation.nodeId}`);
      const descendants = (id: string, visited = new Set<string>()): string[] => {
        if (visited.has(id)) throw new Error(`Cannot remove from cyclic hierarchy at ${id}`);
        visited.add(id);
        const current = project.nodes.find((item) => item.id === id);
        return (current?.childIds ?? []).flatMap((childId) => [childId, ...descendants(childId, visited)]);
      };
      const children = descendants(node.id);
      if (children.length && !operation.recursive) throw new Error("Node has children; recursive removal must be explicit");
      const removeIds = new Set([node.id, ...children]);
      detachFromParent(project.nodes, node);
      for (const scene of project.scenes) scene.rootNodeIds = scene.rootNodeIds.filter((id) => !removeIds.has(id));
      project.nodes = project.nodes.filter((item) => !removeIds.has(item.id));
      for (const item of project.nodes) item.childIds = (item.childIds ?? []).filter((id) => !removeIds.has(id));
      project.constraints = project.constraints.filter((constraint) =>
        !removeIds.has(constraint.sourceNodeId) && !removeIds.has(constraint.targetNodeId)
      );
      project.dependencies = project.dependencies.filter((dependency) =>
        !(dependency.fromType === "node" && removeIds.has(dependency.fromId)) &&
        !(dependency.toType === "node" && removeIds.has(dependency.toId))
      );
      removeIds.forEach((id) => changed.add(id));
    } else if (operation.op === "reparent-node") {
      const node = project.nodes.find((item) => item.id === operation.nodeId);
      if (!node) throw new Error(`Node not found: ${operation.nodeId}`);
      const scene = project.scenes.find((item) => item.id === operation.sceneId);
      if (!scene) throw new Error(`Scene not found: ${operation.sceneId}`);
      if (operation.newParentId === node.id) throw new Error("A node cannot parent itself");
      if (operation.newParentId && !project.nodes.some((item) => item.id === operation.newParentId)) throw new Error("New parent not found");
      detachFromParent(project.nodes, node);
      for (const item of project.scenes) item.rootNodeIds = item.rootNodeIds.filter((id) => id !== node.id);
      node.parentId = operation.newParentId;
      if (operation.newParentId) {
        const parent = project.nodes.find((item) => item.id === operation.newParentId)!;
        parent.childIds = [...(parent.childIds ?? []), node.id];
        changed.add(parent.id);
      } else {
        scene.rootNodeIds.push(node.id);
      }
      changed.add(node.id);
    }
  }

  assertUniqueNodeIds(project.nodes);
  assertNoHierarchyCycles(project.nodes);

  project.project.updatedAt = options.createdAt;
  project.revisions.push({
    id: options.newRevisionId,
    parentRevisionId: options.currentRevisionId,
    createdAt: options.createdAt,
    message: options.message,
    author: "ScienceMotion Agent",
  });

  return { project, changedNodeIds: [...changed], revisionId: options.newRevisionId };
}
