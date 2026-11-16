import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openCreativeHost } from "../src/platform/creative-host";
import type { CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { SnapshotInspectionReport } from "../src/contracts/inspection";

const root = await mkdtemp(join(tmpdir(), "sciencemotion-inspection-"));
let host: Awaited<ReturnType<typeof openCreativeHost>> | undefined;
let rendererCalls = 0, callId = 0;
const renderer = { id: "inspection-must-not-render", version: "1.0.0",
  async renderPreview(): Promise<never> { rendererCalls++; throw new Error("Inspection unexpectedly rendered a PNG"); },
  async renderVideo(): Promise<never> { rendererCalls++; throw new Error("Inspection unexpectedly encoded a video"); } };
const invoke = async (session: CreativeSession, toolId: string, input: unknown) => {
  const manifest = await session.manifest(toolId); assert.ok(manifest, `Tool not discoverable: ${toolId}`);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "inspection-smoke", callId: `inspection-${++callId}` });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); return result;
};
try {
  host = await openCreativeHost({ directory: root, renderer });
  const session = host.createSession({ projectId: "inspection-demo", permissions: ["project.read", "project.write", "snapshot.read", "snapshot.write"],
    toolIds: ["project.create", "project.scene.create", "graphics.2d.shape.create", "animation.keyframes.set",
      "project.inspect", "project.snapshot.save", "inspect.snapshot"] });
  await invoke(session, "project.create", { name: "Inspect, repair and recheck", episodeId: "approved-motion", width: 640, height: 360, durationFrames: 60 });
  await invoke(session, "project.scene.create", { sceneId: "motion", name: "Moving signal", durationFrames: 60 });
  await invoke(session, "graphics.2d.shape.create", { sceneId: "motion", nodeId: "signal", primitive: "circle", x: 100, y: 120, width: 80, height: 80 });
  const animate = async (middleX: number) => invoke(session, "animation.keyframes.set", { trackId: "signal-position", targetNodeId: "signal",
    targetProperty: "transform.position", keyframes: [
      { frame: 0, value: [100, 120, 0] }, { frame: 30, value: [middleX, 120, 0] }, { frame: 59, value: [100, 120, 0] },
    ] });
  const inspect = async (snapshotId: string) => {
    const project = (await invoke(session, "project.inspect", {})).output as ProjectDocument;
    await invoke(session, "project.snapshot.save", { snapshotId, revisionId: project.revisions.at(-1)!.id });
    const start = performance.now();
    const report = (await invoke(session, "inspect.snapshot", { snapshotId })).output as SnapshotInspectionReport;
    return { report, elapsedMs: Math.round((performance.now() - start) * 100) / 100 };
  };
  await animate(800);
  const before = await inspect("motion-before");
  const issue = before.report.issues.find((entry) => entry.code === "INSPECT_NODE_OUTSIDE_FRAME");
  assert.equal(issue?.nodeId, "signal"); assert.ok(issue?.frames.includes(30));
  assert.ok(!issue?.frames.includes(0) && !issue?.frames.includes(59));
  await animate(400);
  const after = await inspect("motion-after");
  assert.equal(after.report.outcome, "no-issues-detected");
  assert.equal(after.report.coverage.mode, "all-frames");
  assert.ok(after.report.coverage.notChecked.includes("final-pixels"));
  const beforeAgain = (await invoke(session, "inspect.snapshot", { snapshotId: "motion-before" })).output;
  assert.deepEqual(beforeAgain, before.report, "Editing the live project must not change old snapshot inspection");
  await host.close(); host = await openCreativeHost({ directory: root, renderer });
  const reader = host.createSession({ projectId: "inspection-demo", permissions: ["snapshot.read"], toolIds: ["inspect.snapshot"] });
  assert.deepEqual((await invoke(reader, "inspect.snapshot", { snapshotId: "motion-after" })).output, after.report);
  assert.equal(rendererCalls, 0);
  await mkdir("out", { recursive: true });
  await writeFile("out/snapshot-inspection-evidence.json", JSON.stringify({
    sourceCommit: process.env.GITHUB_SHA ?? null,
    scenario: "public tools detect and repair intermediate-frame overflow, then recheck immutable snapshots after restart",
    before, after, rendererCalls, visualModelCalls: 0, encodedPreviewFrames: 0, restartReportUnchanged: true,
    scope: "Model/declared-geometry inspection only; this is not final visual-quality acceptance",
  }, null, 2) + "\n");
  console.log(`PASS snapshot inspection -> animation repair -> recheck -> restart; 0 renderer/vision calls; inspection ${before.elapsedMs}ms / ${after.elapsedMs}ms`);
} finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
