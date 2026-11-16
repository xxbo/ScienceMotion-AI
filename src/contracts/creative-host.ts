import type { AgentToolPlugin } from "./agent-plugin";
import type { AgentToolManifest, ToolExecutionRecord, ToolResult, ToolSearchQuery } from "./agent-tool";
import type { ArtifactRecord, ArtifactStore } from "./artifact";
import type { ProjectDocument } from "./project";
import type { ProjectPatchDocument, ProjectPatchResult } from "./project-patch";
import type { ProjectSnapshot } from "../platform/project-snapshots";

export const CREATIVE_PERMISSIONS = [
  "project.read", "project.write", "project.delete", "snapshot.read", "snapshot.write",
  "snapshot.restore", "artifact.read", "artifact.write", "execution.read",
] as const;
export type CreativePermission = typeof CREATIVE_PERMISSIONS[number];
export type SnapshotReceipt = Omit<ProjectSnapshot, "document">;
export type ArtifactUpload = Omit<Parameters<ArtifactStore["put"]>[0], "provenance">;

/** Trusted plugin code receives only these invocation-scoped services, never stores or paths. */
export interface CreativeServices {
  project: {
    read(): Promise<ProjectDocument | undefined>;
    create(document: ProjectDocument): Promise<void>;
    applyPatch(patch: ProjectPatchDocument, message: string): Promise<ProjectPatchResult>;
  };
  snapshots: {
    save(revisionId: string, snapshotId: string): Promise<SnapshotReceipt>;
    read(snapshotId: string): Promise<ProjectSnapshot>;
    restore(snapshotId: string, baseRevisionId: string, message: string): Promise<ProjectDocument>;
  };
  artifacts: {
    put(input: ArtifactUpload): Promise<ArtifactRecord>;
    read(artifactId: string, snapshotId?: string): Promise<{ record: ArtifactRecord; bytes: Uint8Array }>;
  };
  executions: { list(): Promise<ToolExecutionRecord[]> };
}
export interface CreativePluginFactory {
  /** Exact expected identity, supplied by trusted host configuration. No automatic upgrades. */
  id: string;
  version: string;
  create(services: CreativeServices): AgentToolPlugin;
}
export interface CreativeSessionGrant {
  projectId: string;
  /** Both lists default to empty. Omission never means all. */
  permissions?: CreativePermission[];
  toolIds?: string[];
  allowDestructive?: boolean;
  allowHighCost?: boolean;
}
export interface CreativeInvocation {
  toolId: string;
  toolVersion: string;
  input: unknown;
  runId: string;
  callId: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}
export interface CreativeSession {
  readonly projectId: string;
  discover(query?: ToolSearchQuery): Promise<{ tools: AgentToolManifest[]; total: number; limit: number; offset: number }>;
  manifest(toolId: string): Promise<AgentToolManifest | undefined>;
  invoke(call: CreativeInvocation): Promise<ToolResult>;
  /** Revocation stops new calls and signals existing ones. Host close drains real work. */
  revoke(): void;
}
export interface CreativeHostLimits {
  maxConcurrentCalls: number;
  defaultToolConcurrency: number;
  maxTimeoutMs: number;
  maxAttempts: number;
  maxSessions: number;
  maxInputBytes: number;
  maxArtifactBytes: number;
  maxProjectBytes: number;
  maxPatchOperations: number;
}
export interface CreativeHost {
  /** Administrative API: the application, never the AI request, assigns grants. */
  createSession(grant: CreativeSessionGrant): CreativeSession;
  readonly maintenance: {
    collectGarbage(olderThanMs?: number): Promise<{ scanned: number; retained: number; deleted: string[]; errors: Array<{ artifactId: string; message: string }> }>;
    releaseSnapshot(projectId: string, snapshotId: string): Promise<void>;
  };
  status(): { state: "ready" | "draining" | "closed" | "failed"; sessions: number; tools: number };
  /** Stop admission synchronously, drain tools and service work, then close persistent resources. */
  close(): Promise<void>;
}
