import assert from "node:assert/strict";
import test from "node:test";
import type { CreativePlannerDecision } from "../contracts/creative-planner";
import type { CreativeRepairFinding } from "../contracts/creative-repair";
import type { ProjectDocument } from "../contracts/project";
import { compareRepairFindings, inspectionInput, matchesInspection } from "./creative-repair-evidence";
import { scopedRepairFindings } from "./creative-repair-scope";
import { createEmptyProject } from "./empty-project";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { inspectProjectSnapshot } from "./snapshot-inspection";

const range = (startFrame: number, endFrame: number) => ({ startFrame, endFrame });
const crop = (nodeId: string, start: number, end: number): CreativeRepairFinding => ({ check: "model", source: "declared-geometry",
  nodeId, level: "warning", code: "INSPECT_NODE_CLIPPED", message: "position", sceneId: "scene", ranges: [range(start, end)] });
const caption: CreativeRepairFinding = { check: "timeline", captionId: "cue", level: "warning", code: "TIMELINE_CAPTION_NARRATION_GAP",
  message: "caption gap", ranges: [range(6, 8), range(22, 24)] };
const initialRevision = "revision-initial";
const invoke = (toolId: string, input: unknown): Extract<CreativePlannerDecision, { kind: "invoke" }> => ({ kind: "invoke", toolId, toolVersion: "1.0.0", input });
const edit = (toolId: string, operation: unknown, revisionId = initialRevision) => invoke(toolId, { baseRevisionId: revisionId, edits: [operation] });

function project(): ProjectDocument {
  const doc = createEmptyProject({ id: "repair", name: "Repair", episodeId: "example", durationFrames: 80, width: 640, height: 360 });
  doc.scenes = [{ id: "scene", name: "Scene", durationFrames: 60, rootNodeIds: ["marker", "title"] }];
  doc.sequences[0].shotIds = ["shot"];
  doc.sequences[0].captions = [{ id: "cue", text: "Approved caption", startFrame: 6, durationFrames: 18 }];
  doc.shots = [{ id: "shot", name: "Shot", sceneId: "scene", startFrame: 20, inFrame: 5, durationFrames: 40 }];
  doc.nodes = [
    { id: "marker", name: "Marker", type: "shape", transform: { position: [620, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ kind: "geometry", data: { primitive: "rect", width: 40, height: 30 } }] },
    { id: "title", name: "Title", type: "text", transform: { position: [20, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ kind: "text", data: { text: "Approved title", width: 250, height: 20 } }] },
  ];
  doc.animationTracks = [{ id: "position", targetNodeId: "marker", targetProperty: "transform.position",
    keyframes: [0, 5, 15, 25].map(value => ({ frame: value, value: [620 + value, 20, 0] })) }];
  return doc;
}

test("repair comparison rejects moved and newly introduced occurrences and requires target progress", () => {
  const original = [crop("marker", 20, 24), caption];
  assert.equal(compareRepairFindings(original, [crop("marker", 21, 24), caption], [original[0]]), "improved");
  assert.equal(compareRepairFindings(original, [crop("marker", 21, 25), caption], [original[0]]), "regressed");
  assert.equal(compareRepairFindings(original, [crop("another", 20, 21)], [original[0]]), "regressed");
  assert.equal(compareRepairFindings(original, [original[0]], [original[0]]), "no-progress");
  assert.equal(compareRepairFindings(original, [original[0], { ...caption, ranges: [range(22, 24)] }], [caption]), "improved");
  assert.equal(compareRepairFindings(original, [original[0], { ...caption, ranges: [range(21, 23)] }], [caption]), "regressed");
});

test("repair evidence pins actual frame coverage and rejects stale or truncated reports", () => {
  const document = project();
  const saved: ProjectSnapshot = { id: "original", projectId: document.project.id, createdAt: document.project.createdAt,
    schemaVersion: document.schemaVersion, contentHash: hashProject(document), document };
  const baseline = inspectProjectSnapshot(saved);
  const checks = { model: {} };
  assert.equal(matchesInspection("model", baseline, saved, checks), true);
  const candidate = { ...saved, id: "candidate" };
  const input = inspectionInput("model", candidate.id, checks, { model: baseline });
  assert.deepEqual(input, { snapshotId: candidate.id, frames: baseline.coverage.checkedFrames });
  assert.equal(matchesInspection("model", inspectProjectSnapshot(candidate, baseline.coverage.checkedFrames), candidate, checks, { model: baseline }), true);
  assert.equal(matchesInspection("model", inspectProjectSnapshot(candidate, [22]), candidate, checks, { model: baseline }), false);
  assert.equal(matchesInspection("model", { ...baseline, snapshotHash: "other" }, saved, checks), false);
  assert.equal(matchesInspection("model", { ...baseline, issuesTruncated: true }, saved, checks), false);
});

test("repair scope binds a single geometry or keyframe edit to an observed target and revision", () => {
  const doc = project();
  const finding = crop("marker", 30, 31); // Timeline frame 30 maps to the existing scene key at frame 15.
  const resize = { kind: "shape", nodeId: "marker", changes: { width: 15 } };
  assert.deepEqual(scopedRepairFindings(edit("graphics.2d.edit", resize), doc, [finding]), [finding]);
  assert.deepEqual(scopedRepairFindings(edit("graphics.2d.edit", resize, "stale"), doc, [finding]), []);
  assert.deepEqual(scopedRepairFindings(edit("graphics.2d.edit", { ...resize, nodeId: "title" }), doc, [finding]), []);
  assert.deepEqual(scopedRepairFindings(edit("graphics.2d.edit", { ...resize, changes: { width: 15, data: [] } }), doc, [finding]), []);
  assert.deepEqual(scopedRepairFindings(invoke("graphics.2d.edit", { baseRevisionId: initialRevision, edits: [resize, resize] }), doc, [finding]), []);
  const change = { op: "update", trackId: "position", frame: 15, changes: { value: [110, 20, 0] } };
  assert.deepEqual(scopedRepairFindings(edit("animation.keyframes.edit", change), doc, [finding]), [finding]);
  assert.deepEqual(scopedRepairFindings(edit("animation.keyframes.edit", { ...change, frame: 25 }), doc, [finding]), []);
  assert.deepEqual(scopedRepairFindings(edit("animation.keyframes.edit", { ...change, changes: { ...change.changes, frame: 12 } }), doc, [finding]), []);
  doc.animationTracks[0].keyframes[2].interpolation = "step";
  assert.deepEqual(scopedRepairFindings(edit("animation.keyframes.edit", change), doc, [crop("marker", 28, 29)]), []);
  assert.deepEqual(scopedRepairFindings(edit("animation.keyframes.edit", change), doc, [finding]), [finding]);
});

test("repair scope preserves approved text and trims only measured caption gaps", () => {
  const doc = project();
  const overflow: CreativeRepairFinding = { check: "layout", nodeId: "title", sceneId: "scene", code: "LAYOUT_TEXT_OVERFLOW",
    level: "warning", message: "height", ranges: [range(20, 21)] };
  const resize = (text: string) => invoke("project.patch.apply", { schemaVersion: "1.3.0", projectId: "repair", baseRevisionId: initialRevision,
    patches: [{ op: "update-node", nodeId: "title", changes: { components: [{ kind: "text", data: { text, width: 250, height: 50 } }] } }] });
  assert.deepEqual(scopedRepairFindings(resize("Approved title"), doc, [overflow]), [overflow]);
  assert.deepEqual(scopedRepairFindings(resize("Substituted title"), doc, [overflow]), []);
  const trim = (startFrame: number, durationFrames: number, text = "Approved caption") =>
    edit("timeline.edit", { op: "set-caption", captionId: "cue", caption: { startFrame, durationFrames, text } });
  assert.deepEqual(scopedRepairFindings(trim(8, 14), doc, [caption]), [caption]);
  assert.deepEqual(scopedRepairFindings(trim(8, 16), doc, [caption]), [caption]);
  assert.deepEqual(scopedRepairFindings(trim(7, 15), doc, [caption]), []);
  assert.deepEqual(scopedRepairFindings(trim(9, 13), doc, [caption]), []);
  assert.deepEqual(scopedRepairFindings(trim(8, 14, "Substituted caption"), doc, [caption]), []);
});
