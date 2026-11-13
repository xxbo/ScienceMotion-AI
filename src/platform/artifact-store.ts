import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRecord, ArtifactStore } from "../contracts/artifact";

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertArtifactId(id: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(id);
  if (!match) throw new Error("Invalid artifact ID");
  return match[1];
}

function recordFor(input: {
  bytes: Uint8Array;
  kind: ArtifactKind;
  mediaType: string;
  provenance?: ArtifactRecord["provenance"];
  metadata?: Record<string, unknown>;
  license?: string;
  attribution?: string;
}, createdAt = new Date().toISOString()): ArtifactRecord {
  const contentHash = hashBytes(input.bytes);
  return {
    id: `sha256:${contentHash}`,
    kind: input.kind,
    mediaType: input.mediaType,
    uri: `artifact://sha256/${contentHash}`,
    contentHash,
    sizeBytes: input.bytes.byteLength,
    createdAt,
    provenance: input.provenance ? structuredClone(input.provenance) : undefined,
    metadata: input.metadata ? structuredClone(input.metadata) : undefined,
    license: input.license,
    attribution: input.attribution,
  };
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly contents = new Map<string, Uint8Array>();

  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRecord> {
    const record = recordFor(input);
    const existing = this.records.get(record.id);
    if (existing) return structuredClone(existing);
    this.records.set(record.id, record);
    this.contents.set(record.id, new Uint8Array(input.bytes));
    return structuredClone(record);
  }

  async get(artifactId: string): Promise<ArtifactRecord | undefined> {
    const record = this.records.get(artifactId);
    return record ? structuredClone(record) : undefined;
  }

  async read(artifactId: string): Promise<Uint8Array | undefined> {
    const bytes = this.contents.get(artifactId);
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  async findByHash(contentHash: string): Promise<ArtifactRecord | undefined> {
    return this.get(`sha256:${contentHash}`);
  }

  async list(query: { projectId?: string; kind?: ArtifactKind; limit?: number } = {}): Promise<ArtifactRecord[]> {
    return [...this.records.values()]
      .filter((record) => !query.kind || record.kind === query.kind)
      .filter((record) => !query.projectId || record.provenance?.projectId === query.projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, query.limit ?? 100))
      .map((record) => structuredClone(record));
  }

  async delete(artifactId: string): Promise<boolean> {
    this.contents.delete(artifactId);
    return this.records.delete(artifactId);
  }
}

/**
 * Local content-addressed filesystem store.
 * Blob and metadata filenames are derived exclusively from SHA-256 hashes.
 * Writes are staged and atomically renamed; duplicate bytes reuse the same blob.
 */
export class FileSystemArtifactStore implements ArtifactStore {
  constructor(private readonly rootDirectory: string) {}

  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRecord> {
    const record = recordFor(input);
    const hash = assertArtifactId(record.id);
    const blobDirectory = join(this.rootDirectory, "blobs", hash.slice(0, 2));
    const metadataDirectory = join(this.rootDirectory, "metadata");
    await mkdir(blobDirectory, { recursive: true });
    await mkdir(metadataDirectory, { recursive: true });
    const blobPath = join(blobDirectory, hash);
    const metadataPath = join(metadataDirectory, `${hash}.json`);

    try {
      await readFile(blobPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temp = `${blobPath}.${process.pid}.tmp`;
      try {
        await writeFile(temp, input.bytes, { flag: "wx" });
        await rename(temp, blobPath);
      } catch (writeError) {
        await rm(temp, { force: true });
        try { await readFile(blobPath); } catch { throw writeError; }
      }
    }

    try {
      const existing = JSON.parse(await readFile(metadataPath, "utf8")) as ArtifactRecord;
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const tempMetadata = `${metadataPath}.${process.pid}.tmp`;
    await writeFile(tempMetadata, JSON.stringify(record), { flag: "wx" });
    try {
      await rename(tempMetadata, metadataPath);
    } catch (error) {
      await rm(tempMetadata, { force: true });
      try { return JSON.parse(await readFile(metadataPath, "utf8")) as ArtifactRecord; }
      catch { throw error; }
    }
    return structuredClone(record);
  }

  async get(artifactId: string): Promise<ArtifactRecord | undefined> {
    const hash = assertArtifactId(artifactId);
    try {
      return JSON.parse(await readFile(join(this.rootDirectory, "metadata", `${hash}.json`), "utf8")) as ArtifactRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async read(artifactId: string): Promise<Uint8Array | undefined> {
    const hash = assertArtifactId(artifactId);
    try {
      const bytes = await readFile(join(this.rootDirectory, "blobs", hash.slice(0, 2), hash));
      if (hashBytes(bytes) !== hash) throw new Error(`Artifact integrity check failed: ${artifactId}`);
      return new Uint8Array(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async findByHash(contentHash: string): Promise<ArtifactRecord | undefined> {
    return this.get(`sha256:${contentHash}`);
  }

  async list(query: { projectId?: string; kind?: ArtifactKind; limit?: number } = {}): Promise<ArtifactRecord[]> {
    let names: string[];
    try { names = await readdir(join(this.rootDirectory, "metadata")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
      JSON.parse(await readFile(join(this.rootDirectory, "metadata", name), "utf8")) as ArtifactRecord
    ));
    return records.filter((record) => (!query.kind || record.kind === query.kind) &&
      (!query.projectId || record.provenance?.projectId === query.projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, query.limit ?? 100));
  }

  async delete(artifactId: string): Promise<boolean> {
    const hash = assertArtifactId(artifactId);
    const metadataPath = join(this.rootDirectory, "metadata", `${hash}.json`);
    try {
      await rm(metadataPath);
      // Blob deletion is safe because the content hash is the identity and there is one metadata record per blob.
      await rm(join(this.rootDirectory, "blobs", hash.slice(0, 2), hash), { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
