import { createHash } from "node:crypto";
import type { AgentToolManifest } from "../contracts/agent-tool";
import type { CreativeJobPolicy, CreativeJobSubmission, CreativeRenderJobs } from "../contracts/creative-jobs";
import type { RenderJobRecord, RenderJobStore, RenderJobStopReason, RenderJobSubmission } from "../contracts/render-job";
import type { ProjectGraphRenderOutput, ProjectGraphRenderProgress } from "../contracts/renderer";
import type { CreativeHostRuntime } from "./creative-host-core";
import type { ProjectSnapshot } from "./project-snapshots";
import { creativeJobPolicy, jobRequest, parseJobSubmission, resolvedJobInput } from "./creative-job-input";
import { activeJobStates, jobCopy, jobFail, jobIdentity, jobInteger, jobObject, validateJobProgress } from "./render-job-validation";
import { hashToolInput } from "./tool-execution-store";

export interface JobSession {
  projectId: string;
  signal: AbortSignal;
  admit(): void;
  authorize(toolId: string, version: string): AgentToolManifest;
}
interface Entry {
  record: RenderJobRecord; snapshot: ProjectSnapshot; actor: JobSession; timeoutMs: number;
  abort: AbortController; revoke(): void; token?: string;
}
interface JobPorts {
  runtime: CreativeHostRuntime;
  serial<T>(work: () => Promise<T>): Promise<T>;
  validateSnapshot(snapshot: ProjectSnapshot): void;
  maxArtifactBytes: number; maxTimeoutMs: number; maxInputBytes: number;
  fatal(error: unknown): void;
}
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "HOST_JOB_FAILED";
const diagnostic = (error: unknown) => ({ code: /^[A-Z0-9_]{1,128}$/.test(errorCode(error)) ? errorCode(error) : "HOST_JOB_FAILED",
  message: [...(error instanceof Error ? error.message : "Render job failed")].slice(0, 512).join("") || "Render job failed" });

/** Native host operations, authorized by the built-in render grants. They do not impersonate Gateway invocations. */
export class CreativeRenderJobController {
  private readonly store: RenderJobStore;
  private readonly policy: Omit<CreativeJobPolicy, "maxActiveJobs">;
  private readonly entries = new Map<string, Entry>();
  private readonly admissions = new Set<Promise<unknown>>();
  private readonly pendingSubmissions = new Map<string, { hash: string; promise: Promise<{ created: boolean; record: RenderJobRecord }> }>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Entry[]>();
  private closing = false;
  private fatalError?: unknown;

  constructor(private readonly ports: JobPorts, policy?: Partial<CreativeJobPolicy>) {
    this.store = ports.runtime.jobs; this.policy = creativeJobPolicy(policy);
  }
  private fatal(error: unknown): void {
    this.fatalError ??= error; this.ports.fatal(error);
    for (const entry of this.entries.values()) entry.abort.abort(error);
  }
  private async records(projectId: string): Promise<RenderJobRecord[]> {
    const records: RenderJobRecord[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.store.list(projectId, { offset, limit: 200 }); records.push(...page.jobs);
      if (offset + page.jobs.length >= page.total) return records;
    }
  }
  forSession(actor: JobSession): CreativeRenderJobs {
    const get = async (id: string) => {
      actor.admit(); jobIdentity(id); const record = await this.store.get(actor.projectId, id); actor.admit();
      if (record) actor.authorize(`render.${record.input.render.operation}`, record.input.toolVersion);
      return record;
    };
    return Object.freeze({
      submit: (request: CreativeJobSubmission) => this.submit(actor, request),
      get,
      list: async (query: { offset?: number; limit?: number } = {}) => {
        actor.admit(); const q = jobCopy(query); jobObject(q, ["offset", "limit"]);
        const offset = q.offset ?? 0, limit = q.limit ?? 50; jobInteger(offset); jobInteger(limit, 1, 200);
        const records = await this.records(actor.projectId); actor.admit();
        const visible = records.filter(record => {
          try { actor.authorize(`render.${record.input.render.operation}`, record.input.toolVersion); return true; } catch { return false; }
        });
        return { jobs: visible.slice(offset, offset + limit), total: visible.length, offset, limit };
      },
      cancel: async (id: string) => {
        const record = await get(id); if (!record) return jobFail("RENDER_JOB_NOT_FOUND", "Job is missing or outside this project");
        return this.stop(record, "cancelled");
      },
    });
  }
  private async submit(actor: JobSession, value: CreativeJobSubmission) {
    actor.admit();
    if (this.closing || this.fatalError) jobFail("HOST_CLOSED", "Job controller is not accepting work");
    const request = parseJobSubmission(value); actor.authorize(request.toolId, request.toolVersion);
    if (Buffer.byteLength(JSON.stringify(request.input)) > this.ports.maxInputBytes)
      jobFail("HOST_INPUT_TOO_LARGE", "Render input exceeds the configured host byte limit");
    const key = JSON.stringify([actor.projectId, request.submissionId]), hash = hashToolInput(request);
    const pending = this.pendingSubmissions.get(key);
    if (pending) {
      if (pending.hash !== hash) jobFail("RENDER_JOB_CONFLICT", "Submission identity is already being admitted with another request");
      const result = await pending.promise; actor.admit(); actor.authorize(request.toolId, request.toolVersion);
      return { created: false, record: structuredClone(result.record) };
    }
    if (this.admissions.size >= this.policy.maxQueuedJobs + this.policy.maxConcurrentJobs) jobFail("HOST_JOB_CAPACITY", "Job admission capacity reached; retry later");
    const admission = this.ports.serial(async () => {
      actor.admit(); const manifest = actor.authorize(request.toolId, request.toolVersion);
      const existing = (await this.records(actor.projectId)).find(record => record.input.submissionId === request.submissionId);
      if (existing) {
        if (hashToolInput(jobRequest(existing)) !== hashToolInput(request)) jobFail("RENDER_JOB_CONFLICT", "Submission identity is already bound to another request");
        actor.admit(); return { created: false, record: existing };
      }
      // Dispatch reserves slots synchronously, before another admission can consume
      // them. A stopping/publishing job keeps its slot until actual settlement.
      const queued = [...this.queues.values()].reduce((total, queue) => total + queue.length, 0);
      if (this.running.size >= this.policy.maxConcurrentJobs && queued >= this.policy.maxQueuedJobs)
        jobFail("HOST_JOB_CAPACITY", "Render queue is full; retry admission later");
      const saved = await this.ports.runtime.projects.getSnapshot(request.input.snapshotId);
      if (!saved || saved.projectId !== actor.projectId) return jobFail("HOST_SNAPSHOT_DENIED", "Snapshot is outside this session or missing");
      this.ports.validateSnapshot(saved);
      const input = resolvedJobInput(actor.projectId, request, saved, this.ports.runtime.rendererIdentity);
      actor.admit(); actor.authorize(request.toolId, request.toolVersion);
      // Workspace already durably retains the snapshot and its verified local dependencies. The queued
      // record becomes its pin before acknowledgement; releaseSnapshot uses this same serial boundary.
      const admitted = await this.store.submit(input);
      const entry: Entry = { record: structuredClone(admitted.record), snapshot: saved, actor,
        timeoutMs: Math.min(this.policy.timeoutMs, this.ports.maxTimeoutMs, manifest.execution.timeoutMs ?? this.ports.maxTimeoutMs),
        abort: new AbortController(), revoke: () => { void this.stop(admitted.record, "cancelled").catch(error => this.fatal(error)); } };
      this.entries.set(admitted.record.id, entry);
      const queue = this.queues.get(actor.projectId) ?? [];
      queue.push(entry); this.queues.set(actor.projectId, queue);
      actor.signal.addEventListener("abort", entry.revoke, { once: true });
      if (actor.signal.aborted || this.closing) entry.revoke();
      this.schedule(); return admitted;
    });
    this.admissions.add(admission);
    this.pendingSubmissions.set(key, { hash, promise: admission });
    try { return structuredClone(await admission); }
    catch (error) {
      if (["RENDER_JOB_PERSISTENCE_UNCERTAIN", "RENDER_JOB_RECOVERY_REQUIRED"].includes(errorCode(error))) this.fatal(error);
      throw error;
    } finally { this.admissions.delete(admission); this.pendingSubmissions.delete(key); }
  }
  private remove(entry: Entry): void {
    this.entries.delete(entry.record.id); entry.actor.signal.removeEventListener("abort", entry.revoke);
    const projectId = entry.record.input.projectId, queue = this.queues.get(projectId);
    if (queue) {
      const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
      if (!queue.length) this.queues.delete(projectId);
    }
  }
  private async stop(record: RenderJobRecord, reason: RenderJobStopReason) {
    try {
      const response = await this.store.requestStop(record.input.projectId, record.id, reason);
      if (response.accepted) {
        const entry = this.entries.get(record.id); entry?.abort.abort(new Error(`Render job ${reason}`));
        if (entry && !entry.token && !activeJobStates.has(response.record.state)) this.remove(entry);
      }
      return response;
    } catch (error) { this.fatal(error); throw error; }
  }
  private schedule(): void {
    while (!this.closing && !this.fatalError && this.running.size < this.policy.maxConcurrentJobs && this.queues.size) {
      // One dispatch per waiting project per turn. Reinsert remaining FIFO work
      // at the end so a busy project's backlog cannot monopolize future slots.
      const [projectId, queue] = this.queues.entries().next().value!;
      const entry = queue.shift()!; this.queues.delete(projectId);
      if (queue.length) this.queues.set(projectId, queue);
      const executing = this.execute(entry).catch(error => this.fatal(error)).finally(() => {
        this.remove(entry); this.running.delete(entry.record.id); this.schedule();
      });
      this.running.set(entry.record.id, executing);
    }
  }
  private async execute(entry: Entry): Promise<void> {
    const { id, input } = entry.record, projectId = input.projectId;
    if ((await this.store.get(projectId, id))?.state !== "queued" || this.fatalError) return;
    let owner;
    try { owner = await this.store.claim(projectId, id); }
    catch (error) { if ((await this.store.get(projectId, id))?.state === "cancelled") return; throw error; }
    entry.token = owner.token;
    if (this.fatalError) throw this.fatalError;
    if (entry.actor.signal.aborted || this.closing) await this.stop(entry.record, "cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let progressOpen = true, latest: ProjectGraphRenderProgress | undefined, progressError: unknown;
    let progressPump: Promise<void> | undefined;
    const onProgress = (value: ProjectGraphRenderProgress) => {
      if (!progressOpen || entry.abort.signal.aborted) return;
      try { const copy = jobCopy(value); validateJobProgress(copy); latest = copy; }
      catch (error) { progressError = error; entry.abort.abort(error); return; }
      if (!progressPump) progressPump = (async () => {
        while (latest) {
          const value = latest; latest = undefined;
          try { await this.store.progress(projectId, id, owner.token, value); }
          catch (error) { if (errorCode(error) !== "RENDER_JOB_STATE") { progressError = error; entry.abort.abort(error); } latest = undefined; }
        }
      })().finally(() => { progressPump = undefined; });
    };
    try {
      let output: ProjectGraphRenderOutput | undefined, renderError: unknown;
      if ((await this.store.get(projectId, id))!.state === "running") {
        timer = setTimeout(() => { void this.stop(entry.record, "timed-out").catch(error => this.fatal(error)); }, entry.timeoutMs);
        const request = { project: structuredClone(entry.snapshot.document), revisionId: input.snapshot.revisionId,
          snapshotHash: input.snapshot.contentHash, profile: structuredClone(input.profile), signal: entry.abort.signal, onProgress,
          ...(input.render.sceneId ? { sceneId: input.render.sceneId } : {}) };
        try {
          output = input.render.operation === "preview" ? await this.ports.runtime.renderPreview({ ...request, frame: input.render.frame })
            : await this.ports.runtime.renderVideo({ ...request, startFrame: input.render.startFrame, durationFrames: input.render.durationFrames });
        } catch (error) { renderError = error; }
      }
      progressOpen = false; await progressPump;
      if (errorCode(renderError) === "RENDER_WORKER_CLEANUP") throw renderError;
      if (["RENDER_WORKER_TIMEOUT", "RENDER_WORKER_CANCELLED"].includes(errorCode(renderError)))
        await this.stop(entry.record, errorCode(renderError) === "RENDER_WORKER_TIMEOUT" ? "timed-out" : "cancelled");
      if (progressError) throw progressError;
      await this.ports.serial(async () => {
        // A sibling cleanup/storage failure must not release an uncommitted late
        // result. Keep its active evidence for conservative recovery instead.
        if (this.fatalError) throw this.fatalError;
        const current = (await this.store.get(projectId, id))!;
        if (current.state === "stopping") { await this.store.finish(projectId, id, owner.token, { state: current.stop!.reason }); return; }
        if (renderError) throw renderError;
        if (!output) return jobFail("HOST_RENDER_OUTPUT_INVALID", "Renderer did not return output");
        this.validateOutput(input, output);
        await this.store.beginPublication(projectId, id, owner.token); clearTimeout(timer);
        const receipt = await this.publish(entry.record, output);
        await this.store.finish(projectId, id, owner.token, { state: "succeeded", result: receipt });
      });
    } catch (error) {
      if (this.fatalError || ["RENDER_JOB_PERSISTENCE_UNCERTAIN", "RENDER_JOB_RECOVERY_REQUIRED", "RENDER_WORKER_CLEANUP"].includes(errorCode(error))) throw error;
      const current = (await this.store.get(projectId, id))!;
      if (current.state === "stopping") await this.store.finish(projectId, id, owner.token, { state: current.stop!.reason });
      else await this.store.finish(projectId, id, owner.token, { state: "failed", diagnostic: diagnostic(error) });
    } finally { progressOpen = false; clearTimeout(timer); await progressPump; }
  }
  private validateOutput(input: RenderJobSubmission, output: ProjectGraphRenderOutput): void {
    const preview = input.render.operation === "preview";
    if (!(output.bytes instanceof Uint8Array) || output.bytes.byteLength < 8 || output.bytes.byteLength > Math.min(this.ports.maxArtifactBytes, 64 * 1024 * 1024) ||
        output.mediaType !== (preview ? "image/png" : "video/mp4") || output.extension !== (preview ? "png" : "mp4") ||
        output.rendererId !== input.renderer.id || output.rendererVersion !== input.renderer.version)
      jobFail("HOST_RENDER_OUTPUT_INVALID", "Renderer output differs from the admitted identity/type/bounds");
  }
  private async publish(record: RenderJobRecord, output: ProjectGraphRenderOutput) {
    const { input, id, inputHash } = record, runtime = this.ports.runtime;
    const bytes = new Uint8Array(output.bytes), contentHash = createHash("sha256").update(bytes).digest("hex");
    const stored = await runtime.artifacts.put({ bytes, kind: input.render.operation === "preview" ? "image" : "video",
      mediaType: output.mediaType, extension: output.extension,
      metadata: { jobId: id, inputHash, snapshotId: input.snapshot.id, snapshotHash: input.snapshot.contentHash,
        revisionId: input.snapshot.revisionId, ...input.render, ...input.profile, rendererId: input.renderer.id, rendererVersion: input.renderer.version,
        ...(output.execution ? { execution: jobCopy(output.execution) } : {}) },
      provenance: { projectId: input.projectId, runId: input.runId, callId: input.callId, toolId: `render.${input.render.operation}`,
        toolVersion: input.toolVersion, pluginId: "builtin.workspace", parametersHash: inputHash } });
    const saved = await runtime.artifacts.read(stored.id);
    if (stored.id !== `sha256:${contentHash}` || stored.contentHash !== contentHash || stored.uri !== `artifact://sha256/${contentHash}` ||
        stored.kind !== (input.render.operation === "preview" ? "image" : "video") || stored.mediaType !== output.mediaType || stored.sizeBytes !== bytes.byteLength || !saved || saved.byteLength !== bytes.byteLength ||
        createHash("sha256").update(saved).digest("hex") !== contentHash) jobFail("HOST_ARTIFACT_CORRUPT", "Published result failed byte/receipt verification");
    await runtime.retain({ artifactId: stored.id, ownerType: "tool-run", ownerId: JSON.stringify([input.projectId, input.runId, input.callId]), role: "host-output" });
    return { jobId: id, inputHash, artifactId: stored.id, contentHash, sizeBytes: bytes.byteLength, mediaType: output.mediaType,
      rendererId: input.renderer.id, rendererVersion: input.renderer.version };
  }
  /** Called within host serialization so admission and snapshot release cannot race. */
  async assertSnapshotReleasable(projectId: string, snapshotId: string): Promise<void> {
    if ((await this.records(projectId)).some(record => record.input.snapshot.id === snapshotId &&
        (activeJobStates.has(record.state) || record.state === "interrupted" || record.outcomeUnknown)))
      jobFail("HOST_SNAPSHOT_RETAINED", "Snapshot is retained by an active or unreconciled render job");
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.admissions]);
    while (this.running.size || (this.queues.size && !this.closing && !this.fatalError)) {
      this.schedule();
      // Includes non-cooperative siblings after fatal failure; resources cannot
      // close merely because the first executor has stopped or failed.
      await Promise.allSettled([...this.running.values()]);
    }
    if (this.fatalError) throw this.fatalError;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.entries.values()].map(entry => this.stop(entry.record, "cancelled")));
    await Promise.allSettled([...this.admissions]);
    await Promise.allSettled([...this.entries.values()].map(entry => this.stop(entry.record, "cancelled")));
    try { await this.drain(); }
    finally { for (const entry of this.entries.values()) this.remove(entry); }
  }
}
