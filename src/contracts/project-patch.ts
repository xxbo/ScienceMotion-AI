import type { ProjectAsset, SceneNode } from "./project";

export interface ProjectPatchDocument {
  /** Patch protocol version, independent of the ProjectDocument format. */
  schemaVersion: "1.1.0" | "1.2.0";
  projectId: string;
  baseRevisionId: string;
  patches: ProjectPatchOperation[];
}

export type ProjectPatchOperation =
  | { op: "add-node"; sceneId: string; node: SceneNode }
  | { op: "update-node"; nodeId: string; changes: Partial<SceneNode> }
  | { op: "remove-node"; nodeId: string; recursive?: boolean }
  | { op: "reparent-node"; nodeId: string; newParentId?: string; sceneId: string }
  // Asset edits require Patch 1.2.0; ProjectDocument remains 1.1.0.
  | { op: "add-asset"; asset: ProjectAsset }
  | { op: "replace-asset"; assetId: string; asset: ProjectAsset }
  | { op: "remove-asset"; assetId: string };

export interface ProjectPatchResult {
  project: import("./project").ProjectDocument;
  changedNodeIds: string[];
  changedAssetIds?: string[];
  revisionId: string;
}
