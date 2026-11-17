import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AgentToolPlugin, PluginOperationResult } from "../contracts/agent-plugin";
import type { AgentToolGateway, AgentToolManifest, AgentToolRegistry, ToolCallContext, ToolExecutionRecord, ToolResult } from "../contracts/agent-tool";
import type { ArtifactRecord, ArtifactStore } from "../contracts/artifact";
import { CREATIVE_PERMISSIONS, type CreativeHost, type CreativeHostLimits, type CreativeInvocation,
  type CreativePermission, type CreativePluginFactory, type CreativeServices, type CreativeSession,
  type CreativeSessionGrant } from "../contracts/creative-host";
import type { ProjectDocument } from "../contracts/project";
import type { ProjectPatchDocument, ProjectPatchResult } from "../contracts/project-patch";
import type { ProjectSnapshot } from "./project-snapshots";
import { applyProjectPatch } from "./project-patches";
import { assertCreativeDocument, assertFiniteJson } from "./project-creative-edits";
import { projectArtifactBindings } from "./project-assets";
import { hashProject } from "./project-snapshots";
import type { ProjectGraphRenderOutput, ProjectGraphRenderRequest } from "../contracts/renderer";
import { inspectProjectSnapshot, SnapshotInspectionError } from "./snapshot-inspection";
import { finishLayoutInspection, prepareLayoutInspection } from "./snapshot-layout-inspection";
import type { ProjectGraphLayoutRequest } from "../contracts/renderer";
import type { LayoutFrameMeasurement } from "../contracts/layout-inspection";
import type { RenderJobStore, RenderJobSubmission } from "../contracts/render-job";
import type { CreativeJobPolicy } from "../contracts/creative-jobs";
import { CreativeRenderJobController } from "./creative-render-jobs";

type Revision = { newRevisionId: string; createdAt: string; message: string };
type Reference = { artifactId: string; ownerType: string; ownerId: string; role: string };
/** Internal composition port. Production binds the existing Workspace/Registry/Gateway, not substitutes. */
export interface CreativeHostRuntime {
  jobs: RenderJobStore;
  rendererIdentity: RenderJobSubmission["renderer"];
  projects: {
    get(id: string): Promise<ProjectDocument | undefined>;
    create(document: ProjectDocument): Promise<void>;
    applyPatch(id: string, patch: ProjectPatchDocument, metadata: Revision): Promise<ProjectPatchResult>;
    saveSnapshot(projectId: string, revisionId: string, metadata: { id: string; createdAt: string }): Promise<ProjectSnapshot>;
    getSnapshot(id: string): Promise<ProjectSnapshot | undefined>;
    restoreSnapshot(id: string, baseRevisionId: string, metadata: Revision): Promise<ProjectDocument>;
    releaseSnapshot(id: string): Promise<boolean>;
    collectGarbage(options?: { olderThanMs?: number }): ReturnType<CreativeHost["maintenance"]["collectGarbage"]>;
  };
  artifacts: Pick<ArtifactStore, "put" | "get" | "read">;
  renderPreview(request: ProjectGraphRenderRequest & { frame: number }): Promise<ProjectGraphRenderOutput>;
  renderVideo(request: ProjectGraphRenderRequest & { startFrame: number; durationFrames: number }): Promise<ProjectGraphRenderOutput>;
  measureLayout?(request: ProjectGraphLayoutRequest): Promise<LayoutFrameMeasurement[]>;
  references(id: string): Promise<Reference[]>;
  retain(reference: Reference): Promise<void>;
  listExecutions(projectId: string): Promise<ToolExecutionRecord[]>;
  validateProject(document: ProjectDocument): void;
  validatePatch(patch: ProjectPatchDocument): void;
  validatePlugin(plugin: AgentToolPlugin): void;
  configurePlugins(plugins: AgentToolPlugin[]): Promise<AgentToolRegistry>;
  plugins: Omit<CreativeHost["plugins"], "install"> & { install(plugin: AgentToolPlugin): PluginOperationResult };
  gateway(grant: CreativeSessionGrant, limits: CreativeHostLimits): AgentToolGateway & { shutdown(): Promise<void> };
  close(): Promise<void>;
}
export const DEFAULT_CREATIVE_HOST_LIMITS: Readonly<CreativeHostLimits> = Object.freeze({
  maxConcurrentCalls: 8, defaultToolConcurrency: 2, maxTimeoutMs: 30_000, maxAttempts: 1,
  maxSessions: 32, maxInputBytes: 1024 * 1024, maxArtifactBytes: 32 * 1024 * 1024,
  maxProjectBytes: 8 * 1024 * 1024, maxPatchOperations: 256,
});
export class CreativeHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CreativeHostError"; }
}
function fail(code: string, message: string): never { throw new CreativeHostError(code, message); }
const failure = (code: string, message: string): ToolResult => ({ ok: false, diagnostics: [{ level: "error", code, message }] });
const identity = (value: string): void => {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0")) fail("HOST_ID_INVALID", "Invalid bounded identity");
};
const exactKeys = (object: object, keys: readonly string[]): void => {
  if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some((key) => !keys.includes(key))) fail("HOST_INPUT_INVALID", "Unexpected fields");
};
function jsonCopy<T>(value: T, limit: number): T {
  assertFiniteJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > limit) fail("HOST_INPUT_TOO_LARGE", "JSON exceeds the configured byte limit");
  return structuredClone(value);
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
export function resolveCreativeLimits(input: Partial<CreativeHostLimits> = {}): CreativeHostLimits {
  exactKeys(input, Object.keys(DEFAULT_CREATIVE_HOST_LIMITS));
  const limits = { ...DEFAULT_CREATIVE_HOST_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) fail("HOST_POLICY_INVALID", `Invalid ${name}`);
  }
  if (limits.maxAttempts > 5 || limits.defaultToolConcurrency > limits.maxConcurrentCalls) fail("HOST_POLICY_INVALID", "Invalid retry/concurrency policy");
  return limits;
}
function permissions(values: readonly string[]): Set<CreativePermission> {
  if (!Array.isArray(values) || values.some((v) => !(CREATIVE_PERMISSIONS as readonly string[]).includes(v))) fail("HOST_PERMISSION_UNKNOWN", "Unknown host permission; wildcards are not accepted");
  return new Set(values as CreativePermission[]);
}
interface SessionState {
  grant: Readonly<CreativeSessionGrant>;
  permissions: Set<CreativePermission>;
  tools: Set<string>;
  abort: AbortController;
  gateway: ReturnType<CreativeHostRuntime["gateway"]>;
}
interface Scope {
  session: SessionState;
  context: ToolCallContext;
  pluginPermissions: Set<CreativePermission>;
  manifest: AgentToolManifest;
  accepting: boolean;
  active: boolean;
  pending: Set<Promise<unknown>>;
  errors: unknown[];
  produced: Set<string>;
  snapshotAssets: Set<string>;
  writesStarted: boolean;
  revisionIndex: number;
}

/** Service authorization is independent of tool permission hints and is checked on each actual use. */
export async function assembleCreativeHost(runtime: CreativeHostRuntime, factories: readonly CreativePluginFactory[],
  options: { limits?: Partial<CreativeHostLimits>; renderJobs?: Partial<CreativeJobPolicy> } = {}): Promise<CreativeHost> {
  let limits: CreativeHostLimits;
  try { limits = resolveCreativeLimits(options.limits); }
  catch (error) { await runtime.close(); throw error; }
  const calls = new AsyncLocalStorage<SessionState>();
  const scopes = new AsyncLocalStorage<Scope>();
  let state: ReturnType<CreativeHost["status"]>["state"] = "ready";
  const sessions: SessionState[] = [];
  const gateways = new Set<ReturnType<CreativeHostRuntime["gateway"]>>();
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let transition: Promise<PluginOperationResult> | undefined;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work); tail = result.then(() => undefined, () => undefined); return result;
  };
  const check = (scope: Scope | undefined, required: CreativePermission[], destructive = false): Scope => {
    if (!scope?.active || scope.session.abort.signal.aborted || scope.context.signal?.aborted || state === "closed" || state === "failed") fail("HOST_CAPABILITY_EXPIRED", "Service requires a live, authorized invocation");
    for (const p of required) if (!scope.session.permissions.has(p) || !scope.pluginPermissions.has(p) || !(scope.manifest.execution.permissions ?? []).includes(p)) fail("HOST_PERMISSION_DENIED", `Service requires ${p} in session, plugin and tool grants`);
    if (destructive && (!scope.session.grant.allowDestructive || !scope.manifest.execution.destructive)) fail("HOST_APPROVAL_REQUIRED", "Destructive service requires explicit host and tool authorization");
    return scope;
  };
  const task = <T>(required: CreativePermission[], work: (scope: Scope) => Promise<T>, destructive = false): Promise<T> => {
    const scope = scopes.getStore(); const admitted = scope?.accepting === true;
    const promise = serial(async () => {
      if (!admitted) fail("HOST_CAPABILITY_EXPIRED", "Service call was made outside tool execution");
      return work(check(scope, required, destructive));
    });
    if (scope) {
      scope.pending.add(promise);
      void promise.then(() => scope.pending.delete(promise), (error) => { scope.pending.delete(promise); scope.errors.push(error); });
    } else void promise.catch(() => undefined);
    return promise;
  };
  const document = (value: ProjectDocument): ProjectDocument => {
    const copy = jsonCopy(value, limits.maxProjectBytes); runtime.validateProject(copy); assertCreativeDocument(copy); return copy;
  };
  const bound = (value: ProjectDocument, scope: Scope): void => {
    if (value.project.id !== scope.context.projectId) fail("HOST_PROJECT_DENIED", "Project is outside this session");
  };
  const revision = (scope: Scope, message: string): Revision => {
    if (typeof message !== "string" || !message.trim() || message.length > 1024) fail("HOST_INPUT_INVALID", "Revision message is required and bounded");
    const hash = createHash("sha256").update(JSON.stringify([scope.context.projectId, scope.context.runId, scope.context.callId, scope.revisionIndex++])).digest("hex");
    return { newRevisionId: `revision-host-${hash}`, createdAt: new Date().toISOString(), message };
  };
  const allowedArtifact = async (scope: Scope, id: string): Promise<void> => {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) fail("HOST_ARTIFACT_INVALID", "Invalid artifact identity");
    if (scope.produced.has(id) || scope.snapshotAssets.has(id)) return;
    const current = await runtime.projects.get(scope.context.projectId);
    if (current && projectArtifactBindings(current).some((b) => b.artifactId === id)) return;
    for (const ref of await runtime.references(id)) {
      if (ref.ownerType !== "tool-run" || !["host-output", "host-input"].includes(ref.role)) continue;
      try {
        const owner = JSON.parse(ref.ownerId);
        if (Array.isArray(owner) && owner.length === 3 && owner[0] === scope.context.projectId) return;
      } catch { /* Legacy identities are not proof of project ownership. */ }
    }
    fail("HOST_ARTIFACT_DENIED", "Artifact has no authorized project or invocation ownership");
  };
  const scopedRecord = (scope: Scope, record: ArtifactRecord): ArtifactRecord => {
    const copy = structuredClone(record);
    // One content blob can be shared, but first-writer metadata is not a cross-project grant.
    if (copy.provenance?.projectId && copy.provenance.projectId !== scope.context.projectId) {
      delete copy.provenance; delete copy.metadata; delete copy.license; delete copy.attribution;
    }
    return copy;
  };
  const checkedArtifact = async (scope: Scope, id: string): Promise<{ record: ArtifactRecord; bytes: Uint8Array }> => {
    await allowedArtifact(scope, id);
    const record = await runtime.artifacts.get(id); const bytes = await runtime.artifacts.read(id);
    if (!record || !bytes || record.id !== id || record.uri !== `artifact://sha256/${id.slice(7)}` || record.contentHash !== id.slice(7) || record.sizeBytes !== bytes.byteLength || createHash("sha256").update(bytes).digest("hex") !== record.contentHash) fail("HOST_ARTIFACT_CORRUPT", "Artifact metadata or bytes failed integrity validation");
    return { record: scopedRecord(scope, record), bytes: new Uint8Array(bytes) };
  };
  const retainOutput = async (scope: Scope, id: string, role = "host-output"): Promise<void> => {
    await runtime.retain({ artifactId: id, ownerType: "tool-run", ownerId: JSON.stringify([scope.context.projectId, scope.context.runId, scope.context.callId]), role });
  };
  const verifyNewAssets = async (scope: Scope, next: ProjectDocument, previous?: ProjectDocument): Promise<void> => {
    const before = new Set(previous ? projectArtifactBindings(previous).map((b) => b.artifactId) : []);
    for (const b of projectArtifactBindings(next)) if (!before.has(b.artifactId)) {
      if (!scope.produced.has(b.artifactId)) check(scope, ["artifact.read"]);
      await checkedArtifact(scope, b.artifactId);
    }
  };
  const snapshot = async (scope: Scope, id: string): Promise<ProjectSnapshot> => {
    identity(id); const saved = await runtime.projects.getSnapshot(id);
    if (!saved || saved.projectId !== scope.context.projectId) fail("HOST_SNAPSHOT_DENIED", "Snapshot is outside this session or missing");
    document(saved.document); bound(saved.document, scope);
    return saved;
  };
  const publishRenderArtifact = async (scope: Scope, output: ProjectGraphRenderOutput, metadata: Record<string, unknown>): Promise<ArtifactRecord> => {
    // A renderer that settles after cancellation must not publish new artifact bytes.
    check(scope, ["snapshot.read", "artifact.write"]);
    if (!(output.bytes instanceof Uint8Array) || output.bytes.byteLength < 8 || output.bytes.byteLength > limits.maxArtifactBytes) fail("HOST_RENDER_OUTPUT_INVALID", "Renderer returned empty or oversized output bytes");
    const expected = output.mediaType === "image/png" ? { kind: "image" as const, extension: "png" } : output.mediaType === "video/mp4" ? { kind: "video" as const, extension: "mp4" } : undefined;
    if (!expected || output.extension !== expected.extension || !output.rendererId || !output.rendererVersion) fail("HOST_RENDER_OUTPUT_INVALID", "Renderer returned an unsupported or inconsistent output declaration");
    scope.writesStarted = true;
    const renderMetadata = { ...metadata, rendererId: output.rendererId, rendererVersion: output.rendererVersion,
      ...(output.execution ? { execution: jsonCopy(output.execution, limits.maxInputBytes) } : {}) };
    const provenance = { projectId: scope.context.projectId, runId: scope.context.runId, callId: scope.context.callId, toolId: scope.manifest.id,
      toolVersion: scope.manifest.version, pluginId: scope.manifest.pluginId, parametersHash: createHash("sha256").update(JSON.stringify(metadata)).digest("hex") };
    const stored = await runtime.artifacts.put({ bytes: new Uint8Array(output.bytes), kind: expected.kind, mediaType: output.mediaType, extension: expected.extension,
      metadata: renderMetadata, provenance });
    check(scope, ["snapshot.read", "artifact.write"]);
    if (stored.kind !== expected.kind || stored.mediaType !== output.mediaType) fail("HOST_ARTIFACT_TYPE_CONFLICT", "Render artifact content hash collides with another media declaration");
    scope.produced.add(stored.id);
    // Blob identity is shared; render evidence belongs to this invocation, even for identical pixels.
    // Preserve immutable first-writer storage metadata and redact foreign metadata before returning.
    return { ...scopedRecord(scope, stored), metadata: structuredClone(renderMetadata), provenance: structuredClone(provenance) };
  };
  const services: CreativeServices = frozen({
    project: {
      read: () => task(["project.read"], async (scope) => {
        const current = await runtime.projects.get(scope.context.projectId); return current ? document(current) : undefined;
      }),
      create: (input: ProjectDocument) => {
        // Clone before the first asynchronous operation; a plugin cannot alter queued input.
        let copy: ProjectDocument;
        try { copy = document(input); } catch (error) { return task(["project.write"], async () => { throw error; }); }
        return task(["project.write"], async (scope) => { bound(copy, scope); await verifyNewAssets(scope, copy); check(scope, ["project.write"]); scope.writesStarted = true; await runtime.projects.create(copy); });
      },
      applyPatch: (input: ProjectPatchDocument, message: string) => {
        let patch: ProjectPatchDocument;
        try { patch = jsonCopy(input, limits.maxInputBytes); runtime.validatePatch(patch); } catch (error) { return task(["project.read", "project.write"], async () => { throw error; }); }
        return task(["project.read", "project.write"], async (scope) => {
          if (patch.projectId !== scope.context.projectId) fail("HOST_PROJECT_DENIED", "Patch is outside this session");
          if (patch.patches.length > limits.maxPatchOperations) fail("HOST_PATCH_TOO_LARGE", "Too many patch operations");
          if (patch.patches.some((op) => op.op.startsWith("remove-"))) check(scope, ["project.delete"], true);
          const current = await runtime.projects.get(scope.context.projectId);
          if (!current) fail("HOST_PROJECT_MISSING", "Create the project before editing");
          const metadata = revision(scope, message);
          const preview = applyProjectPatch(current, patch, { ...metadata, currentRevisionId: current.revisions.at(-1)!.id });
          document(preview.project); await verifyNewAssets(scope, preview.project, current);
          check(scope, ["project.read", "project.write"]); scope.writesStarted = true;
          return runtime.projects.applyPatch(scope.context.projectId, patch, metadata);
        });
      },
    },
    snapshots: {
      save: (revisionId: string, id: string) => task(["project.read", "snapshot.write"], async (scope) => {
        identity(id); identity(revisionId); const current = await runtime.projects.get(scope.context.projectId);
        if (!current) fail("HOST_PROJECT_MISSING", "Project not found"); document(current);
        check(scope, ["project.read", "snapshot.write"]); scope.writesStarted = true;
        const { document: _document, ...receipt } = await runtime.projects.saveSnapshot(scope.context.projectId, revisionId, { id, createdAt: new Date().toISOString() });
        return receipt;
      }),
      read: (id: string) => task(["snapshot.read"], async (scope) => {
        const saved = await snapshot(scope, id);
        for (const b of projectArtifactBindings(saved.document)) { scope.snapshotAssets.add(b.artifactId); await retainOutput(scope, b.artifactId, "host-input"); }
        return structuredClone(saved);
      }),
      restore: (id: string, base: string, message: string) => task(["project.write", "snapshot.restore"], async (scope) => {
        identity(base); await snapshot(scope, id); const metadata = revision(scope, message);
        check(scope, ["project.write", "snapshot.restore"], true); scope.writesStarted = true; return runtime.projects.restoreSnapshot(id, base, metadata);
      }, true),
    },
    artifacts: {
      put: (input) => {
        let copy: typeof input;
        try {
          exactKeys(input, ["bytes", "kind", "mediaType", "extension", "metadata", "license", "attribution"]);
          if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > limits.maxArtifactBytes) fail("HOST_ARTIFACT_TOO_LARGE", "Artifact byte limit exceeded or bytes invalid");
          const { bytes, ...meta } = input; jsonCopy(meta, limits.maxInputBytes);
          if (!["image", "video", "audio", "model", "texture", "document", "data", "other"].includes(meta.kind) || typeof meta.mediaType !== "string" || !meta.mediaType.trim()) fail("HOST_ARTIFACT_INVALID", "Invalid artifact type");
          copy = { ...structuredClone(meta), bytes: new Uint8Array(bytes) };
        } catch (error) { return task(["artifact.write"], async () => { throw error; }); }
        return task(["artifact.write"], async (scope) => {
          scope.writesStarted = true;
          const stored = await runtime.artifacts.put({ ...copy, provenance: { projectId: scope.context.projectId, runId: scope.context.runId,
            callId: scope.context.callId, toolId: scope.manifest.id, toolVersion: scope.manifest.version, pluginId: scope.manifest.pluginId } });
          if (stored.kind !== copy.kind || stored.mediaType !== copy.mediaType) fail("HOST_ARTIFACT_TYPE_CONFLICT", "Existing content has a different media declaration");
          scope.produced.add(stored.id); await retainOutput(scope, stored.id);
          return scopedRecord(scope, stored);
        });
      },
      read: (id: string, snapshotId?: string) => task(["artifact.read"], async (scope) => {
        if (snapshotId !== undefined) { check(scope, ["snapshot.read"]); const saved = await snapshot(scope, snapshotId);
          projectArtifactBindings(saved.document).forEach((b) => scope.snapshotAssets.add(b.artifactId));
        }
        const content = await checkedArtifact(scope, id); await retainOutput(scope, id, "host-input"); return content;
      }),
    },
    render: {
      preview: (snapshotId: string, frame: number, sceneId?: string) => task(["snapshot.read", "artifact.write"], async (scope) => {
        identity(snapshotId);
        if (!Number.isSafeInteger(frame) || frame < 0) fail("HOST_RENDER_FRAME_INVALID", "Preview frame must be a non-negative integer");
        const saved = await snapshot(scope, snapshotId);
        if (hashProject(saved.document) !== saved.contentHash) fail("HOST_SNAPSHOT_CORRUPT", "Snapshot content hash does not match its immutable document");
        const sequence = saved.document.sequences[0];
        if (!sequence || frame >= sequence.durationFrames) fail("HOST_RENDER_FRAME_INVALID", "Preview frame is outside the sequence");
        if (sceneId && !saved.document.scenes.some((item) => item.id === sceneId)) fail("HOST_RENDER_SCENE_INVALID", "Requested scene is not part of the snapshot");
        const revisionId = saved.document.revisions.at(-1)?.id;
        if (!revisionId) fail("HOST_SNAPSHOT_INVALID", "Snapshot has no revision identity");
        const output = await runtime.renderPreview({ project: structuredClone(saved.document), revisionId, snapshotHash: saved.contentHash,
          sceneId, frame, profile: { width: sequence.width, height: sequence.height, fps: sequence.fps },
          signal: AbortSignal.any([scope.session.abort.signal, ...(scope.context.signal ? [scope.context.signal] : [])]) });
        return publishRenderArtifact(scope, output, { snapshotId, revisionId, snapshotHash: saved.contentHash, frame, ...(sceneId ? { sceneId } : {}),
          width: sequence.width, height: sequence.height, fps: sequence.fps });
      }),
      video: (snapshotId: string, startFrame: number, durationFrames: number, sceneId?: string) => task(["snapshot.read", "artifact.write"], async (scope) => {
        identity(snapshotId);
        if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > 900)
          fail("HOST_RENDER_RANGE_INVALID", "Video render range must be 1–900 frames with a non-negative start");
        const saved = await snapshot(scope, snapshotId);
        if (hashProject(saved.document) !== saved.contentHash) fail("HOST_SNAPSHOT_CORRUPT", "Snapshot content hash does not match its immutable document");
        const sequence = saved.document.sequences[0];
        if (!sequence || startFrame + durationFrames > sequence.durationFrames) fail("HOST_RENDER_RANGE_INVALID", "Video render range exceeds the sequence");
        if (sceneId && !saved.document.scenes.some((item) => item.id === sceneId)) fail("HOST_RENDER_SCENE_INVALID", "Requested scene is not part of the snapshot");
        const revisionId = saved.document.revisions.at(-1)?.id;
        if (!revisionId) fail("HOST_SNAPSHOT_INVALID", "Snapshot has no revision identity");
        const output = await runtime.renderVideo({ project: structuredClone(saved.document), revisionId, snapshotHash: saved.contentHash,
          sceneId, startFrame, durationFrames, profile: { width: sequence.width, height: sequence.height, fps: sequence.fps },
          signal: AbortSignal.any([scope.session.abort.signal, ...(scope.context.signal ? [scope.context.signal] : [])]) });
        return publishRenderArtifact(scope, output, { snapshotId, revisionId, snapshotHash: saved.contentHash, startFrame, durationFrames, ...(sceneId ? { sceneId } : {}),
          width: sequence.width, height: sequence.height, fps: sequence.fps });
      }),
    },
    inspect: {
      layout: (snapshotId: string, frames?: readonly number[]) => {
        const selected = frames === undefined ? undefined : structuredClone(frames);
        return task(["snapshot.read"], async (scope) => {
          const started = performance.now();
          const saved = await snapshot(scope, snapshotId);
          try {
            const prepared = prepareLayoutInspection(saved, selected);
            if (!runtime.measureLayout) fail("HOST_LAYOUT_UNAVAILABLE", "The selected renderer does not support browser layout inspection");
            const measured = await runtime.measureLayout({ project: structuredClone(saved.document), snapshotHash: saved.contentHash,
              revisionId: saved.document.revisions.at(-1)!.id, frames: prepared.frames,
              signal: AbortSignal.any([scope.session.abort.signal, ...(scope.context.signal ? [scope.context.signal] : [])]) });
            check(scope, ["snapshot.read"]);
            return jsonCopy(finishLayoutInspection(saved, prepared, measured, performance.now() - started), limits.maxProjectBytes);
          } catch (error) {
            if (error instanceof SnapshotInspectionError) fail(error.code, error.message);
            throw error;
          }
        });
      },
      snapshot: (snapshotId: string, frames?: readonly number[]) => {
        // Copy before queued service execution; plugins cannot change the selected frames after admission.
        const selected = frames === undefined ? undefined : structuredClone(frames);
        return task(["snapshot.read"], async (scope) => {
          const saved = await snapshot(scope, snapshotId);
          try { return jsonCopy(inspectProjectSnapshot(saved, selected), limits.maxProjectBytes); }
          catch (error) {
            if (error instanceof SnapshotInspectionError) fail(error.code, error.message);
            throw error;
          }
        });
      },
    },
    executions: { list: () => task(["execution.read"], async (scope) => {
      // The evidence store keeps optional undefined fields in its live in-memory view.
      // Use its persisted JSON representation at the agent transport boundary, then bound/validate it.
      const records = await runtime.listExecutions(scope.context.projectId);
      return jsonCopy(JSON.parse(JSON.stringify(records)) as ToolExecutionRecord[], limits.maxProjectBytes);
    }) },
  });

  let registry: AgentToolRegistry;
  const catalogue = new Map<string, AgentToolManifest>();
  let catalogueGeneration = 0;
  const installed = new Map<string, AgentToolPlugin>();
  const activePlugins = new Map<string, AgentToolPlugin>();
  const toolOwners = new Map<string, string>();
  const pluginKey = (id: string, version: string) => JSON.stringify([id, version]);
  const preparePlugin = (factory: CreativePluginFactory): AgentToolPlugin => {
      identity(factory.id); identity(factory.version);
      const plugin = factory.create(services); runtime.validatePlugin(plugin);
      if (plugin.manifest.id !== factory.id || plugin.manifest.version !== factory.version) fail("HOST_PLUGIN_IDENTITY", "Plugin factory differs from the configured exact identity");
      const pluginPermissions = permissions(plugin.manifest.permissions ?? []);
      const toolIds = new Set<string>();
      return { manifest: structuredClone(plugin.manifest), healthCheck: plugin.healthCheck?.bind(plugin), tools: plugin.tools.map((tool) => {
        if (tool.manifest.pluginId && tool.manifest.pluginId !== factory.id) fail("HOST_PLUGIN_IDENTITY", "Tool declares another plugin owner");
        const declared = permissions(tool.manifest.execution.permissions ?? []);
        if ([...declared].some((p) => !pluginPermissions.has(p))) fail("HOST_PLUGIN_PERMISSION", "Tool permissions exceed plugin declarations");
        if (toolIds.has(tool.manifest.id)) fail("HOST_TOOL_DUPLICATE", "Tool IDs must be unique across selected plugins"); toolIds.add(tool.manifest.id);
        const owner = toolOwners.get(tool.manifest.id);
        if (owner && owner !== factory.id) fail("HOST_TOOL_DUPLICATE", "Tool ID belongs to a different installed plugin");
        for (const prior of installed.values()) {
          if (prior.manifest.id === factory.id && prior.manifest.version !== factory.version &&
              prior.tools.some((t) => t.manifest.id === tool.manifest.id && t.manifest.version === tool.manifest.version))
            fail("HOST_TOOL_VERSION_REUSED", "Use a distinct tool version for each installed plugin implementation so stale calls and retries cannot select different code");
        }
        if (!tool.manifest.projectSchemaVersions?.includes("1.1.0")) fail("HOST_TOOL_COMPATIBILITY", "Host tools must explicitly support ProjectDocument 1.1.0");
        const manifest = frozen(structuredClone({ ...tool.manifest, pluginId: factory.id,
          execution: { ...tool.manifest.execution,
            maxConcurrency: Math.min(tool.manifest.execution.maxConcurrency ?? limits.defaultToolConcurrency, limits.defaultToolConcurrency),
            timeoutMs: Math.min(tool.manifest.execution.timeoutMs ?? limits.maxTimeoutMs, limits.maxTimeoutMs) } }));
        const execute = tool.execute.bind(tool);
        return { manifest, execute: async (input: unknown, context: ToolCallContext): Promise<ToolResult> => {
          const session = calls.getStore();
          if (!session || context.projectId !== session.grant.projectId) return failure("HOST_SESSION_REQUIRED", "Invoke through a bound creative session");
          const scope: Scope = { session, context: { ...context }, pluginPermissions, manifest, accepting: true, active: true,
            pending: new Set(), errors: [], produced: new Set(), snapshotAssets: new Set(), writesStarted: false, revisionIndex: 0 };
          return scopes.run(scope, async () => {
            try {
              check(scope, []);
              const result = await execute(input, { ...context });
              scope.accepting = false;
              await Promise.allSettled([...scope.pending]);
              if (scope.errors.length) throw scope.errors[0];
              check(scope, []);
              if (result.output !== undefined) jsonCopy(result.output, limits.maxProjectBytes);
              if (result.ok && result.artifacts?.length) await serial(async () => {
                for (const ref of result.artifacts!) {
                  if (!scope.produced.has(ref.id)) check(scope, ["artifact.read"]);
                  const { record } = await checkedArtifact(scope, ref.id);
                  if (ref.uri !== record.uri || ref.mediaType !== record.mediaType || (ref.contentHash !== undefined && ref.contentHash !== record.contentHash)) fail("HOST_ARTIFACT_INVALID", "Tool returned inconsistent artifact metadata");
                }
                for (const ref of result.artifacts!) { check(scope, []); await retainOutput(scope, ref.id); }
              });
              return result;
            } catch (error) {
              scope.accepting = false; await Promise.allSettled([...scope.pending]);
              const result = failure(error instanceof CreativeHostError ? error.code : "HOST_SERVICE_FAILED", error instanceof Error ? error.message : String(error));
              if (scope.writesStarted) result.metadata = { outcomeUnknown: true };
              return result;
            } finally { scope.accepting = false; scope.active = false; }
          });
        } };
      }) };
  };
  const remember = (plugin: AgentToolPlugin): void => {
    installed.set(pluginKey(plugin.manifest.id, plugin.manifest.version), plugin);
    for (const tool of plugin.tools) toolOwners.set(tool.manifest.id, plugin.manifest.id);
  };
  const refreshCatalogue = (): void => {
    catalogue.clear();
    for (const plugin of activePlugins.values()) for (const tool of plugin.tools) catalogue.set(tool.manifest.id, tool.manifest);
    catalogueGeneration++;
  };
  try {
    const plugins = factories.map((factory) => {
      if (activePlugins.has(factory.id)) fail("HOST_PLUGIN_DUPLICATE", "Select one exact version for each plugin at boot");
      const plugin = preparePlugin(factory); remember(plugin); activePlugins.set(factory.id, plugin); return plugin;
    });
    registry = await runtime.configurePlugins(plugins);
    refreshCatalogue();
  } catch (error) {
    state = "failed"; await tail;
    try { await runtime.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Host startup and cleanup failed"); }
    throw error;
  }
  const available = (session: SessionState, manifest: AgentToolManifest): boolean => session.tools.has(manifest.id) &&
    (manifest.execution.permissions ?? []).every((p) => session.permissions.has(p as CreativePermission)) &&
    (!manifest.execution.destructive || session.grant.allowDestructive === true) &&
    (manifest.execution.cost !== "high" || session.grant.allowHighCost === true);
  const admitted = (session?: SessionState): void => {
    if (state === "switching") fail("HOST_PLUGIN_SWITCHING", "Plugin transition is draining calls or checking the candidate; retry after it completes");
    if (state !== "ready") fail("HOST_CLOSED", "Host is not accepting calls");
    if (session?.abort.signal.aborted) fail("HOST_SESSION_REVOKED", "Session has been revoked");
  };
  const administrative = (): void => {
    admitted();
    if (calls.getStore() || scopes.getStore()) fail("HOST_PLUGIN_ADMIN_SCOPE", "Plugin administration cannot run inside a tool invocation");
  };
  const jobs = new CreativeRenderJobController({ runtime, serial, maxArtifactBytes: limits.maxArtifactBytes, maxTimeoutMs: limits.maxTimeoutMs,
    validateSnapshot: saved => { document(saved.document); }, fatal: () => { state = "failed"; } }, options.renderJobs);
  const host: CreativeHost = {
    createSession: (input) => {
      admitted(); exactKeys(input, ["projectId", "permissions", "toolIds", "allowDestructive", "allowHighCost"]); identity(input.projectId);
      const rights = permissions(input.permissions ?? []);
      for (const flag of [input.allowDestructive, input.allowHighCost]) if (flag !== undefined && typeof flag !== "boolean") fail("HOST_POLICY_INVALID", "Approval flags must be booleans");
      if (sessions.length >= limits.maxSessions) fail("HOST_SESSION_LIMIT", "Session capacity reached; reopen host to release retained sessions");
      if (!Array.isArray(input.toolIds ?? [])) fail("HOST_POLICY_INVALID", "toolIds must be an explicit array");
      for (const id of input.toolIds ?? []) if (!catalogue.has(id)) fail("HOST_TOOL_UNKNOWN", `Unknown granted tool: ${id}`);
      const grant = frozen(structuredClone({ ...input, permissions: [...rights], toolIds: [...new Set(input.toolIds ?? [])] }));
      const gateway = runtime.gateway(grant, limits); gateways.add(gateway);
      const session: SessionState = { grant, permissions: rights, tools: new Set(grant.toolIds), abort: new AbortController(), gateway }; sessions.push(session);
      const api: CreativeSession = {
        projectId: grant.projectId,
        jobs: jobs.forSession({ projectId: grant.projectId, signal: session.abort.signal, admit: () => admitted(session),
          authorize: (toolId, version) => {
            admitted(session);
            const selected = catalogue.get(toolId);
            if (!selected || !available(session, selected) || !session.permissions.has("snapshot.read") || !session.permissions.has("artifact.write"))
              fail("HOST_TOOL_DENIED", "Render operation is outside this session grant");
            if (selected.version !== version) fail("HOST_TOOL_VERSION_MISMATCH", "Use the exact discovered render tool version");
            if (selected.pluginId !== "builtin.workspace" || selected.version !== "1.0.0" || !["render.preview", "render.video"].includes(toolId))
              fail("HOST_JOB_TOOL_UNSUPPORTED", "This render implementation has no supported background-job binding");
            return structuredClone(selected);
          } }),
        manifest: async (id) => { admitted(session); const m = catalogue.get(id); return m && available(session, m) ? structuredClone(m) : undefined; },
        discover: async (input = {}) => {
          admitted(session); const query = jsonCopy(input, limits.maxInputBytes);
          const generation = catalogueGeneration;
          exactKeys(query, ["text", "namespaces", "categories", "tags", "capabilities", "engines", "projectSchemaVersion", "includeDeprecated", "limit", "offset"]);
          if (query.text !== undefined && typeof query.text !== "string") fail("HOST_INPUT_INVALID", "Invalid search text");
          for (const values of [query.namespaces, query.categories, query.tags, query.capabilities, query.engines]) {
            if (values !== undefined && (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v.trim()))) fail("HOST_INPUT_INVALID", "Invalid discovery filter");
          }
          if (query.includeDeprecated !== undefined && typeof query.includeDeprecated !== "boolean") fail("HOST_INPUT_INVALID", "Invalid deprecation filter");
          const offset = query.offset ?? 0, limit = query.limit ?? 50;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("HOST_INPUT_INVALID", "Invalid discovery pagination");
          if (query.projectSchemaVersion !== undefined && query.projectSchemaVersion !== "1.1.0") return { tools: [], total: 0, limit, offset };
          const found: AgentToolManifest[] = [];
          for (let page = 0; ; page += 200) {
            const result = await registry.discover({ ...query, limit: 200, offset: page, projectSchemaVersion: "1.1.0" });
            found.push(...result.tools.filter((m) => available(session, m)));
            if (page + result.tools.length >= result.total || !result.tools.length) break;
          }
          admitted(session);
          if (generation !== catalogueGeneration) fail("HOST_CATALOGUE_CHANGED", "Plugin selection changed during discovery; repeat the query");
          return { tools: structuredClone(found.slice(offset, offset + limit)), total: found.length, limit, offset };
        },
        invoke: async (request) => {
          try {
            admitted(session);
            exactKeys(request, ["toolId", "toolVersion", "input", "runId", "callId", "idempotencyKey", "signal"]);
            identity(request.toolId); identity(request.toolVersion); identity(request.runId); identity(request.callId);
            if (request.idempotencyKey !== undefined) identity(request.idempotencyKey);
            const selected = catalogue.get(request.toolId);
            if (!selected || !available(session, selected)) return failure("HOST_TOOL_DENIED", "Tool is outside this session grant");
            if (request.toolVersion !== selected.version) return failure("HOST_TOOL_VERSION_MISMATCH", "Invoke the exact discovered tool version");
            const input = jsonCopy(request.input, limits.maxInputBytes);
            const controller = new AbortController(); const signals = [session.abort.signal, request.signal].filter((s): s is AbortSignal => s !== undefined);
            const abort = () => controller.abort(new Error("Creative session/caller cancelled"));
            for (const signal of signals) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
            try { return await calls.run(session, () => session.gateway.invoke(request.toolId, input, {
              projectId: grant.projectId, runId: request.runId, callId: request.callId,
              idempotencyKey: request.idempotencyKey, signal: controller.signal,
            })); } finally { for (const signal of signals) signal.removeEventListener("abort", abort); }
          } catch (error) { return failure(error instanceof CreativeHostError ? error.code : "HOST_INPUT_INVALID", error instanceof Error ? error.message : String(error)); }
        },
        revoke: () => session.abort.abort(new Error("Creative session revoked")),
      };
      return Object.freeze(api);
    },
    plugins: Object.freeze({
      install: (factory: CreativePluginFactory) => {
        administrative(); const plugin = preparePlugin(factory);
        const result = runtime.plugins.install(plugin);
        if (result.ok) remember(plugin);
        return result;
      },
      list: () => { administrative(); return runtime.plugins.list(); },
      exportLock: () => { administrative(); return runtime.plugins.exportLock(); },
      activate: async (pluginId: string, version: string) => {
        administrative(); identity(pluginId); identity(version);
        const candidate = installed.get(pluginKey(pluginId, version));
        if (!candidate) fail("HOST_PLUGIN_NOT_INSTALLED", "Install the exact trusted plugin version first");
        state = "switching";
        transition = (async () => {
          try {
            // Shutdown drains actual work, including tools that already returned a timeout.
            await jobs.drain(); await Promise.all([...gateways].map((g) => g.shutdown())); await tail;
            if (state !== "switching") fail("HOST_CLOSED", "Host closed before plugin activation");
            const result = await runtime.plugins.activate(pluginId, version);
            if (result.ok) { activePlugins.set(pluginId, candidate); refreshCatalogue(); }
            if (state === "switching") {
              gateways.clear();
              for (const session of sessions) if (!session.abort.signal.aborted) {
                session.gateway = runtime.gateway(session.grant, limits); gateways.add(session.gateway);
              }
              state = "ready";
            }
            return result;
          } catch (error) {
            if (state === "switching") state = "failed";
            throw error;
          }
        })();
        return transition;
      },
    }),
    maintenance: Object.freeze({
      collectGarbage: (olderThanMs?: number) => {
        admitted();
        if (olderThanMs !== undefined && (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)) return Promise.reject(new CreativeHostError("HOST_INPUT_INVALID", "Invalid GC retention"));
        return serial(() => runtime.projects.collectGarbage({ olderThanMs }));
      },
      releaseSnapshot: (projectId: string, snapshotId: string) => {
        admitted(); identity(projectId); identity(snapshotId);
        return serial(async () => { const saved = await runtime.projects.getSnapshot(snapshotId);
          if (!saved || saved.projectId !== projectId) fail("HOST_SNAPSHOT_DENIED", "Snapshot project does not match maintenance request");
          await jobs.assertSnapshotReleasable(projectId, snapshotId);
          await runtime.projects.releaseSnapshot(snapshotId);
        });
      },
    }),
    status: () => ({ state, sessions: sessions.filter((s) => !s.abort.signal.aborted).length, tools: catalogue.size }),
    close: () => {
      if (!closePromise) {
        state = "draining";
        closePromise = (async () => {
          const closingJobs = jobs.shutdown();
          const errors: unknown[] = [];
          // Observe rejection immediately while a plugin transition may still be draining these jobs.
          const jobDrain = closingJobs.catch(error => { errors.push(error); });
          await transition?.catch(() => undefined);
          const drains = await Promise.allSettled([...gateways].map(g => g.shutdown()));
          for (const result of drains) if (result.status === "rejected") errors.push(result.reason);
          await jobDrain; await tail;
          try { await runtime.close(); } catch (error) { errors.push(error); }
          if (errors.length) { state = "failed"; throw new AggregateError(errors, "Host drain/close failed; inspect persisted evidence before recovery"); }
          state = "closed";
        })();
      }
      return closePromise;
    },
  };
  return Object.freeze(host);
}
