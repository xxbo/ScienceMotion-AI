import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";

const directory = process.argv[2], job = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
const mode = job.request.project.project.name;
const combined = process.env.SCIENCEMOTION_COMBINED_RESOURCE_FIXTURE === "1";
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
    const combined = process.argv[3] === "combined";
    const deadline = performance.now() + (combined ? 24000 : 5000);
    const wait = setInterval(() => {
      if (performance.now() >= deadline) process.exit(71);
      if (!fs.existsSync(gate)) return;
      clearInterval(wait);
      if (mode === "budget-cpu") {
        if (combined) {
          const { Worker } = require("node:worker_threads");
          for (let i = 0; i < 4; i++) {
            new Worker("const end = performance.now() + 18000; while (performance.now() < end) {}", { eval: true });
          }
          return;
        }
        const end = performance.now() + 5000;
        while (performance.now() < end) {}
      } else {
        const blocks = combined ? 56 : 12;
        const blockBytes = (combined ? 32 : 24) * 1024 * 1024;
        const resident = Array.from({ length: blocks }, () => Buffer.alloc(blockBytes, 1));
        if (resident.length !== blocks) process.exit(72);
      }
      process.exit(71);
    }, 10);
  `, mode, join(directory, "start-load"), combined ? "combined" : "individual"], { stdio: "ignore", detached: true });
  const exited = new Promise(resolve => load.once("exit", resolve));
  await writeFile(join(dirname(directory), "budget-processes.json"), JSON.stringify({ renderer: process.pid, load: load.pid, directory, initialMembership }));
  await send({ type: "ready" });
  await exited;
  // The guardian must distinguish a kernel-enforced failure from this fallback.
  process.exit(71);
}
if (mode === "budget-temporary") {
  const load = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const path = require("node:path");
    const temporary = require("node:os").tmpdir();
    const deadline = performance.now() + (process.argv[1] === "combined" ? 24000 : 5000);
    process.on("SIGTERM", () => {});
    const wait = setInterval(() => {
      if (performance.now() >= deadline) process.exit(71);
      if (!fs.existsSync(path.join(temporary, "start-load"))) return;
      clearInterval(wait);
      const fd = fs.openSync(path.join(temporary, "fill"), "wx");
      let written = 0;
      try {
        const block = Buffer.alloc(1024 * 1024, 1);
        for (let i = 0; i < 256; i++) {
          written += fs.writeSync(fd, block);
          fs.fsyncSync(fd);
        }
      } catch (error) {
        if (error.code !== "ENOSPC") throw error;
        process.send({ code: error.code, written });
        setInterval(() => {}, 1000);
        return;
      } finally { fs.closeSync(fd); }
      process.exit(71);
    }, 10);
  `, combined ? "combined" : "individual"], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
  const result = new Promise(resolve => {
    load.once("message", resolve);
    load.once("exit", () => resolve(null));
  });
  await writeFile(join(dirname(directory), "budget-processes.json"), JSON.stringify({ renderer: process.pid, load: load.pid, directory, tmp: process.env.TMPDIR }));
  await send({ type: "ready" });
  const failure = await result;
  if (failure?.code === "ENOSPC")
    await send({ type: "error", code: "RENDER_WORKER_TEMPORARY_LIMIT", message: `Detached write/fsync returned ENOSPC after ${failure.written} bytes` });
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
