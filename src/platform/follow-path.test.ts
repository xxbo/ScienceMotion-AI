import assert from "node:assert/strict";
import test from "node:test";
import type { FollowPathParameters, ProjectDocument, SceneNode } from "../contracts/project";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";
import { createEmptyProject } from "./empty-project";
import { prepareFollowPaths, sampleFollowPath } from "./follow-path";
import { isSafeSvgPathData } from "./graphic-values";
import { compileMotionPath } from "./motion-path";
import { assertCreativeDocument } from "./project-creative-edits";
import { InMemorySnapshotStore } from "./project-snapshots";
import { chooseInspectionFrames, inspectProjectSnapshot } from "./snapshot-inspection";

function near(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8, `Expected ${expected}, got ${actual}`));
}

test("motion path uses cumulative length across explicit and implicit relative lines", () => {
  const path = compileMotionPath("m0 0 60 0 v80 h10");
  assert.equal(path.length, 150);
  assert.deepEqual(path.pointAt(0), [0, 0]);
  assert.deepEqual(path.pointAt(0.5), [60, 15]);
  assert.deepEqual(path.pointAt(1), [70, 80]);
  assert.throws(() => path.pointAt(-0.1), /\[0, 1\]/);
});

test("motion path samples the circular arc interior, including compact flags and mixed segments", () => {
  const arc = compileMotionPath("M0 0 A10 10 0 0110 10");
  near([arc.length], [5 * Math.PI]);
  near(arc.pointAt(0.5), [Math.sqrt(50), 10 - Math.sqrt(50)]);
  const mixed = compileMotionPath("M0 0 A10 10 0 0 1 10 10 l0 10");
  near(mixed.pointAt(arc.length / mixed.length), [10, 10]);
  near(mixed.pointAt((arc.length + 5) / mixed.length), [10, 15]);
});

test("motion arcs handle sweep, large-arc choice and SVG radius expansion", () => {
  const reverseSweep = compileMotionPath("M0 0 a10 10 20 0 0 10 10");
  near(reverseSweep.pointAt(0.5), [10 - Math.sqrt(50), Math.sqrt(50)]);
  const large = compileMotionPath("M0 0 A10 10 0 1 1 10 10");
  near([large.length], [15 * Math.PI]);
  near(large.pointAt(0.5), [10 + Math.sqrt(50), -Math.sqrt(50)]);
  const expanded = compileMotionPath("M0 0 A4 4 0 0 1 10 0");
  near(expanded.pointAt(0.5), [5, -5]);
});

test("unsupported motion paths do not change the accepted static SVG grammar", () => {
  for (const data of ["M0 0 M1 2 L2 3", "M0 0 Q1 2 2 3", "M0 0 A10 9 0 0 1 3 5", "M0 0 L1 2 Z"]) {
    assert.ok(isSafeSvgPathData(data));
    assert.throws(() => compileMotionPath(data), /subpath|supports|radii/);
  }
  assert.throws(() => compileMotionPath("M0 0 h0"), /positive length/);
  assert.throws(() => compileMotionPath("<svg/>"), /valid SVG/);
});

const node = (id: string, type: SceneNode["type"], x: number, y: number): SceneNode => ({
  id, name: id, type, transform: { position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [],
});
function project() {
  const p = createEmptyProject({ id: "path-test", name: "Path test", episodeId: "test", width: 640, height: 360, durationFrames: 200 });
  const guide = node("guide", "path", 20, 30), follower = node("follower", "shape", 5, 10);
  guide.components = [{ kind: "geometry", data: { pathData: "M0 0 H100", width: 110, height: 10 } }];
  follower.components = [{ kind: "geometry", data: { primitive: "rect", width: 10, height: 10 } }];
  p.nodes = [guide, follower];
  p.scenes = [{ id: "scene", name: "Scene", rootNodeIds: [guide.id, follower.id], durationFrames: 200 }];
  p.shots = [{ id: "shot", name: "Shot", sceneId: "scene", startFrame: 0, durationFrames: 200 }];
  p.sequences[0].shotIds = ["shot"];
  const parameters: FollowPathParameters = { pathNodeId: guide.id, anchor: [5, 5],
    progress: { keyframes: [{ frame: 3, value: 0 }, { frame: 13, value: 1 }, { frame: 23, value: 0 }] } };
  p.constraints = [{ id: "walk", type: "follow-path", enabled: true, sourceNodeId: follower.id, targetNodeId: guide.id, parameters }];
  assertCreativeDocument(p);
  return p;
}
const params = (p: ProjectDocument) => p.constraints[0].parameters as FollowPathParameters;
const binding = (p: ProjectDocument) => prepareFollowPaths(p).byNode.get("follower")!;
function center(p: ProjectDocument, frame: number) {
  const model = buildProjectRenderModel(p, frame);
  assert.deepEqual(model.diagnostics, []);
  const item = model.elements.find(element => element.id === "follower")!;
  const [a, b, c, d, x, y] = item.transform.slice(7, -1).split(",").map(Number);
  return [x + (a + c) * 5, y + (b + d) * 5];
}

test("path progress holds before and after, traverses in both directions, and loops half-open", () => {
  const p = project();
  for (const [frame, x] of [[0, 0], [3, 0], [8, 50], [13, 100], [18, 50], [23, 0], [120, 0]])
    near(sampleFollowPath(binding(p), frame), [x, 0]);
  params(p).progress.loop = true;
  near(sampleFollowPath(binding(p), 33), [100, 0]);
});

test("path progress reuses step and easing keys and clamps overshooting eases to the guide", () => {
  const p = project(), key = params(p).progress.keyframes[1];
  key.interpolation = "step";
  near(sampleFollowPath(binding(p), 12), [0, 0]);
  near(sampleFollowPath(binding(p), 13), [100, 0]);
  key.interpolation = "bezier";
  key.easing = "ease-in";
  assert.ok(sampleFollowPath(binding(p), 8)[0] < 50);
  key.easing = "cubic-bezier(0.5,4,0.5,4)";
  near(sampleFollowPath(binding(p), 8), [100, 0]);
});

test("model samples shot-local time and aligns an anchor through guide and parent transforms", () => {
  const p = project(), [guide, follower] = p.nodes;
  const parent = node("parent", "group", 200, 60);
  parent.transform.rotation = [0, 0, 90];
  guide.transform.rotation = [0, 0, 90];
  follower.transform.rotation = [0, 0, 90];
  follower.transform.scale = [2, 1, 1];
  for (const child of [guide, follower]) child.parentId = parent.id;
  parent.childIds = [guide.id, follower.id];
  p.nodes.push(parent);
  p.scenes[0].rootNodeIds = [parent.id];
  Object.assign(p.shots![0], { startFrame: 40, inFrame: 3, durationFrames: 40 });
  assertCreativeDocument(p);
  near(center(p, 45), [120, 80]);
});

test("inactive path motion preserves authored pose and legacy path-only constraints", () => {
  const p = project();
  p.constraints[0].enabled = false;
  near(center(p, 13), [10, 15]);
  p.constraints[0].enabled = true;
  p.constraints[0].parameters = { pathNodeId: "guide" };
  near(center(p, 13), [10, 15]);
  assertCreativeDocument(p);
});

test("active path motion rejects invalid bindings, ranges and competing position writers", () => {
  const p = project();
  params(p).progress.keyframes[1].value = 1.01;
  assert.throws(() => assertCreativeDocument(p), /walk.*numbers in \[0, 1\]/);
  assert.ok(buildProjectRenderModel(p, 13).diagnostics.some(issue => issue.code === "RENDER_INVALID_FOLLOW_PATH" && issue.nodeId === "follower"));
  params(p).progress.keyframes[1].value = 1;
  params(p).pathNodeId = "follower";
  assert.throws(() => assertCreativeDocument(p), /pathNodeId/);
  params(p).pathNodeId = "guide";
  p.animationTracks.push({ id: "conflict", targetNodeId: "follower", targetProperty: "transform.position", keyframes: [{ frame: 0, value: [3, 4, 0] }] });
  assert.throws(() => assertCreativeDocument(p), /another enabled position driver/);
  p.animationTracks[0].enabled = false;
  assertCreativeDocument(p);
  p.constraints.push({ ...structuredClone(p.constraints[0]), id: "second" });
  assert.throws(() => assertCreativeDocument(p), /another enabled position driver/);
});

test("guide and follower must be siblings in the same scene", () => {
  const p = project();
  const parent = node("parent", "group", 10, 10);
  p.nodes[0].parentId = parent.id;
  parent.childIds = ["guide"];
  p.nodes.push(parent);
  p.scenes[0].rootNodeIds = [parent.id, "follower"];
  assert.throws(() => assertCreativeDocument(p), /same scene and immediate parent|one scene and immediate parent/);
  p.scenes[0].rootNodeIds = ["follower"];
  p.scenes.push({ id: "other", name: "Other", rootNodeIds: [parent.id], durationFrames: 200 });
  assert.ok(prepareFollowPaths(p).issues.some(issue => issue.message.includes("one scene")));
});

test("automatic inspection samples motion keys and reports moved bounds", () => {
  const p = project();
  params(p).progress.keyframes = [{ frame: 0, value: 0 }, { frame: 137, value: 1 }];
  p.nodes[0].transform.position = [600, 30, 0];
  assert.ok(chooseInspectionFrames(p).frames.includes(137));
  const saved = new InMemorySnapshotStore().save(p, { id: "inspection", createdAt: p.project.createdAt });
  const report = inspectProjectSnapshot(saved, [0, 137]);
  assert.deepEqual(report.issues.find(issue => issue.code === "INSPECT_NODE_OUTSIDE_FRAME" && issue.nodeId === "follower")?.frames, [137]);
});
