import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";

const directory = process.argv[2], job = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
const mode = job.request.project.project.name;
const send = message => new Promise((resolve, reject) => process.send({ protocolVersion: "1.0.0", jobId: job.jobId, ...message }, error => error ? reject(error) : resolve()));
process.on("SIGTERM", () => {}); // Deliberately non-cooperative test renderer.
if (["spin", "crash", "late", "result-hang", "success-child"].includes(mode)) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  await writeFile(join(dirname(directory), "descendant.json"), JSON.stringify({ pid: child.pid, parent: process.pid }));
}
await writeFile(join(dirname(directory), "worker.json"), JSON.stringify({ pid: process.pid, args: process.execArgv, tmp: process.env.TMPDIR }));
await send({ type: "ready" });
if (mode === "duplicate") await send({ type: "ready" });
if (mode === "crash") process.exit(17);
if (mode === "empty-exit") process.exit(0);
if (mode === "spin") { while (true) { /* Force OS termination, not cooperative AbortSignal. */ } }
if (mode === "late") await new Promise(resolve => setTimeout(resolve, 250));
const bytes = mode === "oversize" ? Buffer.alloc(job.maxOutputBytes + 1) : Buffer.from([137,80,78,71,13,10,26,10,42]);
if (mode === "symlink") {
  const target = join(dirname(directory), "sentinel.bin"); await writeFile(target, bytes); await symlink(target, join(directory, "output.bin"));
} else await writeFile(join(directory, "output.bin"), bytes);
await send({ type: "result", operation: job.operation, projectId: job.request.project.project.id,
  revisionId: job.request.revisionId, snapshotHash: mode === "identity" ? "0".repeat(64) : job.request.snapshotHash,
  rendererId: "remotion.project-graph", rendererVersion: "1.0.0", bytes: bytes.length,
  sha256: mode === "hash" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") });
if (mode === "result-hang") setInterval(() => {}, 1000);
else process.disconnect();
// An intentionally orphanable descendant must not survive a successful leader exit either.
if (mode === "success-child" || mode === "late") process.exit(0);
