import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeSession } from "../src/contracts/creative-host";
import type { CreativeJobSubmission } from "../src/contracts/creative-jobs";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import { openCreativeHost } from "../src/platform/creative-host";

// B2 positive host-API integration. B3 separately exercises the worker/CLI cancellation and restart workflow.
const root = await mkdtemp(join(tmpdir(), "sciencemotion-job-smoke-"));
let host: Awaited<ReturnType<typeof openCreativeHost>> | undefined, callId = 0;
const grant = { projectId: "job-smoke", permissions: ["project.read", "project.write", "snapshot.write", "snapshot.read", "artifact.write"] as const,
  toolIds: ["project.create", "project.inspect", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create", "project.snapshot.save", "render.preview", "render.video"] };
const session = () => host!.createSession({ ...grant, permissions: [...grant.permissions] });
const invoke = async (s: CreativeSession, toolId: string, input: unknown) => {
  const result = await s.invoke({ toolId, toolVersion: "1.0.0", input, runId: "job-smoke", callId: `edit-${++callId}` });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.output;
};
async function completed(s: CreativeSession, id: string): Promise<RenderJobRecord> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const record = (await s.jobs.get(id))!;
    if (record.state === "succeeded") return record;
    assert.ok(["queued", "running", "publishing"].includes(record.state), JSON.stringify(record));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Render job did not finish within the smoke deadline");
}
try {
  await mkdir("out", { recursive: true }); host = await openCreativeHost({ directory: root }); let s = session();
  for (const [toolId, input] of [
    ["project.create", { name: "Background render", episodeId: "job-api-fixture", durationFrames: 30, width: 640, height: 360, fps: 30 }],
    ["project.scene.create", { sceneId: "scene", name: "Background job", durationFrames: 30 }],
    ["graphics.2d.text.create", { sceneId: "scene", nodeId: "title", text: "Submit → Track → Result", x: 40, y: 40, fontSize: 32, width: 560, height: 80 }],
    ["graphics.2d.shape.create", { sceneId: "scene", nodeId: "shape", primitive: "circle", x: 260, y: 160, width: 100, height: 100, fill: "#55d6e8" }],
  ] as Array<[string, unknown]>) await invoke(s, toolId, input);
  const project = await invoke(s, "project.inspect", {}) as ProjectDocument;
  await invoke(s, "project.snapshot.save", { snapshotId: "job-snapshot", revisionId: project.revisions.at(-1)!.id });
  const records: RenderJobRecord[] = [];
  for (const mode of ["preview", "video"] as const) {
    const request: CreativeJobSubmission = { submissionId: mode, runId: "job-smoke", callId: `render-${mode}`, toolVersion: "1.0.0",
      ...(mode === "preview" ? { toolId: "render.preview", input: { snapshotId: "job-snapshot", frame: 15 } }
        : { toolId: "render.video", input: { snapshotId: "job-snapshot", startFrame: 0, durationFrames: 30 } }) };
    const admitted = await s.jobs.submit(request); assert.equal(admitted.record.state, "queued");
    assert.equal((await s.jobs.submit(request)).created, false);
    const done = await completed(s, admitted.record.id), receipt = done.result!; records.push(done);
    assert.equal(receipt.jobId, done.id); assert.equal(receipt.inputHash, done.inputHash);
    const bytes = await readFile(join(root, "artifacts", "blobs", receipt.contentHash.slice(0, 2), receipt.contentHash));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.contentHash); assert.equal(bytes.length, receipt.sizeBytes);
    const path = mode === "preview" ? "out/job-host-preview.png" : "out/job-host-video.mp4"; await writeFile(path, bytes);
    if (mode === "preview") {
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(bytes.readUInt32BE(16), 640); assert.equal(bytes.readUInt32BE(20), 360);
    } else {
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
      const stream = probe.streams.find((item: { codec_type: string }) => item.codec_type === "video");
      assert.equal(stream.width, 640); assert.equal(stream.height, 360); assert.equal(stream.r_frame_rate, "30/1"); assert.equal(Number(stream.nb_frames), 30);
      assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.1);
    }
  }
  await host.close(); host = await openCreativeHost({ directory: root }); s = session();
  for (const record of records) assert.deepEqual(await s.jobs.get(record.id), record);
  assert.equal((await s.jobs.list()).total, 2); assert.equal((await host.maintenance.collectGarbage(0)).deleted.length, 0);
  await writeFile("out/job-host-evidence.json", JSON.stringify({ schemaVersion: "1.0.0", scenario: "B2 real in-process host API render and persisted results", records,
    checks: ["submission-before-render", "idempotent-retry", "verified-png-and-mp4", "frame-count-and-dimensions", "durable-query-after-reopen", "retained-output"] }, null, 2) + "\n");
  console.log("PASS background host jobs: PNG + 30-frame MP4, verified receipts, retained outputs and exact results after reopen");
} finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
