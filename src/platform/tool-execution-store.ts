import { createHash, randomUUID } from "node:crypto";
import type { ToolExecutionRecord, ToolExecutionReservation, ToolExecutionStore } from "../contracts/agent-tool";

/** Canonical JSON only: reject values which JSON.stringify would silently lose/coerce. */
export function hashToolInput(input: unknown): string {
  const active = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || active.has(value)) throw new Error("Input must be acyclic JSON with finite numbers");
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Input must contain plain JSON objects");
    active.add(value);
    try {
      if (Array.isArray(value)) return Array.from(value, canonical);
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key]);
      return result;
    } finally { active.delete(value); }
  };
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

export function executionIdentity(record: ToolExecutionRecord): string {
  return JSON.stringify([record.id, record.projectId, record.runId, record.callId,
    record.toolId, record.toolVersion, record.idempotencyKey ?? null, record.inputHash, record.startedAt]);
}

export function validateExecutionRecord(record: ToolExecutionRecord): void {
  if (!record || typeof record !== "object") throw new Error("Invalid execution record");
  for (const key of ["id", "projectId", "runId", "callId", "toolId", "toolVersion", "startedAt"] as const) {
    if (typeof record[key] !== "string" || !record[key].trim()) throw new Error(`Invalid execution ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(record.inputHash) || !Number.isFinite(Date.parse(record.startedAt))) throw new Error("Invalid execution hash/timestamp");
  if (record.idempotencyKey !== undefined && (typeof record.idempotencyKey !== "string" || !record.idempotencyKey)) throw new Error("Invalid idempotency key");
  if (!["started", "succeeded", "failed", "cancelled", "timed-out", "interrupted"].includes(record.status)) throw new Error("Invalid execution status");
  if (record.status === "started") {
    if (record.result !== undefined || record.completedAt !== undefined) throw new Error("Started execution cannot have a terminal result");
  } else {
    if (!record.completedAt || !Number.isFinite(Date.parse(record.completedAt)) || !record.result ||
        !Array.isArray(record.result.diagnostics) || record.result.ok !== (record.status === "succeeded")) throw new Error("Invalid terminal execution evidence");
  }
}

type Entry = { record: ToolExecutionRecord; token?: string };

/** Single-store atomic reservations. Persist completes before memory state is published. */
export class InMemoryToolExecutionStore implements ToolExecutionStore {
  protected records = new Map<string, Entry>();
  private tail: Promise<unknown> = Promise.resolve();
  protected async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
  protected assertUsable(): void {}
  protected async persist(_records: ToolExecutionRecord[]): Promise<void> {}
  protected async commit(next: Map<string, Entry>): Promise<void> {
    await this.persist([...next.values()].map(({ record }) => record));
    this.records = next;
  }
  async getByIdempotencyKey(key: string): Promise<ToolExecutionRecord | undefined> {
    return this.exclusive(async () => {
      this.assertUsable();
      const entry = [...this.records.values()].find(({ record }) => record.idempotencyKey === key);
      return entry ? structuredClone(entry.record) : undefined;
    });
  }
  async reserve(input: ToolExecutionRecord): Promise<ToolExecutionReservation> {
    const record = structuredClone(input);
    validateExecutionRecord(record);
    if (record.status !== "started") throw new Error("Reservation must start an execution");
    return this.exclusive(async () => {
      this.assertUsable();
      const byId = this.records.get(record.id);
      if (byId) return { acquired: false, reason: "call-id", record: structuredClone(byId.record) };
      if (record.idempotencyKey) {
        const existing = [...this.records.values()].find((entry) => entry.record.idempotencyKey === record.idempotencyKey);
        if (existing) return { acquired: false, reason: "idempotency", record: structuredClone(existing.record) };
      }
      const token = randomUUID();
      const next = new Map(this.records);
      next.set(record.id, { record, token });
      await this.commit(next);
      return { acquired: true, token, record: structuredClone(record) };
    });
  }
  async finish(input: ToolExecutionRecord, token: string): Promise<void> {
    const record = structuredClone(input);
    validateExecutionRecord(record);
    if (record.status === "started") throw new Error("Finish requires a terminal status");
    return this.exclusive(async () => {
      this.assertUsable();
      const entry = this.records.get(record.id);
      if (!entry || entry.record.status !== "started" || entry.token !== token || !token) throw new Error("Execution reservation is not owned or is already terminal");
      if (executionIdentity(record) !== executionIdentity(entry.record)) throw new Error("Execution identity is immutable");
      const next = new Map(this.records);
      next.set(record.id, { record });
      await this.commit(next);
    });
  }
  async list(projectId?: string): Promise<ToolExecutionRecord[]> {
    return this.exclusive(async () => {
      this.assertUsable();
      return [...this.records.values()].map(({ record }) => record)
        .filter((record) => projectId === undefined || record.projectId === projectId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
        .map((record) => structuredClone(record));
    });
  }
}
