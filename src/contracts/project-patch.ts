import type { CaptionCue, Clip, FollowPathParameters, Keyframe, ProjectAnimationTrack, ProjectAsset, Scene, SceneNode, Shot, ShotTransition } from "./project";

export interface ProjectPatchDocument {
  /** Patch protocol version, independent of the ProjectDocument format. */
  schemaVersion: "1.1.0" | "1.2.0" | "1.3.0" | "1.4.0";
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

export type TimelinePatchOperation =
  | { op: "move-shot"; shotId: string; startFrame: number }
  | { op: "trim-shot"; shotId: string; inFrame: number; durationFrames: number }
  | { op: "reorder-shots"; shotIds: string[]; startFrame?: number }
  | { op: "place-clip"; trackId: string; clip: Clip }
  | { op: "set-caption"; captionId: string; caption: Omit<CaptionCue, "id"> | null }
  | { op: "set-transition"; fromShotId: string; toShotId: string; transition: Pick<ShotTransition, "type" | "durationFrames"> | null };

export type FollowPathPatchOperation =
  | { op: "bind-follow-path"; constraintId: string; followerNodeId: string; guideNodeId: string;
      keyframes: Keyframe<number>[]; loop?: boolean; anchor?: FollowPathParameters["anchor"] }
  | { op: "edit-follow-path"; constraintId: string; changes: { pathData?: string; keyframes?: Keyframe<number>[]; loop?: boolean } };

export type ProjectPatchOperation =
  | { op: "add-node"; sceneId: string; node: SceneNode }
  | { op: "update-node"; nodeId: string; changes: Partial<SceneNode> }
  | { op: "remove-node"; nodeId: string; recursive?: boolean }
  | { op: "reparent-node"; nodeId: string; newParentId?: string; sceneId: string }
  // Asset edits require Patch >= 1.2.0; ProjectDocument remains 1.1.0.
  | { op: "add-asset"; asset: ProjectAsset }
  | { op: "replace-asset"; assetId: string; asset: ProjectAsset }
  | { op: "remove-asset"; assetId: string }
  // Creative scene, animation and motion path edits require Patch 1.3.0.
  | CreativePatchOperation | FollowPathPatchOperation
  // Timeline transactions use the dedicated Patch 1.4.0 schema.
  | TimelinePatchOperation;

export interface ProjectPatchResult {
  project: import("./project").ProjectDocument;
  changedNodeIds: string[];
  changedAssetIds?: string[];
  changedSceneIds?: string[];
  changedShotIds?: string[];
  changedClipIds?: string[];
  changedCaptionIds?: string[];
  changedAnimationTrackIds?: string[];
  /** Bindings affected by a path transaction, including a geometry-only edit. */
  changedConstraintIds?: string[];
  revisionId: string;
}
