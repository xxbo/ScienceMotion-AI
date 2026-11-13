import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRecord, ArtifactStore } from "../contracts/artifact";
import type { ArtifactGarbageCollectionResult, ArtifactLifecycleManager, ArtifactReference, ArtifactReferenceStore } from "../contracts/artifact-lifecycle";
import type { ProjectDocument } from "../contracts/project";

function referenceId(input: Omit<ArtifactReference, "id" | "createdAt">): string {
  const key = [input.artifactId, input.ownerType, input.ownerId, input.role].join("\0");
  return "ref:" + createHash("sha256").update(key).digest("hex");
}

export class InMemoryArtifactReferenceStore implements ArtifactReferenceStore {
  private readonly referencesById = new Map<string, ArtifactReference>();
  async attach(reference: ArtifactReference): Promise<boolean> {
    if (this.referencesById.has(reference.id)) return false;
    this.referencesById.set(reference.id, structuredClone(reference));
    return true;
  }
  async detach(id: string): Promise<boolean> { return this.referencesById.delete(id); }
  async list(query: { artifactId?: string; ownerType?: ArtifactReference["ownerType"]; ownerId?: string } = {}): Promise<ArtifactReference[]> {
    return [...this.referencesById.values()].filter((r) => (!query.artifactId || r.artifactId === query.artifactId) && (!query.ownerType || r.ownerType === query.ownerType) && (!query.ownerId || r.ownerId === query.ownerId)).map((r) => structuredClone(r));
  }
  async count(artifactId: string): Promise<number> { return [...this.referencesById.values()].filter((r) => r.artifactId === artifactId).length; }
}

export class FileSystemArtifactReferenceStore implements ArtifactReferenceStore {
  constructor(private readonly rootDirectory: string) {}
  async attach(reference: ArtifactReference): Promise<boolean> {
    await mkdir(this.rootDirectory, { recursive: true });
    const path = join(this.rootDirectory, reference.id.replace("ref:", "") + ".json");
    try { await readFile(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = path + "." + process.pid + ".tmp";
    await writeFile(temp, JSON.stringify(reference), { flag: "wx" });
    try { await rename(temp, path); return true; }
    catch (error) { await rm(temp, { force: true }); try { await readFile(path); return false; } catch { throw error; } }
  }
  async detach(id: string): Promise<boolean> {
    const path = join(this.rootDirectory, id.replace("ref:", "") + ".json");
    try { await rm(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async list(query: { artifactId?: string; ownerType?: ArtifactReference["ownerType"]; ownerId?: string } = {}): Promise<ArtifactReference[]> {
    let names: string[];
    try { names = await readdir(this.rootDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records = await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => JSON.parse(await readFile(join(this.rootDirectory, n), "utf8")) as ArtifactReference));
    return records.filter((r) => (!query.artifactId || r.artifactId === query.artifactId) && (!query.ownerType || r.ownerType === query.ownerType) && (!query.ownerId || r.ownerId === query.ownerId));
  }
  async count(artifactId: string): Promise<number> { return (await this.list({ artifactId })).length; }
}

export class LocalArtifactLifecycleManager implements ArtifactLifecycleManager {
  constructor(private readonly artifacts: ArtifactStore, private readonly referencesStore: ArtifactReferenceStore) {}

  async attach(input: Omit<ArtifactReference, "id" | "createdAt">): Promise<ArtifactReference> {
    const artifact = await this.artifacts.get(input.artifactId);
    if (!artifact) throw new Error("Cannot reference an artifact that does not exist: " + input.artifactId);
    const reference: ArtifactReference = { ...input, id: referenceId(input), createdAt: new Date().toISOString() };
    await this.referencesStore.attach(reference);
    return (await this.referencesStore.list({ artifactId: input.artifactId })).find((item) => item.id === reference.id) ?? reference;
  }

  async detach(referenceIdValue: string): Promise<boolean> { return this.referencesStore.detach(referenceIdValue); }
  async references(artifactId: string): Promise<ArtifactReference[]> { return this.referencesStore.list({ artifactId }); }

  async attachToProject(project: ProjectDocument, artifactId: string, metadata: { assetId: string; kind: Extract<ArtifactKind, "image" | "video" | "audio" | "model" | "texture" | "data" | "other">; role: string }): Promise<ProjectDocument> {
    const artifact = await this.artifacts.get(artifactId);
    if (!artifact) throw new Error("Artifact not found: " + artifactId);
    const existing = project.assets.find((asset) => asset.id === metadata.assetId);
    if (existing && (existing.uri !== artifact.uri || existing.contentHash !== artifact.contentHash)) throw new Error("Project asset ID already points to different content: " + metadata.assetId);
    await this.attach({ artifactId, ownerType: "project", ownerId: project.project.id, role: metadata.role });
    const next = structuredClone(project);
    if (!existing) next.assets.push({ id: metadata.assetId, kind: metadata.kind, uri: artifact.uri, contentHash: artifact.contentHash, license: artifact.license, attribution: artifact.attribution, metadata: { ...artifact.metadata, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes } });
    return next;
  }

  async collectGarbage(options: { olderThanMs?: number; now?: Date } = {}): Promise<ArtifactGarbageCollectionResult> {
    const olderThanMs = Math.max(0, options.olderThanMs ?? 24 * 60 * 60 * 1000);
    const now = options.now ?? new Date();
    const candidates = await this.artifacts.list({ limit: 100000 });
    const result: ArtifactGarbageCollectionResult = { scanned: candidates.length, retained: 0, deleted: [], errors: [] };
    for (const artifact of candidates) {
      try {
        if (now.getTime() - Date.parse(artifact.createdAt) < olderThanMs || await this.referencesStore.count(artifact.id) > 0) {
          result.retained++;
          continue;
        }
        const deleted = await this.artifacts.delete(artifact.id);
        if (deleted) result.deleted.push(artifact.id);
      } catch (error) {
        result.errors.push({ artifactId: artifact.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }
}
