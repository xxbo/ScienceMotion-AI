export type ArtifactKind = "image" | "video" | "audio" | "model" | "texture" | "document" | "data" | "other";

export interface ArtifactProvenance {
  toolId?: string;
  toolVersion?: string;
  pluginId?: string;
  projectId?: string;
  runId?: string;
  callId?: string;
  sourceArtifactIds?: string[];
  parametersHash?: string;
}

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  mediaType: string;
  uri: string;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
  provenance?: ArtifactProvenance;
  metadata?: Record<string, unknown>;
  license?: string;
  attribution?: string;
}

export interface ArtifactStore {
  put(input: {
    bytes: Uint8Array;
    kind: ArtifactKind;
    mediaType: string;
    extension?: string;
    provenance?: ArtifactProvenance;
    metadata?: Record<string, unknown>;
    license?: string;
    attribution?: string;
  }): Promise<ArtifactRecord>;
  get(artifactId: string): Promise<ArtifactRecord | undefined>;
  read(artifactId: string): Promise<Uint8Array | undefined>;
  findByHash(contentHash: string): Promise<ArtifactRecord | undefined>;
  list(query?: { projectId?: string; kind?: ArtifactKind; limit?: number }): Promise<ArtifactRecord[]>;
  delete(artifactId: string): Promise<boolean>;
}
