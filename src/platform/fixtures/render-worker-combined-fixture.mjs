import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = process.argv[2];
const job = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
const pressureCases = ["budget-cpu", "budget-memory", "budget-temporary"];
const scope = join(directory, "worker-scope.json");
writeFileSync(scope + ".tmp", JSON.stringify({ jobId: job.jobId, pid: process.pid, temporary: tmpdir() }), { flag: "wx" });
renameSync(scope + ".tmp", scope);

function mediaProcessesAreLive() {
  const children = spawnSync("ps", ["-ww", "--ppid", String(process.pid), "-o", "comm=,args="], { encoding: "utf8", timeout: 1000 });
  if (children.status !== 0) return false;
  const lines = children.stdout.split("\n");
  return lines.some(line => /^\s*chrome/.test(line) && line.includes(`--user-data-dir=${directory}/`)) &&
    lines.some(line => /^\s*ffmpeg\s/.test(line) && line.includes(`${directory}/react-motion-render`) && line.includes("/pre-encode.mp4"));
}

if (pressureCases.includes(job.request.project.project.name)) {
  process.env.SCIENCEMOTION_COMBINED_RESOURCE_FIXTURE = "1";
  await import("./render-worker-fixture.mjs");
} else {
  if (job.operation === "video") {
    const send = process.send.bind(process);
    let paused = false;
    process.send = (message, ...args) => {
      const sent = send(message, ...args);
      if (!paused && message.type === "progress" && message.phase === "rendering" && message.fraction > 0 && mediaProcessesAreLive()) {
        paused = true;
        // Hold at a rendered frame while Chromium and FFmpeg are still alive.
        // Sleeping here keeps the test barrier from burning the job's CPU budget.
        writeFileSync(join(directory, "video-paused"), "", { flag: "wx" });
        const resume = join(directory, "resume-video");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = performance.now() + 18500;
        while (!existsSync(resume)) {
          if (performance.now() >= deadline) process.exit(71);
          Atomics.wait(wait, 0, 0, 20);
        }
      }
      return sent;
    };
  }
  await import("../../renderers/remotion/render-worker-entry.ts");
}
