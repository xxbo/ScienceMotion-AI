import type { FollowPathParameters, ProjectDocument } from "../contracts/project";
import type { FollowPathPatchOperation, ProjectPatchOperation } from "../contracts/project-patch";
import { isActiveFollowPath } from "./follow-path";
import { ProjectEditError } from "./project-edit-error";

export function isFollowPathOperation(op: ProjectPatchOperation): op is FollowPathPatchOperation {
  return op.op === "bind-follow-path" || op.op === "edit-follow-path";
}

/** Applies a scoped edit on the patch's working copy, before complete graph validation. */
export function applyFollowPathOperation(project: ProjectDocument, op: FollowPathPatchOperation, changedNodes: Set<string>): void {
  const { constraintId } = op;
  const constraint = project.constraints.find(item => item.id === constraintId);
  if (op.op === "bind-follow-path") {
    const { followerNodeId, guideNodeId, keyframes, anchor, loop } = op;
    const details = { constraintId, followerNodeId, guideNodeId };
    if (constraint) throw new ProjectEditError("FOLLOW_PATH_ID_EXISTS", `Constraint ${constraintId} already exists. Choose another ID or edit the active binding.`, details);
    const parameters: FollowPathParameters = {
      pathNodeId: guideNodeId,
      progress: { keyframes: structuredClone(keyframes), ...(loop === undefined ? {} : { loop }) },
      ...(anchor === undefined ? {} : { anchor: structuredClone(anchor) }),
    };
    project.constraints.push({ id: constraintId, type: "follow-path", enabled: true, sourceNodeId: followerNodeId, targetNodeId: guideNodeId, parameters });
    return;
  }

  if (!constraint || !isActiveFollowPath(constraint)) {
    throw new ProjectEditError("FOLLOW_PATH_NOT_EDITABLE", `Constraint ${constraintId} must be an existing, enabled follow-path binding with progress keys.`, { constraintId });
  }
  const details = { constraintId, followerNodeId: constraint.sourceNodeId, guideNodeId: constraint.targetNodeId };
  const { pathData, keyframes, loop } = op.changes;
  if (pathData === undefined && keyframes === undefined && loop === undefined) {
    throw new ProjectEditError("FOLLOW_PATH_EMPTY_EDIT", "Provide pathData, keyframes or loop to edit the binding.", details);
  }
  if (pathData !== undefined) {
    const guide = project.nodes.find(node => node.id === constraint.targetNodeId && node.type === "path");
    const geometry = guide?.components.find(component => component.kind === "geometry");
    if (!guide || !geometry) throw new ProjectEditError("FOLLOW_PATH_GUIDE_INVALID", "The binding needs a path node with SVG geometry.", details);
    const otherFollowers = project.constraints.filter(item => item !== constraint && isActiveFollowPath(item) && item.targetNodeId === guide.id);
    if (otherFollowers.length && pathData !== geometry.data.pathData) {
      throw new ProjectEditError("FOLLOW_PATH_SHARED_GUIDE", "This guide drives other followers. Use a dedicated guide for a scoped geometry edit, or edit only the timing.",
        { ...details, otherConstraintIds: otherFollowers.map(item => item.id) });
    }
    if (pathData !== geometry.data.pathData) {
      geometry.data = { ...geometry.data, pathData };
      changedNodes.add(guide.id);
    }
  }
  if (keyframes !== undefined || loop !== undefined) {
    const progress = constraint.parameters.progress as FollowPathParameters["progress"];
    constraint.parameters = { ...constraint.parameters, progress: {
      ...progress, ...(keyframes === undefined ? {} : { keyframes: structuredClone(keyframes) }), ...(loop === undefined ? {} : { loop }),
    } };
  }
}
