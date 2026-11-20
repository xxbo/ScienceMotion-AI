import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDocument } from "../contracts/project";
import type { TimelinePatchOperation } from "../contracts/project-patch";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";
import { createEmptyProject } from "./empty-project";
import { applyProjectPatch } from "./project-patches";
import { chooseInspectionFrames } from "./snapshot-inspection";

const createdAt = "2026-11-20T00:00:00.000Z";
const hash = "a".repeat(64);
function project() {
  const document = createEmptyProject({ id: "p", name: "Timeline", episodeId: "e", durationFrames: 900, createdAt });
  document.assets.push({ id: "still", kind: "image", contentHash: hash, uri: `artifact://sha256/${hash}`, metadata: { mediaType: "image/png" } });
  document.scenes.push({ id: "a", name: "A", durationFrames: 300, rootNodeIds: [] }, { id: "b", name: "B", durationFrames: 300, rootNodeIds: [] });
  return document;
}
function edit(source: ProjectDocument, ...patches: TimelinePatchOperation[]) {
  const baseRevisionId = source.revisions.at(-1)!.id;
  return applyProjectPatch(source, { schemaVersion: "1.4.0", projectId: source.project.id, baseRevisionId, patches },
    { currentRevisionId: baseRevisionId, newRevisionId: `revision-${source.revisions.length}`, createdAt, message: "Timeline edit" }).project;
}
const place = (trackId: string, startFrame: number): TimelinePatchOperation =>
  ({ op: "place-clip", trackId, clip: { id: "still-clip", assetId: "still", startFrame, durationFrames: 2 } });

test("clip-only timelines use the canvas and can move a clip between tracks", () => {
  const source = project();
  assert.equal(buildProjectRenderModel(source, 0).sceneId, "a");
  const first = edit(source, place("lower", 4));
  const next = edit(first, place("upper", 6));
  assert.deepEqual(next.tracks?.map(track => track.clipIds), [[], ["still-clip"]]);
  assert.deepEqual(next.sequences[0].trackIds, ["lower", "upper"]);
  assert.equal(buildProjectRenderModel(next, 0).sceneId, undefined);
  assert.deepEqual(buildProjectRenderModel(next, 5).videoClips, []);
  assert.deepEqual(buildProjectRenderModel(next, 6).videoClips, [{ clipId: "still-clip", artifactId: `sha256:${hash}` }]);
  assert.deepEqual(buildProjectRenderModel(next, 6, "a").videoClips, []);
  assert.deepEqual(buildProjectRenderModel(next, 8).videoClips, []);
  assert.equal(buildProjectRenderModel(first, 5).videoClips.length, 1);
});

test("projection preserves old overlap precedence within the first sequence", () => {
  const source = project();
  source.shots = [
    { id: "foreign", name: "Foreign", sceneId: "b", startFrame: 0, durationFrames: 25 },
    { id: "first", name: "First", sceneId: "a", startFrame: 0, durationFrames: 25 },
    { id: "second", name: "Second", sceneId: "b", startFrame: 0, durationFrames: 25 },
  ];
  source.sequences[0].shotIds = ["second", "first"];
  source.sequences.push({ ...source.sequences[0], id: "other", shotIds: ["foreign"] });
  assert.equal(buildProjectRenderModel(source, 0).sceneId, "a");
  assert.throws(() => edit(source, { op: "move-shot", shotId: "foreign", startFrame: 25 }), /outside the first sequence/);
  assert.throws(() => edit(source, { op: "reorder-shots", shotIds: ["first", "foreign"] }), /permutation/);
  assert.throws(() => edit(source, place("plates", 3)), /Shot overlaps/);
  const next = edit(source, { op: "reorder-shots", shotIds: ["second", "first"] });
  assert.equal(buildProjectRenderModel(next, 24).sceneId, "b");
  assert.equal(buildProjectRenderModel(next, 25).sceneId, "a");
});

test("automatic inspection samples trimmed keyframes and clip boundaries", () => {
  const source = project();
  source.scenes[0].rootNodeIds.push("marker");
  source.nodes.push({ id: "marker", type: "shape", name: "Marker", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] });
  source.animationTracks.push({ id: "animation", targetNodeId: "marker", targetProperty: "opacity",
    keyframes: [{ frame: 0, value: 0 }, { frame: 56, value: 1 }] });
  source.shots = [{ id: "shot", sceneId: "a", name: "Shot", startFrame: 241, durationFrames: 100 }];
  source.sequences[0].shotIds = ["shot"];
  const timeline = edit(source, { op: "trim-shot", shotId: "shot", inFrame: 40, durationFrames: 50 }, place("plates", 409));
  const { frames } = chooseInspectionFrames(timeline);
  for (const frame of [240, 241, 256, 257, 258, 290, 291, 408, 409, 410, 411]) assert.ok(frames.includes(frame), String(frame));
  assert.ok(!frames.includes(297));
});

test("adjacent crossfades sample trimmed scene frames and reject moving a configured boundary apart", () => {
  const source = project();
  source.shots = [
    { id: "outgoing", name: "Out", sceneId: "a", inFrame: 7, startFrame: 145, durationFrames: 20, transitionOut: "cut" },
    { id: "incoming", name: "In", sceneId: "b", inFrame: 5, startFrame: 165, durationFrames: 30 },
  ];
  source.sequences[0].shotIds = ["outgoing", "incoming"];
  const transition = { op: "set-transition", fromShotId: "outgoing", toShotId: "incoming",
    transition: { type: "crossfade", durationFrames: 5 } } as const;
  const timeline = edit(source, transition);
  assert.equal(source.sequences[0].transitions, undefined);
  assert.equal(timeline.shots?.[0].transitionOut, "cut");
  assert.equal(buildProjectRenderModel(timeline, 164).sceneFrame, 26);
  const start = buildProjectRenderModel(timeline, 165);
  assert.equal(start.sceneFrame, 5);
  assert.deepEqual(start.crossfade, { outgoingElements: [], incomingOpacity: 0 });
  assert.equal(buildProjectRenderModel(timeline, 167).crossfade?.incomingOpacity, 0.5);
  assert.equal(buildProjectRenderModel(timeline, 169).crossfade, undefined);
  assert.equal(buildProjectRenderModel(timeline, 165, "b").crossfade, undefined);
  const { frames } = chooseInspectionFrames(timeline);
  for (const f of [164, 165, 167, 169, 170]) assert.ok(frames.includes(f));
  assert.throws(() => edit(timeline, { op: "move-shot", shotId: "incoming", startFrame: 166 }), /requires adjacent shots/);
  const cleared = edit(timeline, { op: "move-shot", shotId: "incoming", startFrame: 166 }, { ...transition, transition: null });
  assert.equal(cleared.sequences[0].transitions, undefined);
  assert.equal(buildProjectRenderModel(cleared, 165).sceneId, undefined);
});
