import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectDocument } from "../contracts/project";
import {
  hashProject,
  type ProjectSnapshot,
} from "./project-snapshots";

function assertSafeId(id: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error("Snapshot ID contains unsupported path characters");
  }
}

/**
 * Durable local snapshot backend. Writes use a temporary file followed by
 * rename so readers never observe a partially written JSON document.
 * Production object storage/database adapters can implement SnapshotStore.
 */
export interface PersistentSnapshotStore {
  save(document: ProjectDocument, metadata: { id: string; createdAt: string }): Promise<ProjectSnapshot>;
  get(snapshotId: string): Promise<ProjectSnapshot | undefined>;
  list(projectId: string): Promise<ProjectSnapshot[]>;
  restore(snapshotId: string): Promise<ProjectDocument>;
}

export class FileSystemSnapshotStore implements PersistentSnapshotStore {
  constructor(private readonly rootDirectory: string) {}

  async save(
    document: ProjectDocument,
    metadata: { id: string; createdAt: string }
  ): Promise<ProjectSnapshot> {
    assertSafeId(metadata.id);
    await mkdir(this.rootDirectory, { recursive: true });
    const immutableDocument = structuredClone(document);
    const snapshot: ProjectSnapshot = {
      id: metadata.id,
      projectId: document.project.id,
      schemaVersion: document.schemaVersion,
      createdAt: metadata.createdAt,
      contentHash: hashProject(immutableDocument),
      document: immutableDocument,
    };
    const destination = join(this.rootDirectory, `${metadata.id}.json`);
    const temporary = join(this.rootDirectory, `.${metadata.id}.${process.pid}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to persist snapshot ${metadata.id}: ${message}`);
    }
    return structuredClone(snapshot);
  }

  async get(snapshotId: string): Promise<ProjectSnapshot | undefined> {
    assertSafeId(snapshotId);
    try {
      const raw = await readFile(join(this.rootDirectory, `${snapshotId}.json`), "utf8");
      return JSON.parse(raw) as ProjectSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(projectId: string): Promise<ProjectSnapshot[]> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try {
      names = await readdir(this.rootDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const snapshots = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.get(name.slice(0, -5)))
    );
    return snapshots.filter((item): item is ProjectSnapshot => Boolean(item && item.projectId === projectId));
  }

  async restore(snapshotId: string): Promise<ProjectDocument> {
    const snapshot = await this.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    if (hashProject(snapshot.document) !== snapshot.contentHash) {
      throw new Error(`Snapshot integrity check failed: ${snapshotId}`);
    }
    return structuredClone(snapshot.document);
  }
}
