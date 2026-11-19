import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectDocument } from "../../src/contracts/project";
import type { ProjectGraphRenderProgress } from "../../src/contracts/renderer";
import type { RenderWorkerEvent } from "../../src/contracts/render-worker";
import { hashProject } from "../../src/platform/project-snapshots";
import { LocalRenderWorker } from "../../src/platform/render-worker";
import { RemotionProjectGraphRenderer } from "../../src/renderers/remotion/remotion-project-graph-renderer";
import { processes, waitReaped, type ObservedProcess } from "./owned-processes";

const [mode, evidence] = process.argv.slice(2);
assert.ok(mode === "in-process" || mode === "worker");
assert.ok(evidence);
const fixture = JSON.parse(await readFile("examples/project-graph-demo.props.json", "utf8")) as { project: ProjectDocument };
const project = fixture.project;
const { width, height, fps } = project.sequences[0];
const snapshotHash = hashProject(project);
const request = { project, snapshotHash, revisionId: project.revisions.at(-1)!.id, profile: { width, height, fps } };
const previewFrame = 45, videoFrames = 30, cancelFrames = 180, layoutFrames = [0, 45, 90];
const entryPoint = resolve("src/index.ts");
let workerEvents: RenderWorkerEvent[] = [];
const worker = mode === "worker" ? new LocalRenderWorker({ entryPoint, onEvent: event => workerEvents.push(event) }) : undefined;
const renderer = worker ?? new RemotionProjectGraphRenderer(entryPoint);
const calls: Array<{
  name: string; status: "completed" | "cancelled";
  totalMs: number; startupMs: number; bundleMs: number; selectionMs: number;
  renderToSettleMs: number; lastProgressToSettleMs: number; firstEncodingAtMs?: number;
  abortToRejectionMs?: number; abortToReapConfirmationMs?: number; observedCommands?: string[];
}> = [];
const round = (ms: number) => Math.round(ms * 10) / 10;

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
      operation === "video" ? renderer.renderVideo({ ...args, startFrame: 0, durationFrames: cancel ? cancelFrames : videoFrames }) :
        renderer.measureLayout({ ...args, frames: layoutFrames }));
  } catch (error) { renderError = error; }
  const settled = performance.now();
  if (sampleError) throw sampleError;
  if (renderError && !controller.signal.aborted) throw renderError;
  assert.ok(phases.bundling !== undefined && phases.selecting !== undefined && phases.rendering !== undefined);
  const startupMs = round(phases.bundling - started);
  const bundleMs = round(phases.selecting - phases.bundling);
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
      if (worker) assert.equal(output.execution?.kind, "local-process");
      await writeFile(join(evidence, name + (operation === "preview" ? ".png" : ".mp4")), output.bytes, { flag: "wx" });
    }
    calls.push({ name, ...timings, status: "completed" });
  }
  if (worker) {
    assert.equal(worker.status().activeJobs, 0);
    assert.deepEqual((await readdir(tmpdir())).filter(entry => entry.startsWith("sciencemotion-worker-")), []);
  }
  assert.equal(hashProject(project), snapshotHash);
}

try {
  await writeFile(join(evidence, "ready"), "", { flag: "wx" });
  await render("cold-preview", "preview");
  await render("repeat-preview", "preview");
  await render("video", "video");
  await render("layout", "layout");
  await render("cancel-video", "video", true);
  await render("recovery-preview", "preview");
  await writeFile(join(evidence, "calls.json"), JSON.stringify({ mode, fixture: {
    projectId: project.project.id, revisionId: request.revisionId, snapshotHash, profile: request.profile,
    previewFrame, videoFrames, cancelFrames, layoutFrames,
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
