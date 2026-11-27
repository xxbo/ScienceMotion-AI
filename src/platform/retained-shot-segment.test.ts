import assert from "node:assert/strict";
import test from "node:test";
import { createPendulumReplayProject } from "../../scripts/fixtures/pendulum-replay-project";
import type { ArtifactReference } from "../contracts/artifact-lifecycle";
import type { RenderJobRecord, RenderJobSubmission } from "../contracts/render-job";
import type { RetainedShotSegment } from "../contracts/retained-shot-segment";
import { InMemoryArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { InMemoryArtifactStore } from "./artifact-store";
import { InMemorySnapshotStore } from "./project-snapshots";
import { jobOutputReceipt } from "./render-job-output";
import { parseRetainedShotSegment, RetainedShotSegmentStore } from "./retained-shot-segment";
import { hashToolInput } from "./tool-execution-store";

const hash = "a".repeat(64), id = "sha256:" + hash;
function descriptor(): RetainedShotSegment {
  return { schemaVersion: "1.0.0", projectId: "p",
    source: { snapshot: { id: "saved", revisionId: "r", contentHash: hash, artifactId: id },
      scope: { kind: "scene", id: "shot-scene" }, range: { startFrame: 7, durationFrames: 89 } },
    renderer: { id: "renderer-neutral", version: "1.0.0" }, origin: { kind: "render-job", jobId: "job", inputHash: hash },
    profile: { width: 640, height: 360, fps: 25 },
    media: { artifactId: id, contentHash: hash, sizeBytes: 1024, codec: "h264", mediaType: "video/mp4", pixelFormat: "yuv420p",
      frameCount: 89, silent: true } };
}
const check = (code: string) => ({ code: "SHOT_SEGMENT_" + code });

test("a v1 segment is renderer-neutral, captures one source range and has no editorial placement", () => {
  const value = descriptor();
  const parsed = parseRetainedShotSegment(value);
  assert.deepEqual(parsed, value);
  parsed.source.range.startFrame = 0;
  assert.equal(value.source.range.startFrame, 7);
  assert.throws(() => parseRetainedShotSegment({ ...value, timelineFrame: 13 }), check("SCHEMA"));
  assert.throws(() => parseRetainedShotSegment({ ...value, schemaVersion: "2.0.0" }), check("SCHEMA"));
  assert.throws(() => parseRetainedShotSegment({ ...value, profile: { ...value.profile, fps: 29.97 } }), check("SCHEMA"));
  assert.throws(() => parseRetainedShotSegment({ ...value, media: { ...value.media, silent: false } }), check("SCHEMA"));
});

test("segment range and media hash must agree even after schema validation", () => {
  const value = descriptor();
  assert.throws(() => parseRetainedShotSegment({ ...value, media: { ...value.media, frameCount: 88 } }), check("RANGE"));
  assert.throws(() => parseRetainedShotSegment({ ...value, source: { ...value.source,
    range: { ...value.source.range, startFrame: Number.MAX_SAFE_INTEGER } } }), check("RANGE"));
  assert.throws(() => parseRetainedShotSegment({ ...value, media: { ...value.media, artifactId: "sha256:" + "b".repeat(64) } }),
    check("INTEGRITY"));
});

test("capture rejects a stale source, wrong native profile, invalid receipt and missing bytes before publishing", async () => {
  const artifacts = new InMemoryArtifactStore(), refs = new InMemoryArtifactReferenceStore();
  const store = new RetainedShotSegmentStore(artifacts, new LocalArtifactLifecycleManager(artifacts, refs));
  const doc = createPendulumReplayProject(hash);
  const now = doc.project.createdAt, snapshot = new InMemorySnapshotStore().save(doc, { id: "saved", createdAt: now });
  const input: RenderJobSubmission = { projectId: snapshot.projectId, submissionId: "s", callId: "c", runId: "r", toolVersion: "1.0.0",
    snapshot: { id: snapshot.id, revisionId: doc.revisions[0].id, contentHash: snapshot.contentHash },
    profile: descriptor().profile, render: { operation: "video", startFrame: 7, durationFrames: 89 }, renderer: descriptor().renderer };
  function record(options = input): RenderJobRecord {
    const job: RenderJobRecord = { schemaVersion: "1.0.0", id: "job", input: options, inputHash: hashToolInput(options), state: "succeeded",
      revision: 3, createdAt: now, updatedAt: now, startedAt: now, publicationStartedAt: now, completedAt: now, outcomeUnknown: false };
    job.result = jobOutputReceipt(job, hash, 1024);
    return job;
  }
  await assert.rejects(() => store.retain({ ...snapshot, id: "another" }, record()), check("SOURCE"));
  await assert.rejects(() => store.retain(snapshot, record({ ...input, profile: { ...input.profile, fps: 24 } })), check("PROFILE"));
  await assert.rejects(() => store.retain(snapshot, record({ ...input, render: { operation: "video", sceneId: "other",
    startFrame: 7, durationFrames: 89 } })), check("RANGE"));
  await assert.rejects(() => store.retain(snapshot, { ...record(), inputHash: hash }), check("JOB"));
  await assert.rejects(() => store.retain(snapshot, record()), check("MISSING"));
  assert.deepEqual([await artifacts.list(), await refs.list()], [[], []]);
});

test("an uncommitted descriptor or missing dependency pin cannot be read as a retained segment", async () => {
  const artifacts = new InMemoryArtifactStore(), refs = new InMemoryArtifactReferenceStore();
  const lifecycle = new LocalArtifactLifecycleManager(artifacts, refs);
  const store = new RetainedShotSegmentStore(artifacts, lifecycle);
  const raw = await artifacts.put({ bytes: Buffer.from(JSON.stringify(descriptor())), kind: "data", mediaType: "application/json" });
  await assert.rejects(() => store.read(raw.id), /No committed segment/);
  await lifecycle.attach({ artifactId: raw.id, ownerType: "shot-segment", ownerId: raw.id, role: "descriptor" });
  await assert.rejects(() => store.read(raw.id), /both dependencies/);
});

test("pin batching rolls back only newly attached references if the final publication fails", async () => {
  class FailingReferences extends InMemoryArtifactReferenceStore {
    override async attach(reference: ArtifactReference) {
      if (reference.role === "descriptor") throw new Error("injected pin failure");
      return super.attach(reference);
    }
  }
  const artifacts = new InMemoryArtifactStore(), refs = new FailingReferences();
  const lifecycle = new LocalArtifactLifecycleManager(artifacts, refs);
  const staged = await Promise.all(["snapshot", "video", "descriptor"].map(async role => ({
    artifactId: (await artifacts.put({ bytes: Buffer.from(role), kind: "data", mediaType: "text/plain" })).id,
    ownerType: "shot-segment" as const, ownerId: "segment", role,
  })));
  await lifecycle.attach(staged[0]);
  await assert.rejects(() => lifecycle.attachBatch(staged), /injected pin failure/);
  assert.deepEqual((await refs.list()).map(reference => reference.role), ["snapshot"]);
  await assert.rejects(() => lifecycle.attachBatch([staged[1], { ...staged[2], artifactId: id }]), /does not exist/);
  assert.deepEqual((await refs.list()).map(reference => reference.role), ["snapshot"]);
});
