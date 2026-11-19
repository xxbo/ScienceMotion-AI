import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import type { RenderWorkerEvent } from "../src/contracts/render-worker";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import { LocalRenderWorker } from "../src/platform/render-worker";
import { assertReaped, processes, type ObservedProcess } from "./fixtures/owned-processes";

const { values } = parseArgs({ options: { "temporary-volume": { type: "string" } } });
const supplied = values["temporary-volume"];
assert.ok(supplied && isAbsolute(supplied), "An operator-provisioned --temporary-volume is required");
const volume = await realpath(supplied);
const output = resolve("out/render-worker-temporary");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-temporary-acceptance-"));
const directory = join(root, "host"), staging = join(root, "staging"), originalTmp = process.env.TMPDIR;
const temporaryBytes = 128 * 1024 * 1024;
const policy = { temporaryVolumes: [volume], resourceBudget: { temporaryBytes } };
const events: RenderWorkerEvent[] = [], records: RenderJobRecord[] = [];
const observed: ObservedProcess[][] = [];
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", policy, events, records, observed };
let host: CreativeHost | undefined, worker: LocalRenderWorker | undefined;
let sequence = 0, observerFailure: unknown;

const actor = (projectId: string) => host!.createSession({ projectId,
  permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write", "artifact.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.shape.create", "project.snapshot.save", "render.preview", "render.video"] });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown): Promise<T> {
  const result = await session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "temporary-budget", callId: String(++sequence) });
  assert.ok(result.ok, JSON.stringify(result));
  return result.output as T;
}
async function render(projectId: string, name: string, video = false) {
  const s = actor(projectId);
  const durationFrames = video ? 180 : 30;
  await invoke(s, "project.create", { name, episodeId: "temporary-fixture", durationFrames, width: 640, height: 360, fps: 30 });
  await invoke(s, "project.scene.create", { sceneId: "scene", name, durationFrames });
  await invoke(s, "graphics.2d.shape.create", { sceneId: "scene", nodeId: "shape", primitive: "circle", x: 260, y: 120, width: 120, height: 120, fill: "#55d6e8" });
  const project = await invoke<ProjectDocument>(s, "project.inspect", {});
  const snapshotId = "snapshot-" + projectId;
  await invoke(s, "project.snapshot.save", { snapshotId, revisionId: project.revisions.at(-1)!.id });
  const { record: admitted } = await s.jobs.submit({ submissionId: projectId, runId: "temporary-budget", callId: projectId, toolVersion: "1.0.0",
    ...(video ? { toolId: "render.video", input: { snapshotId, startFrame: 0, durationFrames } }
      : { toolId: "render.preview", input: { snapshotId, frame: 0 } }) });
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

function procFields(pid: number, file: "cmdline" | "environ") {
  try { return readFileSync(`/proc/${pid}/${file}`, "utf8").split("\0"); }
  catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; return []; }
}
function activeRoot() {
  const job = readdirSync(volume).find(name => name.startsWith("sciencemotion-disk-"));
  return job && join(volume, job);
}
const initial = await statfs(volume);
async function clean() {
  const after = await statfs(volume);
  assert.ok(after.bavail >= initial.bavail && after.ffree >= initial.ffree, "The volume's blocks and inodes must be reclaimed");
  assert.deepEqual((await readdir(volume)).filter(name => name !== "lost+found"), []);
  assert.deepEqual(await readdir(staging), []);
  await assertReaped(observed.flat());
  return { availableBytes: after.bavail * after.bsize, freeInodes: after.ffree };
}

try {
  await mkdir(staging);
  process.env.TMPDIR = staging;
  assert.throws(() => new LocalRenderWorker({ policy: { ...policy, resourceBudget: { temporaryBytes: temporaryBytes - 1 } } }),
    { code: "RENDER_WORKER_RESOURCE_UNAVAILABLE" });
  worker = new LocalRenderWorker({ policy, workerScript: resolve("src/platform/fixtures/render-worker-fixture.mjs"),
    onEvent: event => {
      events.push(event);
      if (event.state !== "running" || event.projectId !== "disk-full") return;
      try {
        const jobRoot = activeRoot();
        assert.ok(jobRoot);
        const fixture = JSON.parse(readFileSync(join(jobRoot, "budget-processes.json"), "utf8"));
        const tree = processes(event.processId!);
        assert.ok(tree.some(p => p.pid === fixture.load && p.group === p.pid && p.parent === fixture.renderer), "Observe a detached filesystem writer");
        assert.equal(fixture.tmp, join(jobRoot, "work"));
        assert.equal(fixture.directory, fixture.tmp);
        assert.throws(() => new LocalRenderWorker({ policy }), { code: "RENDER_WORKER_RESOURCE_UNAVAILABLE" }, "A second worker cannot take the leased volume");
        observed.push(tree);
        writeFileSync(join(fixture.directory, "start-load"), "", { flag: "wx" });
      } catch (error) { observerFailure = error; }
    },
  });
  host = await openCreativeHost({ directory, renderer: worker });
  const full = await render("disk-full", "budget-temporary");
  assert.equal(full.state, "failed", JSON.stringify(full));
  assert.equal(full.diagnostic?.code, "RENDER_WORKER_TEMPORARY_LIMIT");
  const kernelError = /ENOSPC after (\d+) bytes/.exec(full.diagnostic.message);
  assert.ok(kernelError, JSON.stringify(full.diagnostic));
  assert.ok(Number(kernelError[1]) > temporaryBytes / 2 && Number(kernelError[1]) <= temporaryBytes);
  assert.equal(full.result, undefined);
  const exhausted = events.at(-1)!;
  assert.equal(exhausted.code, full.diagnostic.code);
  assert.equal(exhausted.resourceUsage?.temporaryCapacityBytes, String(temporaryBytes));
  assert.ok(Number(exhausted.resourceUsage?.temporaryMinimumAvailableBytes) < 1024 * 1024);
  const reclaimed = await clean();
  assert.equal(worker.status().activeJobs, 0);
  assert.equal((await render("disk-reuse", "success-child")).state, "succeeded");
  await clean();
  await host.close();
  await worker.close();

  let lastSample = 0;
  let mediaPaths: { work: string; browserProfile: string; encoderOutput: string; bundle: string; intermediates: string } | undefined;
  host = await openCreativeHost({ directory, renderWorker: policy, onRenderWorkerEvent: event => {
    if (!event.progress) events.push(event);
    if (mediaPaths || !event.progress || !(event.progress.fraction! > 0) || Date.now() - lastSample < 80) return;
    lastSample = Date.now();
    try {
      const jobRoot = activeRoot();
      if (!jobRoot) return;
      const work = join(jobRoot, "work");
      const tree = processes(event.processId!);
      const browser = tree.filter(p => /chrome/i.test(p.command)).flatMap(p => procFields(p.pid, "cmdline"));
      const encoder = tree.filter(p => /ffmpeg/i.test(p.command)).flatMap(p => procFields(p.pid, "cmdline"));
      const browserProfile = browser.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
      const encoderOutput = encoder.find(arg => arg.startsWith(work + "/"));
      if (!browserProfile || !encoderOutput) return;
      const renderer = tree.find(p => p.parent === event.processId && procFields(p.pid, "environ").includes(`TMPDIR=${work}`));
      assert.ok(renderer, "The Node renderer inherits the bounded temporary directory");
      assert.ok(browserProfile.startsWith(work + "/"));
      const names = readdirSync(work);
      const bundle = names.find(name => name.startsWith("remotion-webpack-bundle-"));
      const intermediates = names.find(name => name.startsWith("react-motion-render"));
      assert.ok(bundle && intermediates, "The bundle and video intermediates must be on the volume");
      mediaPaths = { work, browserProfile, encoderOutput, bundle, intermediates };
      observed.push(tree);
    } catch (error) { observerFailure = error; }
  } });
  const video = await render("disk-video", "Disk-budgeted video", true);
  assert.equal(video.state, "succeeded", JSON.stringify(video));
  assert.ok(mediaPaths, "Observe Chromium's profile and FFmpeg's output on the volume during a real render");
  assert.ok(video.result);
  const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
  const artifact = await artifacts.get(video.result.artifactId);
  const bytes = Buffer.from((await artifacts.read(video.result.artifactId))!);
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(bytes.length, video.result.sizeBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), video.result.contentHash);
  const usage = events.at(-1)!.resourceUsage;
  assert.equal(usage?.temporaryCapacityBytes, String(temporaryBytes));
  assert.ok(Number(usage!.temporaryMinimumAvailableBytes) < initial.bavail * initial.bsize);
  assert.deepEqual((artifact?.metadata?.execution as { resourceUsage?: unknown }).resourceUsage, usage);
  await writeFile(join(output, "budgeted.mp4"), bytes);
  await clean();
  await host.close();
  host = await openCreativeHost({ directory });
  for (const record of records) assert.deepEqual(await actor(record.input.projectId).jobs.get(record.id), record);
  Object.assign(evidence, { status: "passed", kernelErrno: "ENOSPC", bytesWritten: Number(kernelError[1]), reclaimed, mediaPaths, artifact, exactJobsAfterReopen: true });
  console.log("PASS: detached writer hit ENOSPC, volume and worker reused, Chromium/FFmpeg rendered on the volume, records survived reopening");
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
