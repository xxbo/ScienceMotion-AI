import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { CreativeClientRequest, CreativeClientResponse } from "../../src/contracts/creative-client";

type Request = CreativeClientRequest extends infer T ? T extends CreativeClientRequest ? Omit<T, "id"> : never : never;
type Ready = { type: "ready"; protocolVersion: string; jobsVersion: string; methods: string[] };
export class CreativeCli {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<Ready>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr = "";
  private sequence = 0;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(config: string, temporaryDirectory: string) {
    this.child = spawn(process.execPath, ["--import", "tsx", "scripts/creative-host-server.ts", "--config", config], {
      stdio: "pipe", env: { ...process.env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + String(chunk)).slice(-16384); });
    this.child.stdin.on("error", error => { for (const p of this.pending.values()) p.reject(error); });
    const lines = createInterface({ input: this.child.stdout });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CLI ready timeout")), 20000);
      lines.on("line", line => {
        try {
          const value = JSON.parse(line) as Ready | CreativeClientResponse;
          if ("type" in value && value.type === "ready") { clearTimeout(timer); resolve(value); return; }
          const response = value as CreativeClientResponse, p = this.pending.get(response.id!);
          assert.ok(p, `Unexpected CLI response: ${line}`);
          this.pending.delete(response.id!);
          if (response.ok) p.resolve(response.result);
          else p.reject(new Error(JSON.stringify(response.error)));
        } catch (error) {
          clearTimeout(timer); reject(error);
          for (const p of this.pending.values()) p.reject(error as Error);
        }
      });
      void this.exited.then(status => {
        clearTimeout(timer);
        const error = new Error(`CLI exited ${JSON.stringify(status)}: ${this.stderr}`);
        reject(error); for (const p of this.pending.values()) p.reject(error); this.pending.clear();
      }, reject);
    });
  }
  async request<T>(request: Request): Promise<T> {
    const id = `b3-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CLI request timeout: ${request.method}`)); }, 45000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(JSON.stringify({ id, ...request }) + "\n");
    });
  }
  async close() {
    assert.deepEqual(await this.request({ method: "close", params: {} }), { closed: true });
    this.child.stdin.end(); assert.deepEqual(await this.exited, { code: 0, signal: null }, this.stderr);
  }
}
