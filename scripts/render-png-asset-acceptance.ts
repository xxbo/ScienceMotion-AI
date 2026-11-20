import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectAsset, ProjectDocument } from "../src/contracts/project";
import type { SnapshotLayoutInspectionReport } from "../src/contracts/layout-inspection";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";

const output = resolve("out/png-assets");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-png-assets-"));
const directory = join(root, "workspace"), artifactRoot = join(directory, "artifacts");
const store = new FileSystemArtifactStore(artifactRoot);
const width = 320, height = 180, frames = 12, fps = 30;
const red = [220, 34, 48] as const, blue = [24, 72, 222] as const, background = [7, 17, 31] as const;
const projectId = "png-asset-fixture";
let host: CreativeHost | undefined, sequence = 0;
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };

function png(color: readonly number[]) {
  const image = new PNG({ width: 8, height: 6 });
  for (let at = 0; at < image.data.length; at += 4) image.data.set([...color, 255], at);
  return PNG.sync.write(image);
}
const actor = (projectId: string) => host!.createSession({ projectId,
  permissions: ["project.read", "project.write", "artifact.read", "artifact.write", "snapshot.read", "snapshot.write"],
  toolIds: ["project.create", "project.inspect", "project.scene.create", "project.patch.apply", "project.snapshot.save",
    "assets.import", "graphics.2d.image.create", "render.preview", "render.video", "inspect.layout"] });
const call = (session: CreativeSession, toolId: string, input: unknown) =>
  session.invoke({ toolId, input, toolVersion: "1.0.0", runId: "png-acceptance", callId: String(++sequence) });
async function invoke<T>(session: CreativeSession, toolId: string, input: unknown) {
  const result = await call(session, toolId, input);
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result.output as T;
}
async function rejects(session: CreativeSession, toolId: string, input: unknown, code?: string) {
  const result = await call(session, toolId, input);
  assert.equal(result.ok, false);
  if (code) assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === code), JSON.stringify(result.diagnostics));
  assert.ok(!result.artifacts?.length);
}
async function save(session: CreativeSession, snapshotId: string, revisionId: string) {
  return invoke<{ contentHash: string }>(session, "project.snapshot.save", { snapshotId, revisionId });
}
function pixel(bytes: Buffer, channels: number, x: number, y: number) {
  const start = (y * width + x) * channels;
  return [...bytes.subarray(start, start + 3)];
}
function near(actual: readonly number[], expected: readonly number[], tolerance: number) {
  assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance),
    `Expected RGB ${expected}, received ${actual}`);
}
async function verify(id: string, name: string, operation: "preview" | "video", color: readonly number[]) {
  const bytes = Buffer.from((await store.read(id))!);
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, id);
  const file = name + (operation === "preview" ? ".png" : ".mp4"), path = join(output, file);
  await writeFile(path, bytes);
  if (operation === "preview") {
    const decoded = PNG.sync.read(bytes);
    assert.deepEqual([decoded.width, decoded.height], [width, height]);
    assert.deepEqual(pixel(decoded.data, 4, 80, 50), color);
    assert.deepEqual(pixel(decoded.data, 4, 8, 8), background);
  } else {
    const frameBytes = width * height * 3;
    const decoded = execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-i", path, "-map", "0:v:0",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: (frames + 1) * frameBytes, timeout: 15_000 });
    assert.equal(decoded.length, frames * frameBytes);
    for (let index = 0; index < frames; index++) {
      const frame = decoded.subarray(index * frameBytes, (index + 1) * frameBytes);
      near(pixel(frame, 3, 80, 50), color, 8);
      near(pixel(frame, 3, 8, 8), background, 8);
    }
  }
  return { artifactId: id, file };
}

try {
  const redBytes = png(red), blueBytes = png(blue);
  const approved = [
    { projectId, sourceId: "original", path: join(root, "original.png"), license: "Test fixture", attribution: "ScienceMotion AI" },
    { projectId, sourceId: "replacement", path: join(root, "replacement.png") },
    { projectId, sourceId: "invalid", path: join(root, "invalid.png") },
    { projectId, sourceId: "oversized", path: join(root, "oversized.png") },
  ];
  await Promise.all([writeFile(approved[0].path, redBytes), writeFile(approved[1].path, blueBytes),
    writeFile(approved[2].path, redBytes.subarray(0, -2)), writeFile(approved[3].path, "")]);
  await truncate(approved[3].path, 4 * 1024 * 1024 + 1);
  host = await openCreativeHost({ directory, assetImports: approved });
  const editor = actor(projectId);
  const create = (session: CreativeSession) => invoke<{ revisionId: string }>(session, "project.create",
    { name: "PNG assets", episodeId: "asset-fixture", durationFrames: frames, width, height, fps });
  await create(editor);
  await invoke(editor, "project.scene.create", { sceneId: "scene", name: "Picture", durationFrames: frames });
  await rejects(editor, "assets.import", { sourceId: "invalid", assetId: "broken" }, "HOST_PNG_INVALID");
  await rejects(editor, "assets.import", { sourceId: "oversized", assetId: "large" }, "HOST_PNG_LIMIT");
  const original = await invoke<{ asset: ProjectAsset; artifactId: string }>(editor, "assets.import", { sourceId: "original", assetId: "image" });
  assert.equal(original.artifactId, `sha256:${createHash("sha256").update(redBytes).digest("hex")}`);
  assert.equal(original.asset.license, "Test fixture");
  assert.equal(original.asset.attribution, "ScienceMotion AI");
  await rejects(editor, "assets.import", { sourceId: "replacement", assetId: "image" }, "ASSET_IMPORT_CONFLICT");
  const node = await invoke<{ revisionId: string }>(editor, "graphics.2d.image.create",
    { sceneId: "scene", nodeId: "picture", assetId: "image", x: 40, y: 20, width: 80, height: 60 });
  const old = await save(editor, "old-png", node.revisionId);
  const replacement = await invoke<typeof original & { revisionId: string }>(editor, "assets.import",
    { sourceId: "replacement", assetId: "image", replace: true });
  assert.equal(replacement.artifactId, `sha256:${createHash("sha256").update(blueBytes).digest("hex")}`);
  const current = await save(editor, "new-png", replacement.revisionId);
  assert.notEqual(current.contentHash, old.contentHash);
  const project = await invoke<ProjectDocument>(editor, "project.inspect", {});
  assert.equal(project.assets.length, 1);
  assert.equal(project.assets[0].uri, replacement.asset.uri);

  const other = actor("another-project"), foreign = await create(other);
  await rejects(other, "assets.import", { sourceId: "original", assetId: "denied" }, "HOST_ASSET_IMPORT_DENIED");
  await rejects(other, "project.patch.apply", { schemaVersion: "1.2.0", projectId: other.projectId, baseRevisionId: foreign.revisionId,
    patches: [{ op: "add-asset", asset: original.asset }] }, "HOST_ARTIFACT_DENIED");
  await rejects(other, "render.preview", { snapshotId: "old-png", frame: 0 }, "HOST_SNAPSHOT_DENIED");

  const snapshots = [{ id: "old-png", hash: old.contentHash, color: red }, { id: "new-png", hash: current.contentHash, color: blue }];
  const inProcess = [];
  for (const snapshot of snapshots) {
    const preview = await invoke<{ artifactId: string }>(editor, "render.preview", { snapshotId: snapshot.id, frame: 0 });
    const video = await invoke<{ artifactId: string }>(editor, "render.video", { snapshotId: snapshot.id, startFrame: 0, durationFrames: frames });
    inProcess.push({ snapshotId: snapshot.id, preview: await verify(preview.artifactId, "host-" + snapshot.id, "preview", snapshot.color),
      video: await verify(video.artifactId, "host-" + snapshot.id, "video", snapshot.color) });
  }
  const layout = await invoke<SnapshotLayoutInspectionReport>(editor, "inspect.layout", { snapshotId: "new-png", frames: [0] });
  assert.deepEqual(layout.frames[0].nodes.map(node => [node.nodeId, node.type]), [["picture", "image"]]);
  await host.close();
  await Promise.all(approved.map(source => rm(source.path)));

  host = await openCreativeHost({ directory, renderWorker: {} });
  const reopened = actor(projectId), workers = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const assets = [];
    for (const operation of ["preview", "video"] as const) {
      const common = { runId: "png-reopen", toolVersion: "1.0.0", callId: snapshot.id + operation, submissionId: snapshot.id + operation };
      const { record: admitted } = await reopened.jobs.submit(operation === "preview"
        ? { ...common, toolId: "render.preview", input: { snapshotId: snapshot.id, frame: 0 } }
        : { ...common, toolId: "render.video", input: { snapshotId: snapshot.id, startFrame: 0, durationFrames: frames } });
      const deadline = Date.now() + 40_000;
      let result = admitted;
      while (["queued", "running", "stopping", "publishing"].includes(result.state)) {
        assert.ok(Date.now() < deadline, "PNG worker render job must settle");
        await new Promise(resolve => setTimeout(resolve, 25));
        result = (await reopened.jobs.get(admitted.id))!;
      }
      assert.equal(result.state, "succeeded", JSON.stringify(result.diagnostic));
      assert.equal(result.input.snapshot.contentHash, snapshot.hash);
      const id = result.result!.artifactId;
      if (operation === "preview") assert.equal(id, inProcess[index].preview.artifactId);
      assets.push({ operation, jobId: result.id, ...(await verify(id, "worker-" + snapshot.id, operation, snapshot.color)) });
    }
    workers.push({ snapshotId: snapshot.id, snapshotHash: snapshot.hash, assets });
  }
  const hash = original.asset.contentHash!, blob = join(artifactRoot, "blobs", hash.slice(0, 2), hash);
  await writeFile(blob, "corrupt");
  try { await rejects(reopened, "render.preview", { snapshotId: "old-png", frame: 0 }); }
  finally { await writeFile(blob, redBytes); }
  const recovered = await invoke<{ artifactId: string }>(reopened, "render.preview", { snapshotId: "old-png", frame: 0 });
  assert.equal(recovered.artifactId, inProcess[0].preview.artifactId);
  Object.assign(evidence, { status: "passed", original: original.asset, replacement: replacement.asset,
    inProcess, workers, layout: layout.frames[0], sourcesRemovedBeforeReopen: true, corruptArtifactRejected: true,
    recoveredArtifact: recovered.artifactId, crossProjectRejected: true });
  console.log("PASS: approved PNG imports, snapshot replacement, visible preview/video pixels and verified worker jobs after reopening");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
  }
}
