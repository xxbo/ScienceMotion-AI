import { constants } from "node:fs";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RENDER_JOB_SCHEMA_VERSION, type RenderJobRecord } from "../contracts/render-job";
import { InMemoryRenderJobStore, type RenderJobStoreOptions } from "./render-job-store";
import { jobFail, jobObject, RenderJobError } from "./render-job-validation";
import { hashToolInput } from "./tool-execution-store";
import { publishLocalFile } from "./local-file-publication";

/** POSIX local ledger: synced atomic publication, one exclusive writer, no automatic stale-lock takeover. */
export class FileSystemRenderJobStore extends InMemoryRenderJobStore {
  private lock?: FileHandle;
  private constructor(private readonly directory: string, options: RenderJobStoreOptions) { super(options); }

  static async open(directory: string, options: RenderJobStoreOptions = {}): Promise<FileSystemRenderJobStore> {
    const root = resolve(directory), store = new FileSystemRenderJobStore(root, options);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Acquisition happens outside the cleanup path: never release another owner's existing lock.
    store.lock = await open(join(root, "writer.lock"), "wx", 0o600);
    try {
      await store.lock.writeFile(JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() })); await store.lock.sync();
      const text = await store.readLedger();
      if (text === undefined) await store.commit(new Map());
      else {
        let records: RenderJobRecord[];
        try {
          const envelope = JSON.parse(text);
          jobObject(envelope, ["schemaVersion", "records", "contentHash"]);
          if (envelope.schemaVersion !== RENDER_JOB_SCHEMA_VERSION || !Array.isArray(envelope.records) ||
              envelope.contentHash !== hashToolInput({ schemaVersion: envelope.schemaVersion, records: envelope.records })) throw new Error("Version/checksum mismatch");
          records = envelope.records;
        } catch { return jobFail("RENDER_JOB_CORRUPT", "Job ledger integrity/version check failed"); }
        try { await store.restore(records); }
        catch (error) {
          if (error instanceof RenderJobError && error.code === "RENDER_JOB_INVALID") jobFail("RENDER_JOB_CORRUPT", "Persisted job evidence is inconsistent");
          throw error;
        }
      }
      return store;
    } catch (error) {
      try { await store.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Job ledger startup and lock release failed"); }
      throw error;
    }
  }
  private async readLedger(): Promise<string | undefined> {
    let file: FileHandle;
    try { file = await open(join(this.directory, "jobs.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxLedgerBytes) jobFail("RENDER_JOB_CORRUPT", "Job ledger is not a bounded regular file");
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) jobFail("RENDER_JOB_CORRUPT", "Job ledger was truncated"); offset += result.bytesRead;
      }
      if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) jobFail("RENDER_JOB_CORRUPT", "Job ledger changed while reading");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return jobFail("RENDER_JOB_CORRUPT", "Job ledger is not valid UTF-8"); }
    } finally { await file.close(); }
  }
  protected override async persist(text: string): Promise<void> { await this.writeLedger(text); }
  private async writeLedger(text: string): Promise<void> { await publishLocalFile(join(this.directory, "jobs.json"), text); }
  protected override async release(): Promise<void> {
    if (!this.lock) return;
    const lock = this.lock; this.lock = undefined;
    // Do not unlink a replacement lock if external recovery incorrectly ran while this writer was alive.
    let current: FileHandle | undefined;
    try {
      current = await open(join(this.directory, "writer.lock"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const [owned, found] = await Promise.all([lock.stat(), current.stat()]);
      if (owned.dev !== found.dev || owned.ino !== found.ino) throw new RenderJobError("RENDER_JOB_LOCK_CHANGED", "Writer lock ownership changed; replacement lock retained");
      await rm(join(this.directory, "writer.lock"));
    } finally { try { await current?.close(); } finally { await lock.close(); } }
  }
}
