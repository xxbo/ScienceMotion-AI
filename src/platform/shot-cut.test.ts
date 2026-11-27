import assert from "node:assert/strict";
import test from "node:test";
import type { RetainedShotSegment } from "../contracts/retained-shot-segment";
import type { RetainedShotSegmentStore } from "./retained-shot-segment";
import { assembleShotCut, assertShotCutFrames, locateShotCutFrame, planShotCut } from "./shot-cut";

const h = (digit: string) => digit.repeat(64);
const id = (digit: string) => "sha256:" + h(digit);

function retained(digit: string, startFrame: number, durationFrames: number, renderer: string) {
  const segment: RetainedShotSegment = {
    schemaVersion: "1.0.0", projectId: "project",
    source: { snapshot: { id: "snapshot-" + digit, artifactId: id(digit), revisionId: "revision", contentHash: h(digit) },
      scope: { kind: "scene", id: "scene-" + digit }, range: { startFrame, durationFrames } },
    origin: { kind: "render-job", jobId: "job-" + digit, inputHash: h(digit) },
    renderer: { id: renderer, version: "1.0.0" },
    profile: { width: 640, height: 360, fps: 25 },
    media: { artifactId: id(digit), contentHash: h(digit), sizeBytes: 8000, mediaType: "video/mp4",
      codec: "h264", pixelFormat: "yuv420p", frameCount: durationFrames, silent: true },
  };
  return { id: id(digit), segment };
}
const left = retained("a", 7, 3, "remotion"), right = retained("b", 21, 2, "three");
const check = (code: string) => ({ code: "SHOT_CUT_" + code });
const request = [left, right];

test("a cut keeps its supplied order and maps the half-open seam to the two source clocks", () => {
  const plan = planShotCut(request);
  assert.deepEqual(plan.spans.map(span => span.output), [{ startFrame: 0, durationFrames: 3 }, { startFrame: 3, durationFrames: 2 }]);
  assert.equal(plan.durationFrames, 5);
  assert.deepEqual([locateShotCutFrame(plan, 2), locateShotCutFrame(plan, 3)], [
    { outputFrame: 2, segmentId: left.id, mediaFrame: 2, sourceFrame: 9 },
    { outputFrame: 3, segmentId: right.id, mediaFrame: 0, sourceFrame: 21 },
  ]);
  assert.equal(locateShotCutFrame(plan, 4).sourceFrame, 22);
  assert.throws(() => locateShotCutFrame(plan, 5), check("RANGE"));
  assert.throws(() => locateShotCutFrame(plan, 1.5), check("RANGE"));
  plan.spans[0].source.range.startFrame = 0;
  assert.equal(left.segment.source.range.startFrame, 7);
});

test("a cut does not implicitly resize, retime or accept an unbounded span list", () => {
  for (const profile of [{ ...right.segment.profile, fps: 30 }, { ...right.segment.profile, width: 1280 }])
    assert.throws(() => planShotCut([left, { ...right, segment: { ...right.segment, profile } }]), check("PROFILE"));
  assert.throws(() => planShotCut([left]), check("INPUT"));
  assert.throws(() => planShotCut([left, right, left]), check("INPUT"));
  assert.throws(() => planShotCut([left, { ...right, id: "local.mp4" }]), check("INPUT"));
});

test("decoded ordinals catch a shifted or repeated seam even with the correct frame count", () => {
  const plan = planShotCut(request), expected = [["a0", "a1", "a2"], ["b0", "b1"]];
  assert.doesNotThrow(() => assertShotCutFrames(plan, expected, expected.flat()));
  assert.throws(() => assertShotCutFrames(plan, expected, ["a0", "a1", "a2", "a2", "b0"]), /output frame 3/);
  assert.throws(() => assertShotCutFrames(plan, expected, ["b0", "b1", "a0", "a1", "a2"]), /output frame 0/);
  assert.throws(() => assertShotCutFrames(plan, expected, ["a0", "a1", "a2", "b0"]), check("FRAMES"));
});

test("missing or misbound retained IDs fail before the assembly process can start", async () => {
  const missing = { read: async () => { throw new Error("segment not retained"); } };
  await assert.rejects(() => assembleShotCut(missing, request.map(item => item.id)), /not retained/);
  const wrong: Pick<RetainedShotSegmentStore, "read"> = {
    read: async () => ({ record: { id: right.id } } as Awaited<ReturnType<RetainedShotSegmentStore["read"]>>),
  };
  await assert.rejects(() => assembleShotCut(wrong, request.map(item => item.id)), check("SOURCE"));
});

test("a cancelled cut does not load any retained bytes", async () => {
  const abort = new AbortController();
  abort.abort(new Error("stop"));
  const store = { read: async () => { assert.fail("read should not start"); } };
  await assert.rejects(() => assembleShotCut(store, request.map(item => item.id), abort.signal), /stop/);
});
