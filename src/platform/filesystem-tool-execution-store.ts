import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolExecutionRecord } from "../contracts/agent-tool";
import { InMemoryToolExecutionStore, validateExecutionRecord } from "./tool-execution-store";

const digest = (records: ToolExecutionRecord[]) => createHash("sha256").update(JSON.stringify(records)).digest("hex");

/** Small local ledger: one exclusive writer; no automatic stale-lock stealing. */
export class FileSystemToolExecutionStore extends InMemoryToolExecutionStore {
  private closed = false;
  private poisoned = false;
  private constructor(private readonly directory: string, private readonly lock: FileHandle) { super(); }

  static async open(directory: string): Promise<FileSystemToolExecutionStore> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    const lock = await open(join(root, "writer.lock"), "wx", 0o600);
    const store = new FileSystemToolExecutionStore(root, lock);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() }));
      await lock.sync();
      let text: string;
      try { text = await readFile(join(root, "executions.json"), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
        throw error;
      }
      const ledger = JSON.parse(text) as { schemaVersion: string; records: ToolExecutionRecord[]; contentHash: string };
      if (ledger.schemaVersion !== "1.0.0" || !Array.isArray(ledger.records) || digest(ledger.records) !== ledger.contentHash) throw new Error("Execution ledger integrity/version check failed");
      const ids = new Set<string>(); const keys = new Set<string>();
      let recovered = false;
      for (const original of ledger.records) {
        validateExecutionRecord(original);
        if (ids.has(original.id) || (original.idempotencyKey && keys.has(original.idempotencyKey))) throw new Error("Duplicate execution identity in ledger");
        ids.add(original.id); if (original.idempotencyKey) keys.add(original.idempotencyKey);
        const record = structuredClone(original);
        if (record.status === "started") {
          recovered = true;
          record.status = "interrupted";
          record.completedAt = new Date().toISOString();
          record.errorCode = "TOOL_EXECUTION_INTERRUPTED";
          record.result = { ok: false, diagnostics: [{ level: "error", code: record.errorCode,
            message: "Previous host stopped without terminal evidence; reconcile effects before a new invocation" }], metadata: { outcomeUnknown: true } };
        }
        store.records.set(record.id, { record });
      }
      if (recovered) await store.persist([...store.records.values()].map(({ record }) => record));
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  protected override assertUsable(): void {
    if (this.closed) throw new Error("Execution store is closed");
    if (this.poisoned) throw new Error("Execution persistence outcome is uncertain; reopen and inspect the ledger");
  }
  protected override async persist(records: ToolExecutionRecord[]): Promise<void> {
    this.assertUsable();
    const temporary = join(this.directory, `executions.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: "1.0.0", records, contentHash: digest(records) }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, join(this.directory, "executions.json"));
      // The CI/local reference backend is a POSIX local filesystem, not a network share.
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      this.poisoned = true; // No second mutation after an ambiguous write/rename failure.
      throw error;
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  /** Host must stop admission and drain running tools before releasing the writer lease. */
  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.lock.close();
      await rm(join(this.directory, "writer.lock"));
    });
  }
}
