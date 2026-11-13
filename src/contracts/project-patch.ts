import type { SceneNode } from "./project";

export interface ProjectPatchDocument {
  schemaVersion: "1.0.0";
  projectId: string;
  baseRevisionId: string;
  patches: ProjectPatchOperation[];
}

export type ProjectPatchOperation =
  | { op: "add-node"; sceneId: string; node: SceneNode }
  | { op: "update-node"; nodeId: string; changes: Partial<SceneNode> }
  | { op: "remove-node"; nodeId: string; recursive?: boolean }
  | { op: "reparent-node"; nodeId: string; newParentId?: string; sceneId: string };

export interface ProjectPatchResult {
  project: import("./project").ProjectDocument;
  changedNodeIds: string[];
  revisionId: string;
}
