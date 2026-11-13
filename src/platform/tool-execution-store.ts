import { createHash } from "node:crypto";
import type { ToolExecutionRecord, ToolExecutionStore } from "../contracts/agent-tool";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

export function hashToolInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
}

export class InMemoryToolExecutionStore implements ToolExecutionStore {
  private readonly records = new Map<string, ToolExecutionRecord>();
  private readonly idempotency = new Map<string, string>();

  async getByIdempotencyKey(key: string): Promise<ToolExecutionRecord | undefined> {
    const id = this.idempotency.get(key);
    const record = id ? this.records.get(id) : undefined;
    return record ? structuredClone(record) : undefined;
  }

  async save(record: ToolExecutionRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`Execution record already exists: ${record.id}`);
    if (record.idempotencyKey && this.idempotency.has(record.idempotencyKey)) {
      throw new Error(`Idempotency key already exists: ${record.idempotencyKey}`);
    }
    this.records.set(record.id, structuredClone(record));
    if (record.idempotencyKey) this.idempotency.set(record.idempotencyKey, record.id);
  }

  async update(record: ToolExecutionRecord): Promise<void> {
    if (!this.records.has(record.id)) throw new Error(`Execution record not found: ${record.id}`);
    this.records.set(record.id, structuredClone(record));
  }

  async list(projectId?: string): Promise<ToolExecutionRecord[]> {
    return [...this.records.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .map((record) => structuredClone(record))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
