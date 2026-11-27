import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreativeDeliveryReport } from "../src/contracts/creative-delivery";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import type { ProjectSnapshot } from "../src/platform/project-snapshots";
import { jobOutputOwner, jobOutputReceipt } from "../src/platform/render-job-output";
import { RetainedShotSegmentStore } from "../src/platform/retained-shot-segment";
import { replayAssetId, replayProfile as profile, replayRange as range, replaySnapshotId } from "./fixtures/pendulum-replay-project";

const input = resolve("out/pendulum-replay"), output = resolve("out/retained-shot-segments");
const engines = { remotion: "remotion.pendulum-replay", three: "three-js-pendulum-replay" } as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const readJson = async <T>(file: string) => JSON.parse(await readFile(join(input, file), "utf8")) as T;
const save = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n");
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", profile, range };

await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "sciencemotion-retained-segments-"));
try {
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.checkout = checkout;
  const [c, snapshot, trajectory] = await Promise.all([
    readJson<{ status: string; checkout: string; snapshot: { id: string; contentHash: string }; source: { artifactId: string } }>("evidence.json"),
    readJson<ProjectSnapshot>("snapshot.json"), readFile(join(input, "trajectory.json")),
  ]);
  assert.deepEqual([c.status, c.checkout, c.snapshot], ["passed", checkout, { id: replaySnapshotId, contentHash: snapshot.contentHash }]);
  assert.equal("sha256:" + sha(trajectory), c.source.artifactId);
  const revisionId = snapshot.document.revisions.at(-1)!.id;
  const { projectId } = snapshot;
  const expectedSnapshot = { id: replaySnapshotId, contentHash: snapshot.contentHash, revisionId };
  const inputs = await Promise.all(Object.entries(engines).map(async ([engine, rendererId]) => {
    const [report, video] = await Promise.all([readJson<CreativeDeliveryReport>(engine + "/delivery.json"),
      readFile(join(input, engine, "replay.mp4"))]);
    const { job, decoded } = report.video;
    assert.deepEqual([report.projectId, report.snapshot, report.profile, report.range, job.input.renderer.id,
      job.result?.contentHash, decoded.frames], [projectId, expectedSnapshot, profile, range, rendererId, sha(video), range.durationFrames]);
    return { engine, job, video, rgbHash: decoded.rgbHash };
  }));

  const artifactsDirectory = join(work, "artifacts"), referencesDirectory = join(work, "references"), projectsDirectory = join(work, "projects");
  const artifacts = new FileSystemArtifactStore(artifactsDirectory), refs = new FileSystemArtifactReferenceStore(referencesDirectory);
  const lifecycle = new LocalArtifactLifecycleManager(artifacts, refs);
  const storedData = await artifacts.put({ bytes: trajectory, kind: "data", mediaType: "application/json" });
  assert.equal(storedData.id, c.source.artifactId);
  assert.deepEqual(snapshot.document.assets[0], { id: replayAssetId, kind: "data", uri: storedData.uri, contentHash: storedData.contentHash });
  const sourceWorkspace = await FileSystemProjectWorkspace.open(projectsDirectory, lifecycle);
  const store = new RetainedShotSegmentStore(artifacts, lifecycle);
  let saved: Array<Awaited<ReturnType<RetainedShotSegmentStore["retain"]>>>;
  const orphan = await artifacts.put({ bytes: Buffer.from("shot-segment GC control"), kind: "data", mediaType: "text/plain" });
  let badClockId: string;
  try {
    await sourceWorkspace.create(snapshot.document);
    await sourceWorkspace.saveSnapshot(projectId, revisionId, { id: snapshot.id, createdAt: snapshot.createdAt });
    const approved = await sourceWorkspace.getSnapshot(snapshot.id);
    assert.deepEqual(approved, snapshot);
    assert.ok(approved);
    for (const { job, video } of inputs) {
      const artifact = await artifacts.put({ bytes: video, kind: "video", mediaType: "video/mp4", extension: "mp4" });
      assert.equal(artifact.id, job.result?.artifactId);
      await lifecycle.attach({ ...jobOutputOwner(job), artifactId: artifact.id });
    }
    saved = [];
    for (const { job, rgbHash } of inputs) {
      const entry = await store.retain(approved, job);
      assert.deepEqual([entry.segment.projectId, entry.segment.renderer, entry.segment.profile, entry.segment.source.range],
        [projectId, job.input.renderer, profile, range]);
      assert.deepEqual(entry.segment.source.scope, { kind: "sequence", id: snapshot.document.sequences[0].id });
      assert.deepEqual(entry.segment.origin, { kind: "render-job", jobId: job.id, inputHash: job.inputHash });
      assert.deepEqual([entry.segment.media.artifactId, entry.segment.media.frameCount, entry.decodedRgbHash],
        [job.result?.artifactId, range.durationFrames, rgbHash]);
      assert.deepEqual((await refs.list({ ownerType: "shot-segment", ownerId: entry.record.id })).map(r => r.role).sort(),
        ["descriptor", "source-snapshot", "video"]);
      saved.push(entry);
    }
    assert.notEqual(saved[0].record.id, saved[1].record.id);
    assert.equal(saved[0].segment.source.snapshot.artifactId, saved[1].segment.source.snapshot.artifactId);
    assert.equal((await store.retain(approved, inputs[0].job)).record.id, saved[0].record.id);

    const before = await refs.list({ ownerType: "shot-segment" });
    await assert.rejects(() => store.retain({ ...approved, id: "wrong-snapshot" }, inputs[0].job), { code: "SHOT_SEGMENT_SOURCE" });
    await assert.rejects(() => store.retain(approved, { ...inputs[0].job, inputHash: "0".repeat(64) }), { code: "SHOT_SEGMENT_JOB" });

    // Remux the first real video with one changed presentation time. The frame count,
    // average rate, stream duration and compressed pictures are otherwise retained.
    const vfr = join(work, "irregular.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", join(input, "remotion", "replay.mp4"),
      "-c:v", "copy", "-an", "-bsf:v", "setts=pts=PTS+1*eq(N\\,20)", vfr], { timeout: 15_000 });
    const irregular = await artifacts.put({ bytes: await readFile(vfr), kind: "video", mediaType: "video/mp4" });
    badClockId = irregular.id;
    const bad = { ...inputs[0].job, result: jobOutputReceipt(inputs[0].job, irregular.contentHash, irregular.sizeBytes) };
    await assert.rejects(() => store.retain(approved, bad), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "SHOT_SEGMENT_MEDIA" && /timestamps/.test(error.message));
    assert.deepEqual(await refs.list({ ownerType: "shot-segment" }), before);

    for (const { job } of inputs) {
      const { ownerType, ownerId, role } = jobOutputOwner(job);
      await lifecycle.releaseOwner({ ownerType, ownerId }, role);
      assert.deepEqual((await lifecycle.references(job.result!.artifactId)).map(ref => ref.ownerType), ["shot-segment"]);
    }
    assert.equal(await sourceWorkspace.releaseSnapshot(snapshot.id), true);
  } finally { await sourceWorkspace.close(); }

  const reopenedArtifacts = new FileSystemArtifactStore(artifactsDirectory), reopenedRefs = new FileSystemArtifactReferenceStore(referencesDirectory);
  const reopenedLifecycle = new LocalArtifactLifecycleManager(reopenedArtifacts, reopenedRefs);
  const reopenedWorkspace = await FileSystemProjectWorkspace.open(projectsDirectory, reopenedLifecycle);
  let collection;
  try {
    assert.equal(await reopenedWorkspace.getSnapshot(snapshot.id), undefined);
    assert.deepEqual(await reopenedWorkspace.get(projectId), snapshot.document);
    collection = await reopenedWorkspace.collectGarbage({ olderThanMs: 0, now: new Date(Date.now() + 1000) });
    assert.deepEqual(collection.deleted.sort(), [orphan.id, badClockId].sort());
    assert.deepEqual(collection.errors, []);
  } finally { await reopenedWorkspace.close(); }

  const reopened = new RetainedShotSegmentStore(reopenedArtifacts, reopenedLifecycle);
  const records = [];
  for (const [i, { engine, job, video }] of inputs.entries()) {
    const found = await reopened.read(saved[i].record.id);
    assert.deepEqual(found.segment, saved[i].segment);
    assert.deepEqual(found.snapshot, snapshot);
    assert.ok(Buffer.from(found.videoBytes).equals(video));
    assert.equal("sha256:" + sha(found.descriptorBytes), found.record.id);
    const descriptorFile = engine + "-segment.json", mediaFile = engine + ".mp4";
    await Promise.all([writeFile(join(output, descriptorFile), found.descriptorBytes), writeFile(join(output, mediaFile), found.videoBytes)]);
    if (i === 0) await writeFile(join(output, "source-snapshot.json"), found.sourceBytes);
    records.push({ engine, descriptorFile, mediaFile, id: found.record.id, descriptor: found.segment,
      decodedRgbHash: saved[i].decodedRgbHash, receipt: job });
  }
  class CorruptVideoReader extends FileSystemArtifactStore {
    override async read(id: string) {
      const bytes = await super.read(id);
      if (bytes && id === saved[0].segment.media.artifactId) bytes[0] ^= 1;
      return bytes;
    }
  }
  await assert.rejects(() => new RetainedShotSegmentStore(new CorruptVideoReader(artifactsDirectory), reopenedLifecycle)
    .read(saved[0].record.id), { code: "SHOT_SEGMENT_INTEGRITY" });
  await cp("schemas/retained-shot-segment.schema.json", join(output, "retained-shot-segment.schema.json"));
  evidence.sourceSnapshot = expectedSnapshot;
  evidence.segments = records;
  evidence.recovery = { reopened: true, originalSnapshotReleased: true, jobOutputReferencesReleased: true, originalVideoBytesMatch: true, collection };
  evidence.rejections = { staleSnapshot: "SHOT_SEGMENT_SOURCE", inconsistentJob: "SHOT_SEGMENT_JOB", nonUniformPts: "SHOT_SEGMENT_MEDIA",
    changedVideo: "SHOT_SEGMENT_INTEGRITY" };
  evidence.status = "passed";
  console.log("Verified two retained segments, recovered the original 89-frame MP4s after release and reopen, and rejected an irregular media clock.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await save("evidence.json", evidence); }
  finally { await rm(work, { recursive: true, force: true }); }
}
