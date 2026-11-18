import type { ArtifactKind } from "./artifact";
import type { ProjectDocument } from "./project";

export interface ArtifactReference {
  id: string;
  artifactId: string;
  ownerType: "project" | "tool-run" | "plugin" | "user" | "snapshot" | "transaction" | "render-job";
  ownerId: string;
  role: string;
  createdAt: string;
}
export interface ArtifactReferenceStore {
  attach(reference: ArtifactReference): Promise<boolean>;
  detach(referenceId: string): Promise<boolean>;
  list(query?: { artifactId?: string; ownerType?: ArtifactReference["ownerType"]; ownerId?: string }): Promise<ArtifactReference[]>;
  count(artifactId: string): Promise<number>;
}
export interface ArtifactGarbageCollectionResult {
  scanned: number; retained: number; deleted: string[];
  errors: Array<{ artifactId: string; message: string }>;
}
export interface ArtifactGarbageCollectionOptions {
  olderThanMs?: number;
  now?: Date;
  /** Durable owners whose output identity is known but whose reference may not have been attached yet. */
  protectedArtifactIds?: readonly string[];
}
export interface ArtifactLifecycleManager {
  attach(input: Omit<ArtifactReference, "id" | "createdAt">): Promise<ArtifactReference>;
  detach(referenceId: string): Promise<boolean>;
  references(artifactId: string): Promise<ArtifactReference[]>;
  collectGarbage(options?: ArtifactGarbageCollectionOptions): Promise<ArtifactGarbageCollectionResult>;
  /** Low-level document helper; use the workspace's revisioned Patch API for persisted edits. */
  attachToProject(project: ProjectDocument, artifactId: string, metadata: { assetId: string; kind: Extract<ArtifactKind, "image" | "video" | "audio" | "model" | "texture" | "data" | "other">; role: string }): Promise<ProjectDocument>;
  detachProjectAsset(project: ProjectDocument, assetId: string): Promise<ProjectDocument>;
  reconcileProjectReferences(project: ProjectDocument): Promise<{ attached: string[]; detached: string[]; missingArtifacts: string[] }>;
}
