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

// Real host API rendering, restart and output retention. B3 covers worker/CLI interruption separately.
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
  const records: RenderJobRecord[] = [], requests: CreativeJobSubmission[] = [];
  for (const mode of ["preview", "video"] as const) {
    const request: CreativeJobSubmission = { submissionId: mode, runId: "job-smoke", callId: `render-${mode}`, toolVersion: "1.0.0",
      ...(mode === "preview" ? { toolId: "render.preview", input: { snapshotId: "job-snapshot", frame: 15 } }
        : { toolId: "render.video", input: { snapshotId: "job-snapshot", startFrame: 0, durationFrames: 30 } }) };
    requests.push(request);
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

  const [preview, video] = records, admin = host.maintenance.renderJobs;
  const before = await admin.inspect(grant.projectId, preview.id);
  assert.ok(before && "record" in before && before.output);
  assert.equal(before.output.availability, "verified");
  assert.equal(before.output.retainedByJob, true);
  assert.equal(before.input.retained, true);
  const released = await admin.release(grant.projectId, preview.id);
  assert.ok(released.completedAt);
  const gc = await host.maintenance.collectGarbage(0);
  assert.deepEqual(gc.deleted, [preview.result!.artifactId]);
  assert.deepEqual(gc.errors, []);
  const kept = await admin.inspect(grant.projectId, video.id);
  assert.ok(kept && "record" in kept && kept.output);
  assert.equal(kept.output.availability, "verified");
  assert.equal(kept.output.retainedByJob, true);
  const pruned = await admin.prune(grant.projectId, preview.id);
  await host.close(); host = await openCreativeHost({ directory: root }); s = session();
  assert.deepEqual(await host.maintenance.renderJobs.inspect(grant.projectId, preview.id), pruned);
  await assert.rejects(s.jobs.submit(requests[0]), { code: "RENDER_JOB_PRUNED" });
  assert.deepEqual(await s.jobs.get(video.id), video);

  await writeFile("out/job-host-evidence.json", JSON.stringify({ schemaVersion: "1.0.0",
    scenario: "Real in-process host API render, retention release and durable pruning", records, retention: { before, released, gc, kept, pruned },
    checks: ["submission-before-render", "idempotent-retry", "verified-png-and-mp4", "frame-count-and-dimensions", "durable-query-after-reopen",
      "retained-output", "gc-after-explicit-release", "pruned-identity-blocks-replay"] }, null, 2) + "\n");
  console.log("PASS background host jobs: verified PNG and MP4, targeted release/GC, retained video and durable pruned identity");
} finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
