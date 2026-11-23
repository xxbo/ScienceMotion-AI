import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDocument } from "../contracts/project";
import { createEmptyProject } from "./empty-project";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { inspectProjectTimeline } from "./snapshot-timeline-inspection";

const date = "2026-11-23T00:00:00.000Z";
const assetHash = "a".repeat(64);
const pictureHash = "b".repeat(64);
const snapshot = (document: ProjectDocument): ProjectSnapshot => ({ id: "saved", projectId: document.project.id,
  schemaVersion: document.schemaVersion, createdAt: date, contentHash: hashProject(document), document });
function fixture() {
  const p = createEmptyProject({ id: "timeline", name: "Timeline", episodeId: "test", durationFrames: 30, createdAt: date });
  p.scenes = [{ id: "a", name: "A", durationFrames: 20, rootNodeIds: [] }, { id: "b", name: "B", durationFrames: 25, rootNodeIds: [] }];
  Object.assign(p.sequences[0], { shotIds: ["out", "in"], trackIds: ["voice", "overlay"],
    captions: [{ id: "cue", text: "Text", startFrame: 6, durationFrames: 18 }],
    transitions: [{ fromShotId: "out", toShotId: "in", type: "crossfade", durationFrames: 4 }] });
  p.shots = [{ id: "out", name: "Out", sceneId: "a", startFrame: 0, inFrame: 3, durationFrames: 12 },
    { id: "in", name: "In", sceneId: "b", startFrame: 12, inFrame: 5, durationFrames: 18 }];
  p.assets = [
    { id: "wav", kind: "audio", uri: `artifact://sha256/${assetHash}`, metadata: { mediaType: "audio/wav", channels: 1, sampleRate: 48000, sampleCount: 48000 } },
    { id: "picture", kind: "image", uri: `artifact://sha256/${pictureHash}`, metadata: { mediaType: "image/png" } },
  ];
  p.clips = [
    { id: "n1", assetId: "wav", startFrame: 8, durationFrames: 2, inFrame: 4 },
    { id: "n2", assetId: "wav", startFrame: 10, durationFrames: 4 },
    { id: "mute", assetId: "wav", startFrame: 14, durationFrames: 3, gain: 0 },
    { id: "n3", assetId: "wav", startFrame: 17, durationFrames: 5 },
    { id: "plate", assetId: "picture", startFrame: 10, durationFrames: 10 },
  ];
  p.tracks = [{ id: "voice", name: "Voice", kind: "audio", clipIds: ["n3", "n1", "mute", "n2"] },
    { id: "overlay", name: "Overlay", kind: "video", clipIds: ["plate"] }];
  return p;
}

test("timeline inspection reports exact caption gaps when requested", () => {
  const saved = snapshot(fixture()), before = structuredClone(saved.document);
  const inventory = inspectProjectTimeline(saved);
  assert.equal(inventory.outcome, "no-issues-detected");
  assert.deepEqual(inventory.issues, []);
  const result = inspectProjectTimeline(saved, { requireNarrationForCaptions: true });
  assert.equal(result.outcome, "issues-found");
  assert.deepEqual(result.issues.map(issue => [issue.captionId, issue.uncovered]), [["cue",
    [{ startFrame: 6, endFrame: 8 }, { startFrame: 14, endFrame: 17 }, { startFrame: 22, endFrame: 24 }]]]);
  assert.ok(result.coverage.notChecked.includes("speech-alignment"));
  assert.deepEqual(saved.document, before);
});

test("range inspection clips all intervals and advances the source-frame origin", () => {
  const report = inspectProjectTimeline(snapshot(fixture()), { range: { startFrame: 9, durationFrames: 9 }, requireNarrationForCaptions: true });
  assert.deepEqual(report.range, { startFrame: 9, endFrame: 18 });
  assert.deepEqual(report.intervals.find(i => i.kind === "shot"), { kind: "shot", shotId: "out", sceneId: "a",
    startFrame: 9, endFrame: 12, sourceStartFrame: 12 });
  assert.deepEqual(report.intervals.find(i => i.kind === "narration"), { kind: "narration", clipId: "n1", assetId: "wav",
    artifactId: `sha256:${assetHash}`, gain: 1, startFrame: 9, endFrame: 10, sourceStartFrame: 5 });
  assert.deepEqual(report.intervals.find(i => i.kind === "crossfade"), { kind: "crossfade", fromShotId: "out",
    toShotId: "in", startFrame: 12, endFrame: 16 });
  assert.deepEqual(report.intervals.find(i => i.kind === "png"), { kind: "png", clipId: "plate", assetId: "picture",
    artifactId: `sha256:${pictureHash}`, startFrame: 10, endFrame: 18 });
  assert.deepEqual(report.issues[0].uncovered, [{ startFrame: 14, endFrame: 17 }]);
  assert.throws(() => inspectProjectTimeline(snapshot(fixture()), { range: { startFrame: 28, durationFrames: 3 } }), /inside the first sequence/);
});

test("timeline reports are bounded and require snapshot integrity", () => {
  const p = createEmptyProject({ id: "large", name: "Large", episodeId: "e", durationFrames: 10_000, createdAt: date });
  p.sequences[0].captions = Array.from({ length: 2001 }, (_, i) => ({ id: `cue-${i}`, text: "x", startFrame: i * 2, durationFrames: 1 }));
  const saved = snapshot(p);
  assert.throws(() => inspectProjectTimeline(saved), /2,000 timeline intervals/);
  const report = inspectProjectTimeline(saved, { range: { startFrame: 1, durationFrames: 4 } });
  assert.deepEqual(report.intervals.map(i => [i.startFrame, i.endFrame]), [[2, 3], [4, 5]]);
  p.sequences[0].captions[0].text = "modified";
  assert.throws(() => inspectProjectTimeline(saved), /hash does not match/);
});
