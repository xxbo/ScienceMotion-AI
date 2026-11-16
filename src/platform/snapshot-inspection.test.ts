import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectDocument, SceneNode } from "../contracts/project";
import { createEmptyProject } from "./empty-project";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { inspectProjectSnapshot, MAX_INSPECTION_FRAMES } from "./snapshot-inspection";

const node = (id = "box"): SceneNode => ({ id, name: id, type: "shape",
  transform: { position: [20, 30, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  components: [{ kind: "geometry", data: { primitive: "rect", width: 50, height: 40 } }] });
function project(duration = 30): ProjectDocument {
  const p = createEmptyProject({ id: "p", name: "Inspection", episodeId: "approved", width: 640, height: 360,
    durationFrames: duration, createdAt: "2026-11-16T00:00:00Z" });
  p.scenes = [{ id: "scene", name: "Scene", durationFrames: duration, rootNodeIds: ["box"] }];
  p.nodes = [node()]; p.shots = [{ id: "shot", name: "Shot", sceneId: "scene", startFrame: 0, durationFrames: duration }];
  p.sequences[0].shotIds = ["shot"];
  return p;
}
const snapshot = (p: ProjectDocument): ProjectSnapshot => ({ id: "snapshot", projectId: p.project.id,
  schemaVersion: p.schemaVersion, createdAt: "2026-11-16T00:00:00Z", document: p, contentHash: hashProject(p) });

test("inspection is deterministic/read-only and explicitly excludes pixel/text/content validation", () => {
  const saved = snapshot(project()); const before = structuredClone(saved);
  const report = inspectProjectSnapshot(saved);
  assert.equal(report.outcome, "no-issues-detected");
  assert.equal(report.snapshotHash, saved.contentHash);
  assert.equal(report.coverage.mode, "all-frames");
  assert.equal(report.coverage.checkedFrames.length, 30);
  assert.ok(report.coverage.notChecked.includes("final-pixels"));
  assert.ok(report.coverage.notChecked.includes("text-overflow"));
  assert.ok(report.coverage.notChecked.includes("scientific-accuracy"));
  assert.deepEqual(inspectProjectSnapshot(saved), report); assert.deepEqual(saved, before);
});

test("per-frame checks catch motion leaving the canvas between valid endpoints and identify the node", () => {
  const p = project(60);
  p.animationTracks = [{ id: "move", targetNodeId: "box", targetProperty: "transform.position", keyframes: [
    { frame: 0, value: [20, 30, 0] }, { frame: 30, value: [800, 30, 0] }, { frame: 59, value: [20, 30, 0] },
  ] }];
  const report = inspectProjectSnapshot(snapshot(p));
  const outside = report.issues.find((issue) => issue.code === "INSPECT_NODE_OUTSIDE_FRAME");
  assert.equal(outside?.nodeId, "box"); assert.equal(outside?.sceneId, "scene");
  assert.ok(outside?.frames.includes(30)); assert.ok(!outside?.frames.includes(0)); assert.ok(!outside?.frames.includes(59));
  p.animationTracks[0].keyframes[1].value = [300, 30, 0];
  assert.equal(inspectProjectSnapshot(snapshot(p)).outcome, "no-issues-detected");
});

test("declared geometry accounts for nested transforms, rotation and collapsed scale", () => {
  const p = project(); const parent = node("group"); parent.type = "group"; parent.components = []; parent.childIds = ["box"];
  parent.transform.position = [620, 20, 0]; p.nodes[0].parentId = "group"; p.nodes.unshift(parent); p.scenes[0].rootNodeIds = ["group"];
  assert.ok(inspectProjectSnapshot(snapshot(p), [0]).issues.some((issue) => issue.nodeId === "box" && issue.code === "INSPECT_NODE_OUTSIDE_FRAME"));
  parent.transform.position = [0, 0, 0]; p.nodes[1].transform.position = [10, 30, 0]; p.nodes[1].transform.rotation[2] = 90;
  assert.ok(inspectProjectSnapshot(snapshot(p), [0]).issues.some((issue) => issue.code === "INSPECT_NODE_CLIPPED"));
  p.nodes[1].transform.scale = [0, 0, 1];
  assert.ok(inspectProjectSnapshot(snapshot(p), [0]).issues.some((issue) => issue.code === "INSPECT_DEGENERATE_GEOMETRY"));
});

test("render diagnostics retain node/track identity and distinguish missing scenes from empty scenes", () => {
  const p = project(); p.nodes[0].type = "mesh";
  p.animationTracks = [{ id: "unsupported-motion", targetNodeId: "box", targetProperty: "material.glow", keyframes: [{ frame: 0, value: 1 }] }];
  const report = inspectProjectSnapshot(snapshot(p), [0, 10]);
  assert.ok(report.issues.some((i) => i.code === "RENDER_UNSUPPORTED_NODE_TYPE" && i.nodeId === "box" && i.frames.length === 2));
  assert.ok(report.issues.some((i) => i.trackId === "unsupported-motion" && i.nodeId === "box"));
  assert.ok(report.issues.some((i) => i.code === "INSPECT_NO_VISIBLE_CANDIDATES"));
  p.shots![0].durationFrames = 10;
  assert.ok(inspectProjectSnapshot(snapshot(p), [10]).issues.some((i) => i.code === "RENDER_SCENE_NOT_FOUND"));
});

test("invalid chart/path content is reported as errors instead of a clean inspection", () => {
  const p = project(); p.nodes[0].components[0].data = { primitive: "chart", chartType: "pie", chartData: [{ label: "one", value: 1 }] };
  assert.ok(inspectProjectSnapshot(snapshot(p), [0]).issues.some((i) => i.code === "RENDER_INVALID_CHART_DATA" && i.level === "error" && i.nodeId === "box"));
  p.nodes[0].type = "path"; p.nodes[0].components[0].data = { pathData: "<svg/>" };
  assert.ok(inspectProjectSnapshot(snapshot(p), [0]).issues.some((i) => i.code === "RENDER_INVALID_PATH_DATA" && i.nodeId === "box"));
});

test("long sequences sample keys and boundaries and never claim whole-sequence coverage", () => {
  const p = project(900);
  p.animationTracks = [{ id: "keys", targetNodeId: "box", targetProperty: "opacity", keyframes: [
    { frame: 0, value: 1 }, { frame: 433, value: 0.5 }, { frame: 899, value: 1 },
  ] }];
  const report = inspectProjectSnapshot(snapshot(p));
  assert.equal(report.coverage.mode, "sampled-frames");
  for (const frame of [0, 432, 433, 434, 899]) assert.ok(report.coverage.checkedFrames.includes(frame));
  assert.ok(report.coverage.notChecked.includes("unsampled-frames"));
  p.animationTracks[0].keyframes = Array.from({ length: 250 }, (_, i) => ({ frame: i * 3, value: 1 }));
  const bounded = inspectProjectSnapshot(snapshot(p));
  assert.equal(bounded.coverage.checkedFrames.length, MAX_INSPECTION_FRAMES);
  assert.ok(bounded.coverage.omittedCandidateFrames > 0);
});

test("explicit frame input, integrity and work limits fail clearly instead of silently weakening checks", () => {
  const saved = snapshot(project());
  for (const frames of [[], [0, 0], [-1], [30], [1.5], Array.from({ length: 121 }, (_, i) => i)])
    assert.throws(() => inspectProjectSnapshot(saved, frames), /1–120/);
  const requested = [10, 0]; assert.deepEqual(inspectProjectSnapshot(saved, requested).coverage.checkedFrames, [0, 10]); assert.deepEqual(requested, [10, 0]);
  saved.document.project.name = "tampered";
  assert.throws(() => inspectProjectSnapshot(saved), /hash/);
  const p = project(120); p.nodes = Array.from({ length: 2100 }, (_, i) => node(`n${i}`)); p.scenes[0].rootNodeIds = p.nodes.map((n) => n.id);
  assert.throws(() => inspectProjectSnapshot(snapshot(p)), /budget/);
});

test("bounded reports disclose issue truncation and preserve an issues-found outcome", () => {
  const p = project(1); p.nodes = Array.from({ length: 205 }, (_, i) => ({ ...node(`missing-${i}`), type: "mesh" as const }));
  p.scenes[0].rootNodeIds = p.nodes.map((n) => n.id);
  const report = inspectProjectSnapshot(snapshot(p));
  assert.equal(report.issues.length, 200); assert.equal(report.issuesTruncated, true);
  assert.ok(report.omittedIssueOccurrences >= 5); assert.equal(report.outcome, "issues-found");
});
