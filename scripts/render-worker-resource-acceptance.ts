import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import type { RenderWorkerEvent, RenderWorkerResourceBudget } from "../src/contracts/render-worker";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import { LocalRenderWorker } from "../src/platform/render-worker";
import { assertReaped, processes, type ObservedProcess } from "./fixtures/owned-processes";

const { values } = parseArgs({ options: { "cgroup-parent": { type: "string" } } });
const cgroupParent = values["cgroup-parent"];
assert.ok(cgroupParent && isAbsolute(cgroupParent), "An operator-delegated --cgroup-parent is required");
assert.equal(process.platform, "linux");
const output = resolve("out/render-worker-resources");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-resource-acceptance-"));
const directory = join(root, "host"), temporary = join(root, "worker"), originalTmp = process.env.TMPDIR;
const events: RenderWorkerEvent[] = [], records: RenderJobRecord[] = [];
const observed: Array<{ jobId: string; group: string; processes: ObservedProcess[] }> = [];
const fixtureBudget = { cpuMillicores: 500, cpuTimeMs: 750, memoryBytes: 192 * 1024 * 1024 };
const videoBudget = { cpuMillicores: 1500, memoryBytes: 1536 * 1024 * 1024 };
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", cgroupParent, fixtureBudget, videoBudget, events, records, observed };
let host: CreativeHost | undefined, worker: LocalRenderWorker | undefined;
let sequence = 0, observerFailure: unknown;

const actor = (projectId: string) => host!.createSession({ projectId,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.shape.create", "project.snapshot.save", "render.preview", "render.video"] });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown): Promise<T> {
  const result = await session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "resources", callId: String(++sequence) });
  assert.ok(result.ok, JSON.stringify(result));
  return result.output as T;
}
async function render(projectId: string, name: string, video = false): Promise<RenderJobRecord> {
  const s = actor(projectId);
  const durationFrames = video ? 180 : 30;
  await invoke(s, "project.create", { name, episodeId: "resource-fixture", durationFrames, width: 640, height: 360, fps: 30 });
  await invoke(s, "project.scene.create", { sceneId: "scene", name, durationFrames });
  await invoke(s, "graphics.2d.shape.create", { sceneId: "scene", nodeId: "shape", primitive: "circle", x: 260, y: 120, width: 120, height: 120, fill: "#55d6e8" });
  const project = await invoke<ProjectDocument>(s, "project.inspect", {});
  const snapshotId = "snapshot";
  await invoke(s, "project.snapshot.save", { snapshotId, revisionId: project.revisions.at(-1)!.id });
  const { record: admitted } = await s.jobs.submit({
    submissionId: projectId, runId: "resources", callId: projectId, toolVersion: "1.0.0",
    ...(video ? { toolId: "render.video", input: { snapshotId, startFrame: 0, durationFrames } }
      : { toolId: "render.preview", input: { snapshotId, frame: 0 } }),
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const record = (await s.jobs.get(admitted.id))!;
    if (!["queued", "running", "stopping", "publishing"].includes(record.state)) {
      records.push(record);
      if (observerFailure) throw observerFailure;
      return record;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Render job ${projectId} did not settle`);
}

function membership(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function verifyGroup(event: RenderWorkerEvent, tree: ObservedProcess[], budget: Required<Pick<RenderWorkerResourceBudget, "cpuMillicores" | "memoryBytes">>) {
  const renderer = tree.find(p => p.parent === event.processId && p.command === "node");
  assert.ok(renderer, "The Node renderer must be a child of the guardian");
  const member = membership(renderer.pid);
  assert.ok(member?.startsWith("0::/"));
  const group = join("/sys/fs/cgroup", member!.slice(3));
  assert.equal(dirname(group), cgroupParent);
  assert.match(group, /\/sciencemotion-render-[^/]+$/);
  assert.equal(membership(event.processId!), membership(process.pid), "The guardian must stay in the host cgroup");
  assert.notEqual(member, membership(process.pid));
  for (const p of tree) {
    if (p.pid !== event.processId) {
      const current = membership(p.pid);
      if (current !== undefined) assert.equal(current, member, `${p.command} must belong to the job cgroup`);
    }
  }
  const control = (name: string) => readFileSync(join(group, name), "utf8").trim();
  assert.equal(control("cpu.max"), `${budget.cpuMillicores * 100} 100000`);
  assert.equal(control("memory.max"), String(budget.memoryBytes));
  assert.equal(control("memory.swap.max"), "0");
  assert.equal(control("memory.oom.group"), "1");
  observed.push({ jobId: event.jobId, group, processes: tree });
  return member;
}
async function clean() {
  assert.deepEqual((await readdir(cgroupParent!)).filter(name => name.startsWith("sciencemotion-render-")), []);
  assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith("sciencemotion-worker-")), []);
  await assertReaped(observed.flatMap(sample => sample.processes));
}

try {
  await mkdir(temporary);
  process.env.TMPDIR = temporary;
  worker = new LocalRenderWorker({
    policy: { cgroupParent, resourceBudget: fixtureBudget },
    workerScript: resolve("src/platform/fixtures/render-worker-fixture.mjs"),
    temporaryDirectory: temporary,
    onEvent: event => {
      events.push(event);
      if (event.state !== "running" || event.projectId === "reused-slot") return;
      try {
        const fixture = JSON.parse(readFileSync(join(temporary, "budget-processes.json"), "utf8"));
        const tree = processes(event.processId!);
        assert.ok(tree.some(p => p.pid === fixture.load && p.group === p.pid && p.parent === fixture.renderer), "Observe the detached workload before starting it");
        assert.equal(fixture.initialMembership.trim(), verifyGroup(event, tree, fixtureBudget));
        writeFileSync(join(fixture.directory, "start-load"), "", { flag: "wx" });
      } catch (error) { observerFailure = error; }
    },
  });
  host = await openCreativeHost({ directory, renderer: worker });
  for (const [kind, expectedCode] of [["cpu", "RENDER_WORKER_CPU_TIME_LIMIT"], ["memory", "RENDER_WORKER_MEMORY_LIMIT"]]) {
    const record = await render(kind, `budget-${kind}`);
    assert.equal(record.state, "failed", JSON.stringify(record));
    assert.equal(record.diagnostic?.code, expectedCode, JSON.stringify(record.diagnostic));
    assert.equal(record.result, undefined);
    const event = events.at(-1)!;
    assert.equal(event.code, expectedCode);
    const counters = event.resourceUsage!;
    assert.ok(counters);
    if (kind === "cpu") {
      assert.ok(BigInt(counters.cpuUsageUsec!) >= BigInt(fixtureBudget.cpuTimeMs) * 1000n);
      assert.ok(BigInt(counters.cpuThrottledPeriods!) > 0n);
      assert.equal(counters.memoryOomKills, "0");
    } else {
      assert.ok(BigInt(counters.memoryOomEvents!) > 0n);
      assert.ok(BigInt(counters.memoryOomKills!) > 0n);
    }
    await clean();
    assert.equal(worker.status().activeJobs, 0);
  }
  assert.equal((await render("reused-slot", "success-child")).state, "succeeded");
  await clean();
  await host.close();
  await worker.close();

  let lastSample = 0;
  const binaries = new Set<string>();
  host = await openCreativeHost({ directory, renderWorker: { cgroupParent, resourceBudget: videoBudget }, onRenderWorkerEvent: event => {
    // Persist transitions and terminal counters. Look for long-lived Chrome and FFmpeg during frame progress.
    if (!event.progress) events.push(event);
    if (!event.progress || !(event.progress.fraction! > 0) || binaries.size === 2 || Date.now() - lastSample < 80) return;
    lastSample = Date.now();
    try {
      const tree = processes(event.processId!);
      const present = tree.filter(p => /chrome|ffmpeg/i.test(p.command) && membership(p.pid));
      if (!present.some(p => !binaries.has(/ffmpeg/i.test(p.command) ? "ffmpeg" : "chrome"))) return;
      verifyGroup(event, tree, videoBudget);
      for (const p of present) binaries.add(/ffmpeg/i.test(p.command) ? "ffmpeg" : "chrome");
    } catch (error) { observerFailure = error; }
  } });
  const video = await render("real-video", "Budgeted video", true);
  assert.equal(video.state, "succeeded", JSON.stringify(video));
  assert.deepEqual([...binaries].sort(), ["chrome", "ffmpeg"]);
  assert.ok(video.result);
  const artifact = await artifacts.get(video.result.artifactId);
  const bytes = Buffer.from((await artifacts.read(video.result.artifactId))!);
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(bytes.length, video.result.sizeBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), video.result.contentHash);
  assert.ok(events.at(-1)?.resourceUsage && BigInt(events.at(-1)!.resourceUsage!.cpuUsageUsec!) > 0n);
  assert.deepEqual((artifact?.metadata?.execution as { resourceUsage?: unknown }).resourceUsage, events.at(-1)!.resourceUsage);
  await writeFile(join(output, "budgeted.mp4"), bytes);
  await clean();
  await host.close();
  host = await openCreativeHost({ directory });
  for (const record of records) assert.deepEqual(await actor(record.input.projectId).jobs.get(record.id), record);
  Object.assign(evidence, { status: "passed", artifact, exactJobsAfterReopen: true });
  console.log("PASS: detached CPU and memory exhaustion, typed durable failures, slot reuse, and budgeted Chromium/FFmpeg video");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    await worker?.close();
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
