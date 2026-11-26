import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativeJobSubmission } from "../src/contracts/creative-jobs";
import type { ProjectDocument } from "../src/contracts/project";
import type { RenderJobRecord } from "../src/contracts/render-job";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyDeliveryPreview, verifyDeliveryVideo } from "../src/platform/creative-delivery-media";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { ThreeJsProjectGraphRenderer } from "../src/renderers/three/three-project-graph-renderer";
import { inspectThreePixels, projectThreeBounds, threeProfile as profile } from "./fixtures/three-scene-pixels";

const output = resolve("out/three-static-shot");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-three-shot-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const renderer = new ThreeJsProjectGraphRenderer();
const identity = { id: renderer.id, version: renderer.version };
const snapshot = { id: "three-static-v1", revisionId: "revision-three-static-v1", contentHash: "c6ac973ff3672a2e3db19d9d82c68859eeef2bfbec4eaff8e7343611e3c2b5b8" };
const projectId = "three-static-study", runId = "p2-2-b-three-static";
const range = { startFrame: 0, durationFrames: 48 }, previewFrame = 24;
const { width, height } = profile;
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", snapshot, renderer: identity, profile, range };
let host: CreativeHost | undefined, calls = 0;
const json = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n");

async function invoke(session: CreativeSession, toolId: string, input: unknown) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest);
  return session.invoke({ toolId, toolVersion: manifest.version, input, runId, callId: `call-${++calls}` });
}
async function ok<T>(session: CreativeSession, toolId: string, input: unknown) {
  const result = await invoke(session, toolId, input);
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}
type JobInput = CreativeJobSubmission extends infer T ? T extends CreativeJobSubmission ? Pick<T, "toolId" | "input"> : never : never;
async function job(session: CreativeSession, label: string, input: JobInput) {
  const manifest = await session.manifest(input.toolId);
  assert.ok(manifest);
  const admitted = await session.jobs.submit({ ...input, runId, submissionId: label, callId: label, toolVersion: manifest.version });
  assert.ok(admitted.created);
  const deadline = AbortSignal.timeout(45_000);
  for (;;) {
    const current = await session.jobs.get(admitted.record.id);
    assert.ok(current && current.inputHash === admitted.record.inputHash);
    if (!["queued", "running", "stopping", "publishing"].includes(current.state)) return current;
    await delay(25, undefined, { signal: deadline });
  }
}
async function saveMedia(record: RenderJobRecord, request: RenderJobRecord["input"]["render"], name: string) {
  assert.equal(record.state, "succeeded", JSON.stringify(record.diagnostic));
  assert.equal(record.outcomeUnknown, false);
  assert.deepEqual(record.input.snapshot, snapshot);
  assert.deepEqual(record.input.renderer, identity);
  assert.deepEqual(record.input.profile, profile);
  assert.deepEqual(record.input.render, request);
  assert.ok(record.result);
  assert.deepEqual([record.result.rendererId, record.result.rendererVersion], [identity.id, identity.version]);
  const bytes = await readVerifiedJobArtifact(artifacts, record.result);
  assert.ok(bytes);
  const retention = await host!.maintenance.renderJobs.inspect(projectId, record.id);
  assert.ok(retention && "output" in retention && retention.output?.availability === "verified" && retention.output.referenceAttached);
  const file = join(output, name);
  await writeFile(file, bytes);
  return { file, bytes };
}

const predicted = projectThreeBounds();

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const document = JSON.parse(await readFile("examples/three-static-scene.json", "utf8")) as ProjectDocument;
  assert.equal(document.project.id, projectId);
  assert.equal(hashProject(document), snapshot.contentHash);
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  let retained: ProjectSnapshot;
  try {
    await workspace.create(document);
    retained = await workspace.saveSnapshot(projectId, snapshot.revisionId, { id: snapshot.id, createdAt: document.project.updatedAt });
    assert.equal(retained.contentHash, snapshot.contentHash);
  } finally { await workspace.close(); }
  host = await openCreativeHost({ directory, renderer });
  const session = host.createSession({ projectId, toolIds: ["render.preview", "render.video", "project.snapshot.inspect", "project.snapshot.save", "animation.keyframes.set"],
    permissions: ["artifact.write", "snapshot.read", "snapshot.write", "project.read", "project.write"] });
  assert.deepEqual(await ok<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: snapshot.id }), retained);
  const previewJob = await job(session, "preview", { toolId: "render.preview", input: { snapshotId: snapshot.id, frame: previewFrame } });
  const preview = await saveMedia(previewJob, { operation: "preview", frame: previewFrame }, "preview.png");
  const videoJob = await job(session, "video", { toolId: "render.video", input: { snapshotId: snapshot.id, ...range } });
  const video = await saveMedia(videoJob, { operation: "video", ...range }, "static-shot.mp4");
  const { data, width: w, height: h } = PNG.sync.read(Buffer.from(preview.bytes));
  assert.deepEqual([w, h], [width, height]);
  const previewPixels = inspectThreePixels(data, 4, previewFrame, predicted);
  const [rgbaHash, media] = await Promise.all([
    verifyDeliveryPreview(preview.file, profile, AbortSignal.timeout(20_000)),
    verifyDeliveryVideo(video.file, profile, range, false, AbortSignal.timeout(20_000)),
  ]);
  assert.deepEqual([media.codec, media.frames, media.durationSeconds, media.audio], ["h264", 48, 2, undefined]);
  const frameBytes = width * height * 3;
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-i", video.file, "-map", "0:v:0",
    "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { timeout: 20_000, maxBuffer: frameBytes * range.durationFrames + 1024 });
  assert.equal(rgb.byteLength, frameBytes * range.durationFrames);
  const frames = Array.from({ length: range.durationFrames }, (_, i) => {
    const pixels = inspectThreePixels(rgb.subarray(i * frameBytes, (i + 1) * frameBytes), 3, i, predicted);
    for (const key of ["box", "sphere", "bright", "shade"] as const) {
      const tolerance = key === "box" || key === "sphere" ? 3 : 12;
      assert.ok(pixels[key].every((n, k) => Math.abs(n - previewPixels[key][k]) <= tolerance), `Static video ${key} diverges from preview at frame ${i}`);
    }
    return pixels;
  });
  evidence.predictedBounds = predicted;
  evidence.preview = { job: previewJob, file: "preview.png", rgbaHash, pixels: previewPixels };
  evidence.video = { job: videoJob, file: "static-shot.mp4", media, frames };

  const edit = await ok<{ revisionId: string }>(session, "animation.keyframes.set", { trackId: "mesh-motion-not-in-camera-scope", targetNodeId: "blue-box",
    targetProperty: "transform.position", keyframes: [{ frame: 0, value: [-1.35, 0, 0] }, { frame: 47, value: [0, 0, 0] }] });
  const candidate = await ok<SnapshotReceipt>(session, "project.snapshot.save", { snapshotId: "unsupported-mesh-keys", revisionId: edit.revisionId });
  const before = await artifacts.list();
  const rejected = await job(session, "unsupported-motion", { toolId: "render.video", input: { snapshotId: candidate.id, ...range } });
  assert.equal(rejected.state, "failed");
  assert.deepEqual(rejected.input.snapshot, { id: candidate.id, revisionId: edit.revisionId, contentHash: candidate.contentHash });
  assert.equal(rejected.diagnostic?.code, "THREE_STATIC_UNSUPPORTED_ANIMATION");
  assert.match(rejected.diagnostic?.message ?? "", /blue-box.*\/project\/animationTracks\/0/);
  assert.equal(rejected.publicationStartedAt, undefined);
  assert.equal(rejected.result, undefined);
  assert.equal(rejected.outcomeUnknown, false);
  assert.deepEqual(await artifacts.list(), before);
  assert.deepEqual(await ok<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: snapshot.id }), retained);
  evidence.rejection = { job: rejected, unchangedArtifactCount: before.length };
  await json("snapshot.json", retained);
  evidence.status = "passed";
  console.log("Verified the pinned Three.js scene: decoded PNG and all 48 H.264 frames match the projected box and sphere, including directional shading. Mesh keys failed before publication.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await json("evidence.json", evidence); }
  finally { try { await host?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
