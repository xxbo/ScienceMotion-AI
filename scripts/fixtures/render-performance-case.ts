import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectDocument } from "../../src/contracts/project";
import type { ProjectGraphRenderProgress, ProjectGraphSnapshotRenderer } from "../../src/contracts/renderer";
import type { RenderWorkerEvent } from "../../src/contracts/render-worker";
import { hashProject } from "../../src/platform/project-snapshots";
import { processes, waitReaped, type ObservedProcess } from "./owned-processes";
import type { WaterMotionBaseline } from "./water-motion-baseline";

const [mode, evidence, scenario] = process.argv.slice(2);
assert.ok(mode === "in-process" || mode === "worker" || mode === "worker-prepared" || mode === "svg-ffmpeg");
assert.ok(evidence);
assert.ok(scenario === undefined || (scenario === "engine" && (mode === "in-process" || mode === "svg-ffmpeg")));
assert.ok(mode !== "svg-ffmpeg" || scenario === "engine");
const engineFixture = scenario === "engine"
  ? JSON.parse(await readFile("examples/water-motion-baseline.json", "utf8")) as WaterMotionBaseline
  : undefined;
const project = engineFixture?.snapshot.document ??
  (JSON.parse(await readFile("examples/project-graph-demo.props.json", "utf8")) as { project: ProjectDocument }).project;
const { width, height, fps } = project.sequences[0];
const snapshotHash = hashProject(project);
if (engineFixture) assert.equal(snapshotHash, engineFixture.snapshot.contentHash);
const request = { project, snapshotHash, revisionId: project.revisions.at(-1)!.id, profile: { width, height, fps } };
const previewFrame = engineFixture?.workload.previewFrame ?? 45;
const { startFrame: videoStart, durationFrames: videoFrames } = engineFixture?.workload.video ?? { startFrame: 0, durationFrames: 30 };
const cancelFrames = 180, layoutFrames = [0, 45, 90];
const entryPoint = resolve("src/index.ts");
const round = (ms: number) => Math.round(ms * 10) / 10;
const prepareBundle = mode === "worker-prepared" ? (await import("../../src/renderers/remotion/prepared-render-bundle")).prepareRenderBundle : undefined;
const preparationStarted = performance.now();
const preparedBundle = await prepareBundle?.(entryPoint, join(tmpdir(), "prepared-bundle"));
const preparation = preparedBundle && { elapsedMs: round(performance.now() - preparationStarted), sha256: preparedBundle.sha256 };
let workerEvents: RenderWorkerEvent[] = [];
const worker = mode === "worker" || mode === "worker-prepared"
  ? new (await import("../../src/platform/render-worker")).LocalRenderWorker({ entryPoint,
    ...(preparedBundle ? { policy: { preparedBundle } } : {}), onEvent: event => workerEvents.push(event) })
  : undefined;
const workerProcesses = new Set<number>();
const renderer: ProjectGraphSnapshotRenderer = worker ?? (mode === "svg-ffmpeg"
  ? new (await import("../../src/renderers/svg-ffmpeg/svg-ffmpeg-project-graph-renderer")).SvgFfmpegProjectGraphRenderer()
  : new (await import("../../src/renderers/remotion/remotion-project-graph-renderer")).RemotionProjectGraphRenderer(entryPoint));
const calls: Array<{
  name: string; status: "completed" | "cancelled";
  totalMs: number; startupMs: number; bundleMs: number | null; selectionMs: number;
  renderToSettleMs: number; lastProgressToSettleMs: number; firstEncodingAtMs?: number;
  abortToRejectionMs?: number; abortToReapConfirmationMs?: number; observedCommands?: string[];
}> = [];

async function render(name: string, operation: "preview" | "video" | "layout", cancel = false) {
  workerEvents = [];
  const started = performance.now(), controller = new AbortController();
  const phases: Partial<Record<ProjectGraphRenderProgress["phase"], number>> = {};
  let abortAt: number | undefined, lastProgressAt: number | undefined, sampleError: unknown;
  let observed: ObservedProcess[] = [];
  const onProgress = (progress: ProjectGraphRenderProgress) => {
    const now = performance.now();
    phases[progress.phase] ??= now;
    lastProgressAt = now;
    if (!cancel || abortAt !== undefined || progress.phase !== "rendering" || !(progress.fraction! > 0)) return;
    try {
      const root = worker ? workerEvents.find(event => event.state === "starting")?.processId : process.pid;
      assert.ok(root);
      const tree = processes(root);
      if (!tree.some(p => /chrome/i.test(p.command))) return;
      observed = worker ? tree : tree.filter(p => /chrome|ffmpeg/i.test(p.command));
      abortAt = performance.now();
      controller.abort(new Error("Baseline video cancelled during frame rendering"));
    } catch (error) { sampleError = error; }
  };
  const args = { ...request, signal: controller.signal, onProgress };
  let output, renderError;
  try {
    output = await (operation === "preview" ? renderer.renderPreview({ ...args, frame: previewFrame }) :
      operation === "video" ? renderer.renderVideo({ ...args, startFrame: videoStart, durationFrames: cancel ? cancelFrames : videoFrames }) :
        renderer.measureLayout!({ ...args, frames: layoutFrames }));
  } catch (error) { renderError = error; }
  const settled = performance.now();
  if (sampleError) throw sampleError;
  if (renderError && !controller.signal.aborted) throw renderError;
  assert.ok(phases.selecting !== undefined && phases.rendering !== undefined);
  assert.equal(phases.bundling === undefined, mode === "svg-ffmpeg");
  const startupMs = round((phases.bundling ?? phases.selecting) - started);
  const bundleMs = phases.bundling === undefined ? null : round(phases.selecting - phases.bundling);
  const selectionMs = round(phases.rendering - phases.selecting);
  const renderToSettleMs = round(settled - phases.rendering);
  const totalMs = round(settled - started);
  const timings = { totalMs, startupMs, bundleMs, selectionMs, renderToSettleMs,
    lastProgressToSettleMs: round(settled - lastProgressAt!),
    ...(phases.encoding === undefined ? {} : { firstEncodingAtMs: round(phases.encoding - started) }) };

  if (cancel) {
    assert.ok(abortAt !== undefined && observed.length > 0 && output === undefined, "The running video must cancel after live frame progress");
    assert.ok(renderError instanceof Error, "A cancelled render must reject");
    if (worker) assert.equal((renderError as Error & { code?: string }).code, "RENDER_WORKER_CANCELLED");
    else assert.match(renderError.message, /cancel/i);
    await waitReaped(observed);
    calls.push({ name, ...timings, status: "cancelled", abortToRejectionMs: round(settled - abortAt),
      abortToReapConfirmationMs: round(performance.now() - abortAt), observedCommands: [...new Set(observed.map(p => p.command))].sort() });
  } else {
    assert.ok(output);
    if (operation === "layout") {
      assert.ok(Array.isArray(output));
      assert.deepEqual(output.map(frame => frame.frame), layoutFrames);
      assert.ok(output.every(frame => frame.projectId === project.project.id && frame.viewport.width === width &&
        frame.viewport.height === height && frame.nodes.some(node => node.type === "text")));
      await writeFile(join(evidence, name + ".json"), JSON.stringify(output), { flag: "wx" });
    } else {
      assert.ok(!Array.isArray(output) && output.bytes.byteLength > 0);
      assert.equal(output.mediaType, operation === "preview" ? "image/png" : "video/mp4");
      assert.equal(output.rendererId, renderer.id);
      assert.equal(output.rendererVersion, renderer.version);
      if (worker) assert.equal(output.execution?.kind, "local-process");
      await writeFile(join(evidence, name + (operation === "preview" ? ".png" : ".mp4")), output.bytes, { flag: "wx" });
    }
    calls.push({ name, ...timings, status: "completed" });
  }
  if (worker) {
    const processId = workerEvents.find(event => event.state === "starting")?.processId;
    assert.ok(processId && !workerProcesses.has(processId), "Every render uses a fresh worker process");
    workerProcesses.add(processId);
    assert.equal(worker.status().activeJobs, 0);
    assert.deepEqual((await readdir(tmpdir())).filter(entry => entry.startsWith("sciencemotion-worker-")), []);
  }
  assert.equal(hashProject(project), snapshotHash);
}

try {
  await writeFile(join(evidence, "ready"), "", { flag: "wx" });
  await render("cold-preview", "preview");
  await render("repeat-preview", "preview");
  if (engineFixture) {
    await render("first-video", "video");
    await render("repeat-video", "video");
  } else {
    await render("video", "video");
    await render("layout", "layout");
    await render("cancel-video", "video", true);
    await render("recovery-preview", "preview");
  }
  await writeFile(join(evidence, "calls.json"), JSON.stringify({ mode, ...(preparation ? { preparation } : {}), fixture: {
    projectId: project.project.id, revisionId: request.revisionId, snapshotHash, profile: request.profile,
    ...(engineFixture ? { snapshotId: engineFixture.snapshot.id, source: engineFixture.source, workload: engineFixture.workload,
      renderer: { id: renderer.id, version: renderer.version } } : { previewFrame, videoFrames, cancelFrames, layoutFrames }),
  }, calls }, null, 2), { flag: "wx" });
  const deadline = performance.now() + 5000;
  while (!existsSync(join(evidence, "shutdown"))) {
    assert.ok(performance.now() < deadline, "The supervisor must acknowledge the completed workload");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
} finally {
  await worker?.close();
}
process.exit(0);
