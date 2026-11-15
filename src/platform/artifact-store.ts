import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRecord, ArtifactStore } from "../contracts/artifact";
import { publishLocalFile } from "./local-file-publication";

const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function artifactHash(id: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(id);
  if (!match) throw new Error("Invalid artifact ID");
  return match[1];
}
function recordFor(input: Parameters<ArtifactStore["put"]>[0]): ArtifactRecord {
  if (!(input.bytes instanceof Uint8Array) || !input.mediaType?.trim()) throw new Error("Invalid artifact input");
  const contentHash = hashBytes(input.bytes);
  return { id: `sha256:${contentHash}`, kind: input.kind, mediaType: input.mediaType,
    uri: `artifact://sha256/${contentHash}`, contentHash, sizeBytes: input.bytes.byteLength,
    createdAt: new Date().toISOString(), provenance: input.provenance ? structuredClone(input.provenance) : undefined,
    metadata: input.metadata ? structuredClone(input.metadata) : undefined, license: input.license, attribution: input.attribution };
}
function checkRecord(record: ArtifactRecord, id: string): ArtifactRecord {
  const hash = artifactHash(id);
  if (record.id !== id || record.contentHash !== hash || record.uri !== `artifact://sha256/${hash}` ||
      !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error(`Artifact metadata integrity check failed: ${id}`);
  }
  return record;
}
type Query = { projectId?: string; kind?: ArtifactKind; limit?: number };
function select(records: ArtifactRecord[], query: Query): ArtifactRecord[] {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid artifact list limit");
  return records.filter((record) => (!query.kind || record.kind === query.kind) && (!query.projectId || record.provenance?.projectId === query.projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, limit).map((record) => structuredClone(record));
}
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly contents = new Map<string, Uint8Array>();
  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRecord> {
    const record = recordFor(input); const existing = this.records.get(record.id);
    if (existing) return structuredClone(existing);
    this.records.set(record.id, record); this.contents.set(record.id, new Uint8Array(input.bytes)); return structuredClone(record);
  }
  async get(id: string): Promise<ArtifactRecord | undefined> { artifactHash(id); const record = this.records.get(id); return record ? structuredClone(record) : undefined; }
  async read(id: string): Promise<Uint8Array | undefined> { artifactHash(id); const bytes = this.contents.get(id); return bytes ? new Uint8Array(bytes) : undefined; }
  async findByHash(hash: string): Promise<ArtifactRecord | undefined> { return this.get(`sha256:${hash}`); }
  async list(query: Query = {}): Promise<ArtifactRecord[]> { return select([...this.records.values()], query); }
  async delete(id: string): Promise<boolean> { artifactHash(id); this.contents.delete(id); return this.records.delete(id); }
}

/** Immutable content publication. Raw deletion is storage-internal; hosts use lifecycle collection. */
export class FileSystemArtifactStore implements ArtifactStore {
  constructor(private readonly rootDirectory: string) {}
  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRecord> {
    const bytes = new Uint8Array(input.bytes); const record = recordFor({ ...input, bytes });
    const hash = artifactHash(record.id);
    await publishLocalFile(join(this.rootDirectory, "blobs", hash.slice(0, 2), hash), bytes, true);
    // Existing corrupt content must not be silently accepted as a successful deduplication.
    if (!await this.read(record.id)) throw new Error("Artifact disappeared during publication");
    await publishLocalFile(join(this.rootDirectory, "metadata", `${hash}.json`), JSON.stringify(record), true);
    return (await this.get(record.id))!;
  }
  async get(id: string): Promise<ArtifactRecord | undefined> {
    const hash = artifactHash(id);
    try { return checkRecord(JSON.parse(await readFile(join(this.rootDirectory, "metadata", `${hash}.json`), "utf8")) as ArtifactRecord, id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async read(id: string): Promise<Uint8Array | undefined> {
    const hash = artifactHash(id);
    try {
      const bytes = await readFile(join(this.rootDirectory, "blobs", hash.slice(0, 2), hash));
      if (hashBytes(bytes) !== hash) throw new Error(`Artifact integrity check failed: ${id}`);
      return new Uint8Array(bytes);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async findByHash(hash: string): Promise<ArtifactRecord | undefined> { return this.get(`sha256:${hash}`); }
  async list(query: Query = {}): Promise<ArtifactRecord[]> {
    let names: string[];
    try { names = await readdir(join(this.rootDirectory, "metadata")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.get(`sha256:${name.slice(0, -5)}`)));
    return select(records.filter((record): record is ArtifactRecord => record !== undefined), query);
  }
  async delete(id: string): Promise<boolean> {
    const hash = artifactHash(id);
    try { await rm(join(this.rootDirectory, "metadata", `${hash}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    await rm(join(this.rootDirectory, "blobs", hash.slice(0, 2), hash), { force: true }); return true;
  }
}
