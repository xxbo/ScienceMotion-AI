import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";

const directory = process.argv[2], job = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
const mode = job.request.project.project.name;
const send = message => new Promise((resolve, reject) => process.send({ protocolVersion: "1.0.0", jobId: job.jobId, ...message }, error => error ? reject(error) : resolve()));
process.on("SIGTERM", () => {}); // Deliberately non-cooperative test renderer.
if (mode === "cleanup") {
  const nested = join(directory, "cleanup", ...Array.from({ length: 32 }, () => "nested"));
  await mkdir(nested, { recursive: true });
  await Promise.all(Array.from({ length: 256 }, (_, i) => writeFile(join(nested, String(i)), "temporary render data")));
}
if (["spin", "crash", "late", "result-hang", "success-child"].includes(mode)) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  await writeFile(join(dirname(directory), "descendant.json"), JSON.stringify({ pid: child.pid, parent: process.pid }));
}
if (mode === "budget-cpu" || mode === "budget-memory") {
  const initialMembership = await readFile("/proc/self/cgroup", "utf8");
  const load = spawn(process.execPath, ["-e", `
    const fs = require("node:fs"), mode = process.argv[1], gate = process.argv[2];
    const deadline = performance.now() + 5000;
    const wait = setInterval(() => {
      if (performance.now() >= deadline) process.exit(71);
      if (!fs.existsSync(gate)) return;
      clearInterval(wait);
      if (mode === "budget-cpu") {
        const end = performance.now() + 5000;
        while (performance.now() < end) {}
      } else {
        const resident = Array.from({ length: 12 }, () => Buffer.alloc(24 * 1024 * 1024, 1));
        if (resident.length !== 12) process.exit(72);
      }
      process.exit(71);
    }, 10);
  `, mode, join(directory, "start-load")], { stdio: "ignore", detached: true });
  const exited = new Promise(resolve => load.once("exit", resolve));
  await writeFile(join(dirname(directory), "budget-processes.json"), JSON.stringify({ renderer: process.pid, load: load.pid, directory, initialMembership }));
  await send({ type: "ready" });
  await exited;
  // The guardian must distinguish a kernel-enforced failure from this fallback.
  process.exit(71);
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
