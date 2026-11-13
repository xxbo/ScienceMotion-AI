import { createHash } from "node:crypto";
import type { ProjectDocument, Revision } from "../contracts/project";

export interface ProjectSnapshot {
  id: string;
  projectId: string;
  schemaVersion: string;
  createdAt: string;
  contentHash: string;
  document: ProjectDocument;
}

export interface SnapshotStore {
  save(document: ProjectDocument, metadata: { id: string; createdAt: string }): ProjectSnapshot;
  get(snapshotId: string): ProjectSnapshot | undefined;
  list(projectId: string): ProjectSnapshot[];
}

export function canonicalProjectJson(document: ProjectDocument): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sort(child)])
      );
    }
    return value;
  };
  return JSON.stringify(sort(document));
}

export function hashProject(document: ProjectDocument): string {
  return createHash("sha256").update(canonicalProjectJson(document)).digest("hex");
}

/** In-memory reference store; production persistence can implement the same interface. */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, ProjectSnapshot>();

  save(document: ProjectDocument, metadata: { id: string; createdAt: string }): ProjectSnapshot {
    if (this.snapshots.has(metadata.id)) throw new Error(`Snapshot already exists: ${metadata.id}`);
    const immutableDocument = structuredClone(document);
    const snapshot: ProjectSnapshot = Object.freeze({
      id: metadata.id,
      projectId: document.project.id,
      schemaVersion: document.schemaVersion,
      createdAt: metadata.createdAt,
      contentHash: hashProject(immutableDocument),
      document: immutableDocument,
    });
    this.snapshots.set(snapshot.id, snapshot);
    return structuredClone(snapshot);
  }

  get(snapshotId: string): ProjectSnapshot | undefined {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  list(projectId: string): ProjectSnapshot[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.projectId === projectId)
      .map((snapshot) => structuredClone(snapshot));
  }

  restore(snapshotId: string): ProjectDocument {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    if (hashProject(snapshot.document) !== snapshot.contentHash) {
      throw new Error(`Snapshot integrity check failed: ${snapshotId}`);
    }
    return structuredClone(snapshot.document);
  }
}

export function appendSnapshotRevision(
  document: ProjectDocument,
  snapshot: ProjectSnapshot,
  metadata: { revisionId: string; createdAt: string; message: string; parentRevisionId?: string }
): ProjectDocument {
  const restored = structuredClone(document);
  const revision: Revision = {
    id: metadata.revisionId,
    parentRevisionId: metadata.parentRevisionId,
    createdAt: metadata.createdAt,
    message: metadata.message,
    author: "ScienceMotion Snapshot",
    snapshotHash: snapshot.contentHash,
  };
  restored.revisions.push(revision);
  restored.project.updatedAt = metadata.createdAt;
  return restored;
}
