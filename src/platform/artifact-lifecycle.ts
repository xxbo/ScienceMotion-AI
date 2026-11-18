import { createHash } from "node:crypto";
import { readFile, readdir, rm, open } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRecord, ArtifactStore } from "../contracts/artifact";
import type { ArtifactGarbageCollectionOptions, ArtifactGarbageCollectionResult, ArtifactLifecycleManager, ArtifactReference, ArtifactReferenceStore } from "../contracts/artifact-lifecycle";
import type { ProjectDocument } from "../contracts/project";
import { artifactIdForAsset, assertAssetRemovable, projectArtifactBindings } from "./project-assets";
import { publishLocalFile } from "./local-file-publication";

type Owner = Pick<ArtifactReference, "ownerType" | "ownerId">;
type ReferenceInput = Omit<ArtifactReference, "id" | "createdAt">;
type Query = { artifactId?: string; ownerType?: ArtifactReference["ownerType"]; ownerId?: string };
const ownerTypes = new Set(["project", "tool-run", "plugin", "user", "snapshot", "transaction", "render-job"]);
function assertReferenceId(id: string): string {
  if (!/^ref:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid artifact reference ID");
  return id.slice(4);
}
function referenceId(input: ReferenceInput): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.artifactId) || !ownerTypes.has(input.ownerType) ||
      [input.ownerId, input.role].some((value) => typeof value !== "string" || !value.trim() || value.includes("\0"))) {
    throw new Error("Invalid artifact reference fields");
  }
  // Preserve existing reference IDs; NUL is rejected in fields to keep this encoding unambiguous.
  return "ref:" + createHash("sha256").update([input.artifactId, input.ownerType, input.ownerId, input.role].join("\0")).digest("hex");
}
function validateReference(reference: ArtifactReference): void {
  assertReferenceId(reference.id);
  if (reference.id !== referenceId(reference) || !Number.isFinite(Date.parse(reference.createdAt))) throw new Error("Artifact reference integrity check failed");
}
const matches = (r: ArtifactReference, q: Query) => (!q.artifactId || r.artifactId === q.artifactId) && (!q.ownerType || r.ownerType === q.ownerType) && (!q.ownerId || r.ownerId === q.ownerId);

export class InMemoryArtifactReferenceStore implements ArtifactReferenceStore {
  private readonly referencesById = new Map<string, ArtifactReference>();
  async attach(reference: ArtifactReference): Promise<boolean> {
    validateReference(reference);
    if (this.referencesById.has(reference.id)) return false;
    this.referencesById.set(reference.id, structuredClone(reference)); return true;
  }
  async detach(id: string): Promise<boolean> { assertReferenceId(id); return this.referencesById.delete(id); }
  async list(query: Query = {}): Promise<ArtifactReference[]> { return [...this.referencesById.values()].filter((r) => matches(r, query)).map((r) => structuredClone(r)); }
  async count(artifactId: string): Promise<number> { return [...this.referencesById.values()].filter((r) => r.artifactId === artifactId).length; }
}
export class FileSystemArtifactReferenceStore implements ArtifactReferenceStore {
  constructor(private readonly rootDirectory: string) {}
  async attach(reference: ArtifactReference): Promise<boolean> {
    validateReference(reference); const copy = structuredClone(reference);
    return publishLocalFile(join(this.rootDirectory, assertReferenceId(copy.id) + ".json"), JSON.stringify(copy), true);
  }
  async detach(id: string): Promise<boolean> {
    try { await rm(join(this.rootDirectory, assertReferenceId(id) + ".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const directory = await open(this.rootDirectory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }
  async list(query: Query = {}): Promise<ArtifactReference[]> {
    let names: string[];
    try { names = await readdir(this.rootDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: ArtifactReference[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const record = JSON.parse(await readFile(join(this.rootDirectory, name), "utf8")) as ArtifactReference;
      validateReference(record);
      if (name !== assertReferenceId(record.id) + ".json") throw new Error("Artifact reference filename mismatch");
      if (matches(record, query)) records.push(record);
    }
    return records;
  }
  async count(artifactId: string): Promise<number> { return (await this.list({ artifactId })).length; }
}

// Related lifecycle instances must share the same reference-store object in one host.
const queues = new WeakMap<ArtifactReferenceStore, Promise<void>>();
export class LocalArtifactLifecycleManager implements ArtifactLifecycleManager {
  constructor(private readonly artifacts: ArtifactStore, private readonly referencesStore: ArtifactReferenceStore) {}
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.referencesStore) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    queues.set(this.referencesStore, current); await previous;
    try { return await operation(); }
    finally { release(); if (queues.get(this.referencesStore) === current) queues.delete(this.referencesStore); }
  }
  private async checkedArtifact(id: string): Promise<ArtifactRecord | undefined> {
    const record = await this.artifacts.get(id);
    if (!record) return undefined;
    const bytes = await this.artifacts.read(id);
    if (!bytes) return undefined;
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (record.id !== id || id !== `sha256:${hash}` || record.contentHash !== hash || record.uri !== `artifact://sha256/${hash}` || record.sizeBytes !== bytes.byteLength) {
      throw new Error(`Artifact integrity check failed: ${id}`);
    }
    return record;
  }
  private async attachUnlocked(input: ReferenceInput): Promise<ArtifactReference> {
    const id = referenceId(input);
    if (!await this.checkedArtifact(input.artifactId)) throw new Error("Cannot reference an artifact that does not exist: " + input.artifactId);
    const reference = { ...input, id, createdAt: new Date().toISOString() };
    await this.referencesStore.attach(reference);
    return (await this.referencesStore.list({ artifactId: input.artifactId })).find((r) => r.id === id) ?? reference;
  }
  async attach(input: ReferenceInput): Promise<ArtifactReference> { const copy = structuredClone(input); return this.exclusive(() => this.attachUnlocked(copy)); }
  async detach(id: string): Promise<boolean> { assertReferenceId(id); return this.exclusive(() => this.referencesStore.detach(id)); }
  async references(id: string): Promise<ArtifactReference[]> { return this.exclusive(() => this.referencesStore.list({ artifactId: id })); }
  async releaseOwner(owner: Owner, rolePrefix?: string): Promise<void> {
    const copy = structuredClone(owner);
    await this.exclusive(async () => { for (const ref of await this.referencesStore.list(copy)) if (rolePrefix === undefined || ref.role.startsWith(rolePrefix)) await this.referencesStore.detach(ref.id); });
  }
  /** Verify bytes, not just metadata. External URIs are outside local retention ownership. */
  async verifyProjectArtifacts(project: ProjectDocument): Promise<void> {
    const bindings = projectArtifactBindings(structuredClone(project));
    await this.exclusive(async () => {
      for (const binding of bindings) if (!await this.checkedArtifact(binding.artifactId)) throw new Error(`Missing artifact bytes for asset ${binding.assetId}`);
    });
  }
  /** Add desired references before releasing stale ones; any missing bytes preserve all old references. */
  async reconcileOwner(project: ProjectDocument, owner: Owner, rolePrefix = "asset:"): Promise<{ attached: string[]; detached: string[]; missingArtifacts: string[] }> {
    const bindings = projectArtifactBindings(structuredClone(project)); const copy = structuredClone(owner);
    return this.exclusive(async () => {
      const result = { attached: [] as string[], detached: [] as string[], missingArtifacts: [] as string[] };
      for (const b of bindings) if (!await this.checkedArtifact(b.artifactId)) result.missingArtifacts.push(b.assetId);
      if (result.missingArtifacts.length) return result;
      const expected = new Map(bindings.map((b) => [rolePrefix + b.assetId, b.artifactId]));
      const current = await this.referencesStore.list(copy);
      for (const b of bindings) {
        const role = rolePrefix + b.assetId;
        if (!current.some((r) => r.role === role && r.artifactId === b.artifactId)) {
          await this.attachUnlocked({ artifactId: b.artifactId, ...copy, role }); result.attached.push(b.assetId);
        }
      }
      for (const ref of current) if (ref.role.startsWith(rolePrefix) && expected.get(ref.role) !== ref.artifactId) {
        await this.referencesStore.detach(ref.id); result.detached.push(ref.role.slice(rolePrefix.length));
      }
      return result;
    });
  }
  async reconcileProjectReferences(project: ProjectDocument): Promise<{ attached: string[]; detached: string[]; missingArtifacts: string[] }> {
    return this.reconcileOwner(project, { ownerType: "project", ownerId: project.project.id });
  }
  /** Legacy detached-document helpers. Durable hosts use FileSystemProjectWorkspace.applyPatch. */
  async attachToProject(project: ProjectDocument, id: string, metadata: { assetId: string; kind: Extract<ArtifactKind, "image" | "video" | "audio" | "model" | "texture" | "data" | "other">; role: string }): Promise<ProjectDocument> {
    const next = structuredClone(project); const meta = structuredClone(metadata);
    return this.exclusive(async () => {
      const artifact = await this.checkedArtifact(id);
      if (!artifact) throw new Error("Artifact not found: " + id);
      const existing = next.assets.find((asset) => asset.id === meta.assetId);
      if (existing && (existing.uri !== artifact.uri || (existing.contentHash !== undefined && existing.contentHash !== artifact.contentHash) || existing.kind !== meta.kind)) throw new Error("Project asset ID already points to different content: " + meta.assetId);
      if (!existing) next.assets.push({ id: meta.assetId, kind: meta.kind, uri: artifact.uri, contentHash: artifact.contentHash, license: artifact.license, attribution: artifact.attribution,
        metadata: { ...artifact.metadata, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes } });
      projectArtifactBindings(next);
      await this.attachUnlocked({ artifactId: id, ownerType: "project", ownerId: next.project.id, role: "asset:" + meta.assetId });
      return next;
    });
  }
  async detachProjectAsset(project: ProjectDocument, assetId: string): Promise<ProjectDocument> {
    const next = structuredClone(project); const asset = next.assets.find((a) => a.id === assetId);
    if (!asset) return next;
    assertAssetRemovable(next, assetId); artifactIdForAsset(asset);
    next.assets = next.assets.filter((a) => a.id !== assetId);
    await this.exclusive(async () => {
      for (const ref of await this.referencesStore.list({ ownerType: "project", ownerId: next.project.id })) {
        if (ref.role === "asset:" + assetId) await this.referencesStore.detach(ref.id);
      }
    });
    return next;
  }
  async collectGarbage(options: ArtifactGarbageCollectionOptions = {}): Promise<ArtifactGarbageCollectionResult> {
    const age = options.olderThanMs ?? 86_400_000; const now = (options.now ?? new Date()).getTime();
    const protectedIds = new Set(options.protectedArtifactIds);
    if (!Number.isFinite(age) || age < 0 || !Number.isFinite(now)) throw new Error("Invalid garbage collection retention/time");
    return this.exclusive(async () => {
      const candidates = await this.artifacts.list({ limit: Number.MAX_SAFE_INTEGER });
      const result: ArtifactGarbageCollectionResult = { scanned: candidates.length, retained: 0, deleted: [], errors: [] };
      for (const artifact of candidates) {
        try {
          const elapsed = now - Date.parse(artifact.createdAt);
          if (protectedIds.has(artifact.id) || !Number.isFinite(elapsed) || elapsed < age || await this.referencesStore.count(artifact.id) > 0) { result.retained++; continue; }
          if (await this.artifacts.delete(artifact.id)) result.deleted.push(artifact.id);
        } catch (error) { result.errors.push({ artifactId: artifact.id, message: error instanceof Error ? error.message : String(error) }); }
      }
      return result;
    });
  }
}
