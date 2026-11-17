import { randomUUID } from "node:crypto";
import type { ProjectGraphRenderProgress } from "../contracts/renderer";
import { RENDER_JOB_SCHEMA_VERSION, type RenderJobCompletion, type RenderJobRecord, type RenderJobStore, type RenderJobSubmission, type RenderJobStopReason } from "../contracts/render-job";
import { hashToolInput } from "./tool-execution-store";
import { activeJobStates, jobCopy, jobFail, jobIdentity, jobInteger, jobObject, MAX_RENDER_JOB_RECORD_BYTES, progressPhases, RenderJobError,
  validateJobDiagnostic, validateJobProgress, validateJobReceipt, validateJobRecord, validateJobSubmission } from "./render-job-validation";

export interface RenderJobStoreOptions {
  /** Ledger retention capacity, not scheduler capacity. Records are never silently evicted. */
  maxJobs?: number;
  maxLedgerBytes?: number;
  progressIntervalMs?: number;
  /** Trusted embedding/test clock. Timestamps never move backwards within a job. */
  now?: () => Date;
}
type Entry = { record: RenderJobRecord; token?: string };
const submissionKey = (input: RenderJobSubmission) => JSON.stringify([input.projectId, input.submissionId]);

/** Atomic state transitions in one store. Filesystem subclass persists before publishing memory or acknowledgements. */
export class InMemoryRenderJobStore implements RenderJobStore {
  protected records = new Map<string, Entry>();
  protected readonly maxJobs: number;
  protected readonly maxLedgerBytes: number;
  private readonly progressIntervalMs: number;
  private readonly clock: () => Date;
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private closed = false;
  private poisoned = false;

  constructor(options: RenderJobStoreOptions = {}) {
    jobObject(options, ["maxJobs", "maxLedgerBytes", "progressIntervalMs", "now"]);
    const config = options as RenderJobStoreOptions;
    this.maxJobs = config.maxJobs ?? 1000; jobInteger(this.maxJobs, 1, 10000);
    this.maxLedgerBytes = config.maxLedgerBytes ?? 16 * 1024 * 1024; jobInteger(this.maxLedgerBytes, 1024, 64 * 1024 * 1024);
    this.progressIntervalMs = config.progressIntervalMs ?? 250; jobInteger(this.progressIntervalMs, 0, 60000);
    if (config.now !== undefined && typeof config.now !== "function") jobFail("RENDER_JOB_INVALID", "Invalid job clock");
    this.clock = config.now ?? (() => new Date());
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next;
  }
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) return Promise.reject(new RenderJobError("RENDER_JOB_CLOSED", "Job ledger is closing or closed"));
    return this.enqueue(async () => {
      if (this.poisoned) jobFail("RENDER_JOB_RECOVERY_REQUIRED", "Job persistence is uncertain; close and reopen before continuing");
      return work();
    });
  }
  private timestamp(previous?: string): string {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) jobFail("RENDER_JOB_INVALID", "Invalid job clock timestamp");
    return new Date(Math.max(now.getTime(), previous ? Date.parse(previous) : -Infinity)).toISOString();
  }
  protected envelope(records: RenderJobRecord[]): string {
    const data = { schemaVersion: RENDER_JOB_SCHEMA_VERSION, records };
    const text = JSON.stringify({ ...data, contentHash: hashToolInput(data) });
    // Every admitted active record can grow to the contract cap, so capacity cannot block its terminal write.
    const reservedGrowth = records.reduce((bytes, record) => bytes + (activeJobStates.has(record.state)
      ? MAX_RENDER_JOB_RECORD_BYTES - Buffer.byteLength(JSON.stringify(record)) : 0), 0);
    if (Buffer.byteLength(text) + reservedGrowth > this.maxLedgerBytes) jobFail("RENDER_JOB_CAPACITY", "Job ledger byte capacity, including reserved completion space, reached");
    return text;
  }
  protected async persist(_text: string): Promise<void> {}
  protected async release(): Promise<void> {}
  protected async commit(next: Map<string, Entry>): Promise<void> {
    const records = [...next.values()].map(entry => entry.record);
    if (records.length > this.maxJobs) jobFail("RENDER_JOB_CAPACITY", "Job ledger record capacity reached");
    const text = this.envelope(records); // Rejected bounds do not poison storage or drop older records.
    try { await this.persist(text); }
    catch (error) {
      this.poisoned = true;
      throw new RenderJobError("RENDER_JOB_PERSISTENCE_UNCERTAIN", `Job ledger write failed; reopen and reconcile: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.records = next;
  }
  protected async restore(records: RenderJobRecord[]): Promise<void> {
    if (records.length > this.maxJobs) jobFail("RENDER_JOB_CAPACITY", "Saved job count exceeds configured capacity");
    const next = new Map<string, Entry>(), keys = new Set<string>(); let recovered = false;
    for (const original of records) {
      validateJobRecord(original);
      const key = submissionKey(original.input);
      if (next.has(original.id) || keys.has(key)) jobFail("RENDER_JOB_CORRUPT", "Duplicate persisted job/submission identity");
      keys.add(key);
      const record = structuredClone(original);
      if (activeJobStates.has(record.state)) {
        recovered = true;
        record.interruptedFrom = record.state as NonNullable<RenderJobRecord["interruptedFrom"]>;
        record.state = "interrupted"; record.revision++;
        record.completedAt = record.updatedAt = this.timestamp(record.updatedAt);
        record.outcomeUnknown = record.interruptedFrom !== "queued";
        record.diagnostic = { code: "RENDER_JOB_INTERRUPTED", message: "Previous owner stopped without terminal evidence; inspect job/execution/Artifact records before an explicit new submission" };
        validateJobRecord(record);
      }
      next.set(record.id, { record }); // Executor tokens never survive reopen.
    }
    if (recovered) await this.commit(next); else this.records = next;
  }
  private current(projectId: string, jobId: string): Entry {
    jobIdentity(projectId); jobIdentity(jobId);
    const entry = this.records.get(jobId);
    if (!entry || entry.record.input.projectId !== projectId) return jobFail("RENDER_JOB_NOT_FOUND", "Job is missing or outside this project");
    return entry;
  }
  private owned(projectId: string, jobId: string, token: string): Entry {
    const entry = this.current(projectId, jobId);
    if (!entry.token || token !== entry.token) jobFail("RENDER_JOB_NOT_OWNED", "Job execution is not owned by this token");
    return entry;
  }
  private async update(entry: Entry, mutate: (record: RenderJobRecord, now: string) => void, token = entry.token): Promise<RenderJobRecord> {
    const record = structuredClone(entry.record), now = this.timestamp(record.updatedAt);
    record.updatedAt = now; record.revision++; mutate(record, now); validateJobRecord(record);
    const next = new Map(this.records); next.set(record.id, { record, ...(activeJobStates.has(record.state) && token ? { token } : {}) });
    await this.commit(next); return structuredClone(record);
  }
  async submit(value: RenderJobSubmission) {
    const input = jobCopy(value); validateJobSubmission(input); const inputHash = hashToolInput(input);
    return this.schedule(async () => {
      const existing = [...this.records.values()].find(entry => submissionKey(entry.record.input) === submissionKey(input));
      if (existing) {
        if (existing.record.inputHash !== inputHash) jobFail("RENDER_JOB_CONFLICT", "Submission identity is already bound to different input");
        return { created: false, record: structuredClone(existing.record) };
      }
      const now = this.timestamp();
      const record: RenderJobRecord = { schemaVersion: RENDER_JOB_SCHEMA_VERSION, id: randomUUID(), input, inputHash, state: "queued", revision: 0,
        createdAt: now, updatedAt: now, outcomeUnknown: false };
      validateJobRecord(record);
      const next = new Map(this.records); next.set(record.id, { record }); await this.commit(next);
      return { created: true, record: structuredClone(record) };
    });
  }
  async get(projectId: string, jobId: string) {
    jobIdentity(projectId); jobIdentity(jobId);
    return this.schedule(async () => {
      const record = this.records.get(jobId)?.record;
      return record?.input.projectId === projectId ? structuredClone(record) : undefined;
    });
  }
  async list(projectId: string, query: { offset?: number; limit?: number } = {}) {
    jobIdentity(projectId); const q = jobCopy(query); jobObject(q, ["offset", "limit"]);
    const offset = q.offset ?? 0, limit = q.limit ?? 50; jobInteger(offset); jobInteger(limit, 1, 200);
    return this.schedule(async () => {
      const records = [...this.records.values()].map(entry => entry.record).filter(record => record.input.projectId === projectId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      return { jobs: structuredClone(records.slice(offset, offset + limit)), total: records.length, offset, limit };
    });
  }
  async claim(projectId: string, jobId: string) {
    return this.schedule(async () => {
      const entry = this.current(projectId, jobId);
      if (entry.record.state !== "queued") jobFail("RENDER_JOB_STATE", "Only a queued job can be claimed; interrupted work is never auto-replayed");
      const token = randomUUID();
      const record = await this.update(entry, (record, now) => { record.state = "running"; record.startedAt = now; }, token);
      return { token, record };
    });
  }
  async progress(projectId: string, jobId: string, token: string, value: ProjectGraphRenderProgress) {
    const progress = jobCopy(value); validateJobProgress(progress);
    return this.schedule(async () => {
      const entry = this.owned(projectId, jobId, token), record = entry.record;
      if (record.state !== "running") jobFail("RENDER_JOB_STATE", "Only running jobs accept progress");
      if (progress.phase === "encoding" && record.input.render.operation !== "video") jobFail("RENDER_JOB_INVALID", "Only videos encode");
      const prior = record.progress, now = this.timestamp(record.updatedAt), samePhase = prior?.phase === progress.phase;
      if (prior && (progressPhases.indexOf(progress.phase) < progressPhases.indexOf(prior.phase) ||
          (samePhase && prior.fraction !== undefined && (progress.fraction === undefined || progress.fraction < prior.fraction))))
        jobFail("RENDER_JOB_PROGRESS_REGRESSION", "Job progress cannot move backwards");
      if (prior && samePhase && (progress.fraction === prior.fraction || Date.parse(now) - Date.parse(prior.observedAt) < this.progressIntervalMs))
        return { updated: false, record: structuredClone(record) };
      return { updated: true, record: await this.update(entry, (next, at) => { next.progress = { ...progress, observedAt: at }; }) };
    });
  }
  async requestStop(projectId: string, jobId: string, reason: RenderJobStopReason) {
    if (!["cancelled", "timed-out"].includes(reason)) jobFail("RENDER_JOB_INVALID", "Invalid job stop reason");
    return this.schedule(async () => {
      const entry = this.current(projectId, jobId), state = entry.record.state;
      if (state === "publishing" || !activeJobStates.has(state)) return { accepted: false, record: structuredClone(entry.record) };
      if (state === "stopping") return { accepted: true, record: structuredClone(entry.record) }; // First durable stop reason wins.
      return { accepted: true, record: await this.update(entry, (record, now) => {
        record.stop = { reason, requestedAt: now };
        record.state = state === "queued" ? reason : "stopping";
        if (state === "queued") { record.completedAt = now; record.diagnostic = this.stopDiagnostic(reason); }
      }) };
    });
  }
  private stopDiagnostic(reason: RenderJobStopReason) {
    return { code: reason === "cancelled" ? "RENDER_JOB_CANCELLED" : "RENDER_JOB_TIMEOUT", message: reason === "cancelled" ? "Render job cancelled" : "Render job deadline exceeded" };
  }
  async beginPublication(projectId: string, jobId: string, token: string) {
    return this.schedule(async () => {
      const entry = this.owned(projectId, jobId, token);
      if (entry.record.state !== "running") jobFail("RENDER_JOB_STATE", "Publication requires a running job without an accepted stop request");
      return this.update(entry, (record, now) => { record.state = "publishing"; record.publicationStartedAt = now; });
    });
  }
  async finish(projectId: string, jobId: string, token: string, value: RenderJobCompletion) {
    const completion = jobCopy(value); jobObject(completion, ["state", "result", "diagnostic"]);
    if (completion.state === "succeeded") jobObject(completion, ["state", "result"]);
    else if (completion.state === "failed") { jobObject(completion, ["state", "diagnostic"]); validateJobDiagnostic(completion.diagnostic); }
    else if (["cancelled", "timed-out"].includes(completion.state)) jobObject(completion, ["state"]);
    else jobFail("RENDER_JOB_INVALID", "Invalid executor completion");
    return this.schedule(async () => {
      const entry = this.owned(projectId, jobId, token), prior = entry.record;
      if (completion.state === "succeeded") {
        if (prior.state !== "publishing") jobFail("RENDER_JOB_STATE", "Success requires the durable publication barrier");
        validateJobReceipt(completion.result, prior);
      } else if (completion.state === "failed") {
        if (!["running", "stopping", "publishing"].includes(prior.state)) jobFail("RENDER_JOB_STATE", "Failure requires an active executor");
      } else if (prior.state !== "stopping" || prior.stop?.reason !== completion.state) jobFail("RENDER_JOB_STATE", "Stop completion must match the accepted stop request");
      return this.update(entry, (record, now) => {
        record.state = completion.state; record.completedAt = now;
        record.outcomeUnknown = completion.state === "failed" && !!record.publicationStartedAt;
        if (completion.state === "succeeded") record.result = completion.result;
        else record.diagnostic = completion.state === "failed" ? completion.diagnostic : this.stopDiagnostic(completion.state);
      });
    });
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.enqueue(async () => { try { await this.release(); } finally { this.closed = true; } });
    return this.closing;
  }
}
