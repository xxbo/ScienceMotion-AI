export type ProjectUnits = "metric" | "imperial" | "unitless" | "custom";
export type CoordinateSystem = "right-handed-y-up" | "right-handed-z-up" | "left-handed-y-up" | "screen-y-down";
export type ColorSpace = "srgb" | "linear-srgb" | "display-p3" | "rec2020" | "acescg";
export type NodeType = "group" | "text" | "shape" | "path" | "mesh" | "image" | "video" | "camera" | "light" | "emitter" | "simulation" | "custom";
export type ComponentKind = "geometry" | "material" | "camera" | "light" | "text" | "image" | "video" | "animation" | "constraint" | "simulation" | "renderer-extension";
export type TrackKind = "video" | "audio" | "caption" | "animation" | "effect";
export type Vector3 = [number, number, number];

export interface ProjectDocument {
  schemaVersion: "1.0.0";
  project: {
    id: string;
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    units: ProjectUnits;
    coordinateSystem: CoordinateSystem;
    timebase: { fps: number; ticksPerFrame: number };
    colorSpace: ColorSpace;
    metadata?: Record<string, unknown>;
  };
  editorial: {
    episodeId: string;
    creativeBrief?: string;
    styleReferences?: string[];
  };
  sequences: Sequence[];
  scenes: Scene[];
  nodes: SceneNode[];
  tracks?: Track[];
  shots?: Shot[];
  clips?: Clip[];
  assets: ProjectAsset[];
  revisions: Revision[];
}

export interface Sequence {
  id: string; name: string; durationFrames: number; fps: number;
  width: number; height: number; shotIds: string[];
}
export interface Scene {
  id: string; name: string; durationFrames: number;
  rootNodeIds: string[]; metadata?: Record<string, unknown>;
}
export interface SceneNode {
  id: string; name: string; type: NodeType; parentId?: string; childIds?: string[];
  transform: { position: Vector3; rotation: Vector3; scale: Vector3; pivot?: Vector3 };
  components: Array<{ kind: ComponentKind; data: Record<string, unknown>; engine?: string }>;
  metadata?: Record<string, unknown>;
}
export interface Track {
  id: string; name: string; kind: TrackKind; clipIds: string[];
}
export interface Shot {
  id: string; name: string; sceneId: string; startFrame: number;
  durationFrames: number; transitionIn?: string; transitionOut?: string;
}
export interface Clip {
  id: string; assetId: string; startFrame: number; durationFrames: number;
  inFrame?: number; gain?: number;
}
export interface ProjectAsset {
  id: string; kind: "image" | "video" | "audio" | "font" | "model" | "texture" | "data" | "other";
  uri: string; contentHash?: string; license?: string; attribution?: string;
  metadata?: Record<string, unknown>;
}
export interface Revision {
  id: string; parentRevisionId?: string; createdAt: string; message: string;
  author?: string; snapshotHash?: string;
}

export type ProjectPatch =
  | { op: "add-node"; node: SceneNode; sceneId: string }
  | { op: "update-node"; nodeId: string; expectedVersion?: string; changes: Partial<SceneNode> }
  | { op: "remove-node"; nodeId: string; recursive?: boolean }
  | { op: "reparent-node"; nodeId: string; newParentId?: string; sceneId: string };
