import { randomUUID } from "node:crypto";
import type { ProjectGraphRenderProgress } from "../contracts/renderer";
import { RENDER_JOB_SCHEMA_VERSION, type PrunedRenderJob, type RenderJobCompletion, type RenderJobEvidence,
  type RenderJobReceipt, type RenderJobReconciliation, type RenderJobReconciliationRequest, type RenderJobRecord,
  type RenderJobRelease, type RenderJobRetention, type RenderJobStore, type RenderJobSubmission, type RenderJobStopReason } from "../contracts/render-job";
import { hashToolInput } from "./tool-execution-store";
import { activeJobStates, jobCopy, jobFail, jobIdentity, jobInteger, jobObject, MAX_RENDER_JOB_RECORD_BYTES, progressPhases, RenderJobError,
  hasUntrackedPublication, knownJobOutput, needsJobReconciliation, validateJobDiagnostic, validateJobProgress, validateJobReceipt, validateJobRecord,
  validateJobRetention, validateJobSubmission, validatePrunedJob, validateReconciliationRequest } from "./render-job-validation";

export interface RenderJobStoreOptions {
  /** Ledger retention capacity, not scheduler capacity. Records are never silently evicted. */
  maxJobs?: number;
  maxLedgerBytes?: number;
  progressIntervalMs?: number;
  /** Trusted embedding/test clock. Timestamps never move backwards within a job. */
  now?: () => Date;
}
type Entry = { record: RenderJobRecord; token?: string; retention?: RenderJobRetention };
export type PersistedRenderJob = RenderJobRecord & { retention?: RenderJobRetention };
const submissionKey = (input: Pick<RenderJobSubmission, "projectId" | "submissionId">) => JSON.stringify([input.projectId, input.submissionId]);

/** Atomic state transitions in one store. Filesystem subclass persists before publishing memory or acknowledgements. */
export class InMemoryRenderJobStore implements RenderJobStore {
  protected records = new Map<string, Entry>();
  private pruned = new Map<string, PrunedRenderJob>();
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
  protected envelope(records: PersistedRenderJob[], pruned: PrunedRenderJob[]): string {
    const data = { schemaVersion: RENDER_JOB_SCHEMA_VERSION, records, ...(pruned.length ? { pruned } : {}) };
    const text = JSON.stringify({ ...data, contentHash: hashToolInput(data) });
    // Reserve space until release completes so a full ledger can still settle and release admitted jobs.
    const reservedGrowth = records.reduce((bytes, record) => bytes + (!record.retention?.release?.completedAt
      ? MAX_RENDER_JOB_RECORD_BYTES - Buffer.byteLength(JSON.stringify(record)) : 0), 0);
    if (Buffer.byteLength(text) + reservedGrowth > this.maxLedgerBytes) jobFail("RENDER_JOB_CAPACITY", "Job ledger byte capacity, including reserved completion space, reached");
    return text;
  }
  protected async persist(_text: string): Promise<void> {}
  protected async release(): Promise<void> {}
  protected async commit(next: Map<string, Entry>, pruned = this.pruned): Promise<void> {
    const records = [...next.values()].map(({ record, retention }) => retention ? { ...record, retention } : record);
    if (records.length > this.maxJobs) jobFail("RENDER_JOB_CAPACITY", "Job ledger record capacity reached");
    const text = this.envelope(records, [...pruned.values()]); // Rejected bounds do not poison storage or drop older records.
    try { await this.persist(text); }
    catch (error) {
      this.poisoned = true;
      throw new RenderJobError("RENDER_JOB_PERSISTENCE_UNCERTAIN", `Job ledger write failed; reopen and reconcile: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.records = next; this.pruned = pruned;
  }
  protected async restore(records: PersistedRenderJob[], pruned: PrunedRenderJob[]): Promise<void> {
    if (records.length > this.maxJobs) jobFail("RENDER_JOB_CAPACITY", "Saved job count exceeds configured capacity");
    const next = new Map<string, Entry>(), tombstones = new Map<string, PrunedRenderJob>();
    const keys = new Set<string>(); let recovered = false;
    for (const tombstone of pruned) {
      validatePrunedJob(tombstone);
      const key = submissionKey(tombstone);
      if (tombstones.has(tombstone.id) || keys.has(key)) jobFail("RENDER_JOB_CORRUPT", "Duplicate pruned job/submission identity");
      tombstones.set(tombstone.id, structuredClone(tombstone)); keys.add(key);
    }
    for (const saved of records) {
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) jobFail("RENDER_JOB_CORRUPT", "Invalid persisted job");
      const { retention, ...original } = saved;
      validateJobRecord(original);
      const key = submissionKey(original.input);
      if (next.has(original.id) || tombstones.has(original.id) || keys.has(key)) jobFail("RENDER_JOB_CORRUPT", "Duplicate persisted job/submission identity");
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
      if (retention !== undefined) {
        validateJobRetention(original, retention);
        validateJobRetention(record, retention);
      }
      next.set(record.id, { record, retention: structuredClone(retention) }); // Executor tokens never survive reopen.
    }
    if (recovered) await this.commit(next, tombstones);
    else { this.records = next; this.pruned = tombstones; }
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
  private async update(entry: Entry, mutate: (record: RenderJobRecord, now: string) => void,
    token = entry.token, retention = entry.retention): Promise<RenderJobRecord> {
    const record = structuredClone(entry.record), now = this.timestamp(record.updatedAt);
    record.updatedAt = now; record.revision++; mutate(record, now); validateJobRecord(record);
    if (retention) validateJobRetention(record, retention);
    const next = new Map(this.records); next.set(record.id, { record, retention, ...(activeJobStates.has(record.state) && token ? { token } : {}) });
    await this.commit(next); return structuredClone(record);
  }
  private lookupSubmission(projectId: string, submissionId: string): RenderJobRecord | PrunedRenderJob | undefined {
    const key = submissionKey({ projectId, submissionId });
    const entry = [...this.records.values()].find(entry => submissionKey(entry.record.input) === key);
    return entry?.record ?? [...this.pruned.values()].find(job => submissionKey(job) === key);
  }
  async findSubmission(projectId: string, submissionId: string) {
    jobIdentity(projectId); jobIdentity(submissionId);
    return this.schedule(async () => structuredClone(this.lookupSubmission(projectId, submissionId)));
  }
  async submit(value: RenderJobSubmission) {
    const input = jobCopy(value); validateJobSubmission(input); const inputHash = hashToolInput(input);
    return this.schedule(async () => {
      const existing = this.lookupSubmission(input.projectId, input.submissionId);
      if (existing) {
        if (existing.inputHash !== inputHash) jobFail("RENDER_JOB_CONFLICT", "Submission identity is already bound to different input");
        if ("prunedAt" in existing) return jobFail("RENDER_JOB_PRUNED", "Submission history was pruned; this identity cannot be re-executed");
        return { created: false, record: structuredClone(existing) };
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
  private projectRecords(projectId: string): RenderJobRecord[] {
    return [...this.records.values()].map(entry => entry.record).filter(record => record.input.projectId === projectId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  }
  async listProject(projectId: string) {
    jobIdentity(projectId);
    return this.schedule(async () => structuredClone(this.projectRecords(projectId)));
  }
  async list(projectId: string, query: { offset?: number; limit?: number } = {}) {
    jobIdentity(projectId); const q = jobCopy(query); jobObject(q, ["offset", "limit"]);
    const offset = q.offset ?? 0, limit = q.limit ?? 50; jobInteger(offset); jobInteger(limit, 1, 200);
    return this.schedule(async () => {
      const records = this.projectRecords(projectId);
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
  async beginPublication(projectId: string, jobId: string, token: string, candidate?: RenderJobReceipt) {
    const publication = candidate === undefined ? undefined : jobCopy(candidate);
    return this.schedule(async () => {
      const entry = this.owned(projectId, jobId, token);
      if (entry.record.state !== "running") jobFail("RENDER_JOB_STATE", "Publication requires a running job without an accepted stop request");
      return this.update(entry, (record, now) => { record.state = "publishing"; record.publicationStartedAt = now; },
        token, publication !== undefined ? { publication } : undefined);
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
        if (entry.retention?.publication && hashToolInput(completion.result) !== hashToolInput(entry.retention.publication))
          jobFail("RENDER_JOB_INVALID", "Success receipt differs from the publication candidate");
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
  async inspectRetention(projectId: string, jobId: string): Promise<RenderJobEvidence | PrunedRenderJob | undefined> {
    jobIdentity(projectId); jobIdentity(jobId);
    return this.schedule(async () => {
      const entry = this.records.get(jobId), tombstone = this.pruned.get(jobId);
      if (entry?.record.input.projectId === projectId) return structuredClone({ record: entry.record, retention: entry.retention ?? {} });
      return tombstone?.projectId === projectId ? structuredClone(tombstone) : undefined;
    });
  }
  private async updateRetention(entry: Entry, retention: RenderJobRetention): Promise<void> {
    validateJobRetention(entry.record, retention);
    const next = new Map(this.records); next.set(entry.record.id, { ...entry, retention });
    await this.commit(next);
  }
  async reconcile(projectId: string, jobId: string, value: Omit<RenderJobReconciliationRequest, "artifactId">, candidate?: RenderJobReceipt) {
    const decision = jobCopy(value), result = candidate === undefined ? undefined : jobCopy(candidate);
    jobObject(decision, ["action", "reason"]); validateReconciliationRequest(decision);
    return this.schedule(async () => {
      const entry = this.current(projectId, jobId), retention = entry.retention ?? {};
      const prior = retention.reconciliation;
      if (prior) {
        if (prior.action === decision.action && prior.reason === decision.reason &&
            (prior.action === "discard" ? result === undefined : result !== undefined && hashToolInput(prior.result) === hashToolInput(result)))
          return structuredClone(prior);
        return jobFail("RENDER_JOB_RECONCILIATION_CONFLICT", "Job already has a different reconciliation decision");
      }
      if (!needsJobReconciliation(entry.record, retention)) jobFail("RENDER_JOB_STATE", "Job has no unresolved terminal outcome");
      const decidedAt = this.timestamp(entry.record.completedAt);
      if ((decision.action === "retain-output") !== (result !== undefined)) jobFail("RENDER_JOB_INVALID", "Reconciliation output must match the decision");
      const reconciliation: RenderJobReconciliation = result
        ? { action: "retain-output", reason: decision.reason, decidedAt, result }
        : { action: "discard", reason: decision.reason, decidedAt };
      await this.updateRetention(entry, { ...retention, reconciliation });
      return structuredClone(reconciliation);
    });
  }
  async releaseRetention(projectId: string, jobId: string, complete = false): Promise<RenderJobRelease> {
    return this.schedule(async () => {
      const entry = this.current(projectId, jobId), retention = entry.retention ?? {}, previous = retention.release;
      if (activeJobStates.has(entry.record.state) || needsJobReconciliation(entry.record, retention))
        jobFail("RENDER_JOB_STATE", "Release requires a resolved terminal job");
      if (previous && (!complete || previous.completedAt)) return structuredClone(previous);
      if (complete && !previous) jobFail("RENDER_JOB_STATE", "Release intent must be durable before completion");
      const release = previous ? { ...previous, completedAt: this.timestamp(previous.requestedAt) }
        : { requestedAt: this.timestamp(retention.reconciliation?.decidedAt ?? entry.record.completedAt) };
      await this.updateRetention(entry, { ...retention, release });
      return structuredClone(release);
    });
  }
  async prune(projectId: string, jobId: string, requestHash: string): Promise<PrunedRenderJob> {
    return this.schedule(async () => {
      const prior = this.pruned.get(jobId);
      if (prior?.projectId === projectId) return structuredClone(prior);
      const entry = this.current(projectId, jobId), release = entry.retention?.release;
      if (!release?.completedAt) return jobFail("RENDER_JOB_STATE", "Pruning requires completed retention release");
      const job = entry.record, reconciliation = entry.retention?.reconciliation;
      const tombstone = { id: job.id, projectId, submissionId: job.input.submissionId, inputHash: job.inputHash, requestHash,
        release: { ...release, completedAt: release.completedAt }, prunedAt: this.timestamp(release.completedAt),
        ...(reconciliation ? { reconciliation } : {}) };
      validatePrunedJob(tombstone);
      const records = new Map(this.records); records.delete(jobId);
      const pruned = new Map(this.pruned); pruned.set(jobId, tombstone);
      await this.commit(records, pruned);
      return structuredClone(tombstone);
    });
  }
  async snapshotIsPinned(projectId: string, snapshotId: string): Promise<boolean> {
    return this.schedule(async () => [...this.records.values()].some(({ record, retention }) =>
      record.input.projectId === projectId && record.input.snapshot.id === snapshotId &&
      (activeJobStates.has(record.state) || needsJobReconciliation(record, retention ?? {}))));
  }
  async garbageCollectionProtection() {
    return this.schedule(async () => {
      const artifactIds = new Set<string>();
      let untrackedPublication: { projectId: string; jobId: string } | undefined;
      for (const { record, retention = {} } of this.records.values()) {
        if (!untrackedPublication && hasUntrackedPublication(record, retention))
          untrackedPublication = { projectId: record.input.projectId, jobId: record.id };
        if (retention.release?.completedAt) continue;
        const output = knownJobOutput(record, retention);
        if (output) artifactIds.add(output.artifactId);
      }
      return { artifactIds: [...artifactIds], untrackedPublication };
    });
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.enqueue(async () => { try { await this.release(); } finally { this.closed = true; } });
    return this.closing;
  }
}
