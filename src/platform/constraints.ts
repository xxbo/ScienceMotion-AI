import type { ProjectDocument, SceneConstraint, Vector3 } from "../contracts/project";

function finiteVector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function findSceneForNode(project: ProjectDocument, nodeId: string): string | undefined {
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const contains = (rootId: string, targetId: string, seen = new Set<string>()): boolean => {
    if (seen.has(rootId)) return false;
    seen.add(rootId);
    if (rootId === targetId) return true;
    return (byId.get(rootId)?.childIds ?? []).some((childId) => contains(childId, targetId, seen));
  };
  return project.scenes.find((scene) => scene.rootNodeIds.some((rootId) => contains(rootId, nodeId)))?.id;
}

/** Structural and semantic validation for renderer-neutral constraints. */
export function validateSceneConstraints(
  project: ProjectDocument,
  constraints: SceneConstraint[] = project.constraints
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const nodes = new Set(project.nodes.map((node) => node.id));

  for (const constraint of constraints) {
    if (ids.has(constraint.id)) errors.push(`Duplicate constraint ID: ${constraint.id}`);
    ids.add(constraint.id);
    if (!nodes.has(constraint.sourceNodeId)) errors.push(`Constraint ${constraint.id} has missing source node`);
    if (!nodes.has(constraint.targetNodeId)) errors.push(`Constraint ${constraint.id} has missing target node`);
    if (constraint.sourceNodeId === constraint.targetNodeId && constraint.type !== "custom") {
      errors.push(`Constraint ${constraint.id} cannot target its own source node`);
    }
    if (!constraint.enabled) continue;

    const sourceScene = findSceneForNode(project, constraint.sourceNodeId);
    const targetScene = findSceneForNode(project, constraint.targetNodeId);
    if (sourceScene && targetScene && sourceScene !== targetScene) {
      errors.push(`Constraint ${constraint.id} crosses scene boundaries`);
    }

    if (constraint.type === "distance") {
      const distance = constraint.parameters.distance;
      if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) {
        errors.push(`Constraint ${constraint.id} requires a non-negative distance parameter`);
      }
    } else if (constraint.type === "limit-position" || constraint.type === "limit-rotation") {
      const min = constraint.parameters.min;
      const max = constraint.parameters.max;
      if (!finiteVector(min) || !finiteVector(max)) {
        errors.push(`Constraint ${constraint.id} requires finite min/max Vector3 parameters`);
      } else if (min.some((value, index) => value > max[index])) {
        errors.push(`Constraint ${constraint.id} has min values greater than max values`);
      }
    } else if (constraint.type === "follow-path") {
      const pathNodeId = constraint.parameters.pathNodeId;
      if (typeof pathNodeId !== "string" || !nodes.has(pathNodeId)) {
        errors.push(`Constraint ${constraint.id} requires an existing pathNodeId`);
      }
    }
  }
  return errors;
}
