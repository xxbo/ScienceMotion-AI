import type { ProjectAnimationTrack, ProjectAsset, Scene, SceneNode, Shot } from "./project";

export interface ProjectPatchDocument {
  /** Patch protocol version, independent of the ProjectDocument format. */
  schemaVersion: "1.1.0" | "1.2.0" | "1.3.0";
  projectId: string;
  baseRevisionId: string;
  patches: ProjectPatchOperation[];
}
export type CreativePatchOperation =
  | { op: "add-scene"; scene: Scene }
  | { op: "update-scene"; sceneId: string; changes: Partial<Pick<Scene, "name" | "durationFrames" | "metadata">> }
  | { op: "remove-scene"; sceneId: string }
  | { op: "add-shot"; sequenceId: string; shot: Shot }
  | { op: "update-shot"; shotId: string; changes: Partial<Omit<Shot, "id">> }
  | { op: "remove-shot"; shotId: string }
  | { op: "put-animation-track"; track: ProjectAnimationTrack }
  | { op: "remove-animation-track"; trackId: string };

export type ProjectPatchOperation =
  | { op: "add-node"; sceneId: string; node: SceneNode }
  | { op: "update-node"; nodeId: string; changes: Partial<SceneNode> }
  | { op: "remove-node"; nodeId: string; recursive?: boolean }
  | { op: "reparent-node"; nodeId: string; newParentId?: string; sceneId: string }
  // Asset edits require Patch >= 1.2.0; ProjectDocument remains 1.1.0.
  | { op: "add-asset"; asset: ProjectAsset }
  | { op: "replace-asset"; assetId: string; asset: ProjectAsset }
  | { op: "remove-asset"; assetId: string }
  // Creative scene/timeline edits require Patch 1.3.0.
  | CreativePatchOperation;

export interface ProjectPatchResult {
  project: import("./project").ProjectDocument;
  changedNodeIds: string[];
  changedAssetIds?: string[];
  changedSceneIds?: string[];
  changedShotIds?: string[];
  changedAnimationTrackIds?: string[];
  revisionId: string;
}
