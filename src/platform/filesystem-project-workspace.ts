import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectDocument } from "../contracts/project";
import type { ProjectPatchDocument, ProjectPatchResult } from "../contracts/project-patch";
import type { ProjectRepository } from "./project-repository";
import { applyProjectPatch } from "./project-patches";
import { assertAssetReferences, projectArtifactBindings } from "./project-assets";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { publishLocalFile } from "./local-file-publication";

type Owner = { ownerType: "project" | "snapshot"; ownerId: string };
type RevisionMetadata = { newRevisionId: string; createdAt: string; message: string };
interface WorkspaceState {
  schemaVersion: "1.0.0";
  workspaceId: string;
  projects: ProjectDocument[];
  snapshots: ProjectSnapshot[];
  pending?: { id: string; owners: Owner[] };
}
const digest = (state: WorkspaceState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
const ownerKey = (owner: Owner) => JSON.stringify([owner.ownerType, owner.ownerId]);
const snapshotOwner = (workspaceId: string, snapshot: ProjectSnapshot): Owner => ({ ownerType: "snapshot", ownerId: JSON.stringify([workspaceId, snapshot.projectId, snapshot.id]) });
const assertId = (id: string): void => { if (typeof id !== "string" || !id.trim() || id.includes("\0")) throw new Error("Invalid workspace identity"); };

function assertDocument(document: ProjectDocument): void {
  if (document.schemaVersion !== "1.1.0" || !Array.isArray(document.nodes) || !Array.isArray(document.scenes) || !Array.isArray(document.revisions) || !document.revisions.length) throw new Error("Invalid project document");
  assertId(document.project.id);
  const revisions = new Set<string>();
  for (const revision of document.revisions) { assertId(revision.id); if (revisions.has(revision.id)) throw new Error("Duplicate project revision"); revisions.add(revision.id); }
  projectArtifactBindings(document); assertAssetReferences(document);
  // Concrete graph/schema validation is also performed by the host's existing validator.
}
function assertState(state: WorkspaceState): void {
  if (state.schemaVersion !== "1.0.0" || !Array.isArray(state.projects) || !Array.isArray(state.snapshots)) throw new Error("Unsupported project workspace ledger");
  assertId(state.workspaceId);
  const projects = new Set<string>(); const snapshots = new Set<string>();
  for (const project of state.projects) {
    assertDocument(project); if (projects.has(project.project.id)) throw new Error("Duplicate workspace project"); projects.add(project.project.id);
  }
  for (const snapshot of state.snapshots) {
    assertId(snapshot.id); assertDocument(snapshot.document);
    if (snapshots.has(snapshot.id) || !projects.has(snapshot.projectId) || snapshot.projectId !== snapshot.document.project.id ||
        snapshot.schemaVersion !== snapshot.document.schemaVersion || snapshot.contentHash !== hashProject(snapshot.document)) throw new Error("Snapshot integrity check failed");
    snapshots.add(snapshot.id);
  }
  if (state.pending) {
    assertId(state.pending.id);
    if (!Array.isArray(state.pending.owners)) throw new Error("Invalid workspace recovery intent");
    for (const owner of state.pending.owners) {
      if (owner.ownerType !== "project" && owner.ownerType !== "snapshot") throw new Error("Invalid workspace recovery owner");
      assertId(owner.ownerId);
    }
  }
}

/**
 * One POSIX local writer. Canonical ProjectDocuments + retained ProjectSnapshots,
 * with an intent/pin/publish/reconcile protocol. Related host code must share one
 * lifecycle manager/reference store and never bypass it with raw blob deletion.
 */
export class FileSystemProjectWorkspace implements ProjectRepository {
  private closed = false;
  private poisoned = false;
  private tail: Promise<void> = Promise.resolve();
  private constructor(
    private readonly directory: string,
    private readonly lock: FileHandle,
    private readonly lifecycle: LocalArtifactLifecycleManager,
    private state: WorkspaceState,
  ) {}

  static async open(directory: string, lifecycle: LocalArtifactLifecycleManager): Promise<FileSystemProjectWorkspace> {
    const root = resolve(directory); await mkdir(root, { recursive: true });
    const lock = await open(join(root, "writer.lock"), "wx", 0o600);
    const workspace = new FileSystemProjectWorkspace(root, lock, lifecycle, {
      schemaVersion: "1.0.0", workspaceId: randomUUID(), projects: [], snapshots: [],
    });
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() })); await lock.sync();
      let raw: string | undefined;
      try { raw = await readFile(join(root, "workspace.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (raw !== undefined) {
        const envelope = JSON.parse(raw) as { state: WorkspaceState; contentHash: string };
        if (!envelope.state || digest(envelope.state) !== envelope.contentHash) throw new Error("Project workspace integrity check failed");
        assertState(envelope.state); workspace.state = envelope.state;
      } else await workspace.writeState(workspace.state);
      await workspace.recover();
      return workspace;
    } catch (error) { await workspace.close(); throw error; }
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; }); await previous;
    try { return await operation(); } finally { release(); }
  }
  private assertUsable(): void {
    if (this.closed) throw new Error("Project workspace is closed");
    if (this.poisoned) throw new Error("Project workspace recovery required; close and reopen before further operations");
  }
  private async writeState(state: WorkspaceState): Promise<void> {
    assertState(state);
    await publishLocalFile(join(this.directory, "workspace.json"), JSON.stringify({ state, contentHash: digest(state) }));
    this.state = structuredClone(state);
  }
  private documents(state: WorkspaceState): Array<{ owner: Owner; document: ProjectDocument }> {
    return [
      ...state.projects.map((document) => ({ owner: { ownerType: "project" as const, ownerId: document.project.id }, document })),
      ...state.snapshots.map((snapshot) => ({ owner: snapshotOwner(state.workspaceId, snapshot), document: snapshot.document })),
    ];
  }
  private async verify(state: WorkspaceState): Promise<void> {
    for (const entry of this.documents(state)) await this.lifecycle.verifyProjectArtifacts(entry.document);
  }
  /** The published head is authoritative. Recovery adds needed pins before removing stale pins. */
  private async recover(): Promise<void> {
    await this.verify(this.state); // Missing/corrupt bytes fail closed before any reference cleanup.
    const documents = this.documents(this.state); const activeOwners = new Set(documents.map((item) => ownerKey(item.owner)));
    for (const entry of documents) {
      const result = await this.lifecycle.reconcileOwner(entry.document, entry.owner, `workspace:${this.state.workspaceId}:asset:`);
      if (result.missingArtifacts.length) throw new Error("Missing artifacts during workspace recovery");
    }
    const pending = this.state.pending;
    if (!pending) return;
    for (const owner of pending.owners) if (!activeOwners.has(ownerKey(owner))) await this.lifecycle.releaseOwner(owner, `workspace:${this.state.workspaceId}:asset:`);
    await this.lifecycle.releaseOwner({ ownerType: "transaction", ownerId: JSON.stringify([this.state.workspaceId, pending.id]) });
    const clean = structuredClone(this.state); delete clean.pending; await this.writeState(clean);
  }
  private async commit(next: WorkspaceState): Promise<void> {
    this.assertUsable(); assertState(next);
    await this.verify(next); // Validation failure changes neither ledger nor references.
    const owners = new Map([...this.documents(this.state), ...this.documents(next)].map((entry) => [ownerKey(entry.owner), entry.owner]));
    const pending = { id: randomUUID(), owners: [...owners.values()] };
    try {
      await this.writeState({ ...this.state, pending }); // Durable intent, old heads remain authoritative.
      const required = new Set(this.documents(next).flatMap((entry) => projectArtifactBindings(entry.document).map((binding) => binding.artifactId)));
      for (const artifactId of required) await this.lifecycle.attach({ artifactId, ownerType: "transaction", ownerId: JSON.stringify([this.state.workspaceId, pending.id]), role: "pending" });
      await this.writeState({ ...next, pending }); // Atomic publication of new heads + retained snapshots.
      await this.recover(); // Establish permanent references, clean old ones, release temporary pins.
    } catch (error) {
      this.poisoned = true;
      throw new Error(`Project commit requires recovery (publication may have occurred): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private current(projectId: string, revisionId?: string): ProjectDocument {
    const project = this.state.projects.find((item) => item.project.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (revisionId !== undefined && project.revisions.at(-1)?.id !== revisionId) throw new Error("Revision conflict: project has changed");
    return project;
  }
  async get(projectId: string): Promise<ProjectDocument | undefined> {
    return this.exclusive(async () => { this.assertUsable(); const project = this.state.projects.find((item) => item.project.id === projectId); return project ? structuredClone(project) : undefined; });
  }
  async create(project: ProjectDocument): Promise<void> {
    const copy = structuredClone(project);
    await this.exclusive(async () => {
      this.assertUsable(); assertDocument(copy);
      if (this.state.projects.some((item) => item.project.id === copy.project.id)) throw new Error("Project already exists");
      const next = structuredClone(this.state); next.projects.push(copy); await this.commit(next);
    });
  }
  async applyPatch(projectId: string, patch: ProjectPatchDocument, metadata: RevisionMetadata): Promise<ProjectPatchResult> {
    const change = structuredClone(patch); const meta = structuredClone(metadata);
    return this.exclusive(async () => {
      this.assertUsable(); const project = this.current(projectId, change.baseRevisionId);
      const result = applyProjectPatch(project, change, { currentRevisionId: project.revisions.at(-1)!.id, ...meta });
      const next = structuredClone(this.state); next.projects = next.projects.map((item) => item.project.id === projectId ? result.project : item);
      await this.commit(next); return structuredClone(result);
    });
  }
  async saveSnapshot(projectId: string, revisionId: string, metadata: { id: string; createdAt: string }): Promise<ProjectSnapshot> {
    const meta = structuredClone(metadata);
    return this.exclusive(async () => {
      this.assertUsable(); assertId(meta.id);
      if (!Number.isFinite(Date.parse(meta.createdAt))) throw new Error("Invalid snapshot time");
      const project = this.current(projectId, revisionId);
      if (this.state.snapshots.some((item) => item.id === meta.id)) throw new Error("Snapshot already exists");
      const snapshot: ProjectSnapshot = { ...meta, projectId, schemaVersion: project.schemaVersion, contentHash: hashProject(project), document: structuredClone(project) };
      const next = structuredClone(this.state); next.snapshots.push(snapshot); await this.commit(next); return structuredClone(snapshot);
    });
  }
  async getSnapshot(snapshotId: string): Promise<ProjectSnapshot | undefined> {
    return this.exclusive(async () => {
      this.assertUsable(); const snapshot = this.state.snapshots.find((item) => item.id === snapshotId);
      if (!snapshot) return undefined;
      await this.lifecycle.verifyProjectArtifacts(snapshot.document); return structuredClone(snapshot);
    });
  }
  async releaseSnapshot(snapshotId: string): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertUsable(); if (!this.state.snapshots.some((item) => item.id === snapshotId)) return false;
      const next = structuredClone(this.state); next.snapshots = next.snapshots.filter((item) => item.id !== snapshotId);
      await this.commit(next); return true;
    });
  }
  async restoreSnapshot(snapshotId: string, baseRevisionId: string, metadata: RevisionMetadata): Promise<ProjectDocument> {
    const meta = structuredClone(metadata);
    return this.exclusive(async () => {
      this.assertUsable(); const snapshot = this.state.snapshots.find((item) => item.id === snapshotId);
      if (!snapshot) throw new Error("Snapshot not found");
      const current = this.current(snapshot.projectId, baseRevisionId); assertId(meta.newRevisionId);
      if (current.revisions.some((revision) => revision.id === meta.newRevisionId)) throw new Error("Revision already exists");
      const restored = structuredClone(snapshot.document);
      restored.project.updatedAt = meta.createdAt;
      restored.revisions = [...structuredClone(current.revisions), { id: meta.newRevisionId, parentRevisionId: baseRevisionId, createdAt: meta.createdAt, message: meta.message, snapshotHash: snapshot.contentHash, author: "ScienceMotion Snapshot" }];
      const next = structuredClone(this.state); next.projects = next.projects.map((item) => item.project.id === snapshot.projectId ? restored : item);
      await this.commit(next); return structuredClone(restored);
    });
  }
  async collectGarbage(options: Parameters<LocalArtifactLifecycleManager["collectGarbage"]>[0] = {}) {
    const copy = structuredClone(options);
    return this.exclusive(async () => { this.assertUsable(); return this.lifecycle.collectGarbage(copy); });
  }
  /** Stop/drain Gateway calls before closing. Never automatically steal another writer's lock. */
  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (this.closed) return; this.closed = true; await this.lock.close(); await rm(join(this.directory, "writer.lock"));
    });
  }
}
