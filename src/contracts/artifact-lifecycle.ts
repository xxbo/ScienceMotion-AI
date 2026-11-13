import type { ArtifactKind, ArtifactRecord } from "./artifact";

export interface ArtifactReference {
  id: string;
  artifactId: string;
  ownerType: "project" | "tool-run" | "plugin" | "user";
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
  scanned: number;
  retained: number;
  deleted: string[];
  errors: Array<{ artifactId: string; message: string }>;
}

export interface ArtifactLifecycleManager {
  attach(input: Omit<ArtifactReference, "id" | "createdAt">): Promise<ArtifactReference>;
  detach(referenceId: string): Promise<boolean>;
  references(artifactId: string): Promise<ArtifactReference[]>;
  collectGarbage(options?: { olderThanMs?: number; now?: Date }): Promise<ArtifactGarbageCollectionResult>;
  attachToProject(project: import("./project").ProjectDocument, artifactId: string, metadata: { assetId: string; kind: Extract<ArtifactKind, "image" | "video" | "audio" | "model" | "texture" | "data" | "other">; role: string }): Promise<import("./project").ProjectDocument>;
}
