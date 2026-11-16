import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectDocument, ProjectAnimationTrack, SceneNode } from "../contracts/project";
import type { ProjectPatchDocument, ProjectPatchOperation } from "../contracts/project-patch";
import { createEmptyProject } from "./empty-project";
import { applyProjectPatch } from "./project-patches";
import { assertCreativeDocument } from "./project-creative-edits";
import { sampleAnimationTrack, sampleEasing, validateAnimationTrack } from "./animation";

const date = "2026-11-15T00:00:00.000Z";
const empty = () => createEmptyProject({ id: "project-test", name: "Two-topic scaffold", episodeId: "approved-editorial", durationFrames: 300, createdAt: date });
const node = (id = "n"): SceneNode => ({ id, name: id, type: "shape", transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }, components: [{ kind: "geometry", data: { primitive: "rectangle" } }] });
const animation = (changes: Partial<ProjectAnimationTrack> = {}): ProjectAnimationTrack => ({ id: "a", targetNodeId: "n", targetProperty: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 60, value: 1 }], ...changes });
function edit(source: ProjectDocument, patches: ProjectPatchOperation[], version: ProjectPatchDocument["schemaVersion"] = "1.3.0") {
  return applyProjectPatch(source, { schemaVersion: version, projectId: source.project.id, baseRevisionId: source.revisions.at(-1)!.id, patches }, {
    currentRevisionId: source.revisions.at(-1)!.id, newRevisionId: `revision-${source.revisions.length}`, createdAt: date, message: "creative edit",
  });
}
const setup = (source = empty()) => edit(source, [
  { op: "add-scene", scene: { id: "s", name: "Scene", durationFrames: 120, rootNodeIds: [] } },
  { op: "add-node", sceneId: "s", node: node() },
  { op: "add-shot", sequenceId: "sequence-main", shot: { id: "shot", name: "Shot", sceneId: "s", startFrame: 0, durationFrames: 120 } },
  { op: "put-animation-track", track: animation() },
]).project;
const rejectsUnchanged = (source: ProjectDocument, operations: ProjectPatchOperation[], pattern: RegExp) => {
  const before = structuredClone(source); assert.throws(() => edit(source, operations), pattern); assert.deepEqual(source, before);
};

test("empty factory creates isolated canonical projects and validates dimensions/identity", () => {
  const a = empty(), b = empty(); a.project.name = "changed"; assert.notEqual(a.project.name, b.project.name);
  assert.equal(b.schemaVersion, "1.1.0"); assert.equal(b.scenes.length, 0); assertCreativeDocument(b);
  for (const overrides of [{ id: "" }, { fps: 0 }, { width: NaN }, { durationFrames: 0 }, { createdAt: "invalid" }]) assert.throws(() => createEmptyProject({ id: "p", name: "P", episodeId: "e", ...overrides }));
});
test("one creative batch builds a scene, node, shot and animation in one revision", () => {
  const source = empty(); const project = setup(source); assert.equal(source.revisions.length, 1); assert.equal(project.revisions.length, 2);
  assert.deepEqual(project.sequences[0].shotIds, ["shot"]); assert.equal(sampleAnimationTrack(project.animationTracks[0], 30)?.value, 0.5);
  assert.deepEqual(project.editorial, source.editorial);
});
test("new operations reject old protocols; legacy node and asset operations remain accepted", () => {
  for (const version of ["1.1.0", "1.2.0"] as const) assert.throws(() => edit(empty(), [{ op: "add-scene", scene: { id: "s", name: "S", durationFrames: 10, rootNodeIds: [] } }], version), /1.3.0/);
  assert.equal(edit(setup(), [{ op: "update-node", nodeId: "n", changes: { name: "Old client" } }], "1.1.0").project.nodes[0].name, "Old client");
  for (const version of ["1.2.0", "1.3.0"] as const) assert.equal(edit(empty(), [{ op: "add-asset", asset: { id: "x", kind: "data", uri: "external.json" } }], version).project.assets.length, 1);
});
test("unsupported runtime operations and non-JSON inputs fail atomically", () => {
  rejectsUnchanged(setup(), [{ op: "invented" } as never], /Unsupported/);
  rejectsUnchanged(setup(), [{ op: "update-scene", sceneId: "s", changes: { metadata: { value: NaN } } }], /finite JSON/);
});
test("scene and shot changes cannot replace identities or hierarchy indirectly", () => {
  rejectsUnchanged(setup(), [{ op: "update-scene", sceneId: "s", changes: { id: "bad" } as never }], /Unsupported/);
  rejectsUnchanged(setup(), [{ op: "update-scene", sceneId: "s", changes: { rootNodeIds: [] } as never }], /Unsupported/);
  rejectsUnchanged(setup(), [{ op: "update-shot", shotId: "shot", changes: { id: "bad" } as never }], /Unsupported/);
  rejectsUnchanged(setup(), [{ op: "update-node", nodeId: "n", changes: { id: "" } }], /Unsupported/);
});
test("duplicate scenes and shots are rejected without partially applying preceding edits", () => {
  rejectsUnchanged(setup(), [{ op: "update-node", nodeId: "n", changes: { name: "do not retain" } }, { op: "add-scene", scene: { id: "s", name: "S", durationFrames: 30, rootNodeIds: [] } }], /already exists/);
  rejectsUnchanged(setup(), [{ op: "add-shot", sequenceId: "sequence-main", shot: { id: "shot", name: "S", sceneId: "s", startFrame: 0, durationFrames: 1 } }], /already exists/);
});
test("new scenes cannot adopt existing nodes by copying root IDs", () => {
  rejectsUnchanged(setup(), [{ op: "add-scene", scene: { id: "s2", name: "S", durationFrames: 30, rootNodeIds: ["n"] } }], /must be empty/);
});
test("timeline editing validates missing scenes/sequences and bounds", () => {
  const base = setup();
  rejectsUnchanged(base, [{ op: "add-shot", sequenceId: "none", shot: { id: "x", name: "X", sceneId: "s", startFrame: 0, durationFrames: 1 } }], /Sequence not found/);
  for (const changes of [{ sceneId: "none" }, { startFrame: -1 }, { startFrame: 299 }, { durationFrames: 121 }, { durationFrames: 0 }]) rejectsUnchanged(base, [{ op: "update-shot", shotId: "shot", changes }], /bounds|Invalid/);
});
test("shrinking scenes considers both shots and animation endpoints", () => {
  rejectsUnchanged(setup(), [{ op: "update-scene", sceneId: "s", changes: { durationFrames: 30 } }], /bounds/);
  const noShot = edit(setup(), [{ op: "remove-shot", shotId: "shot" }]).project;
  rejectsUnchanged(noShot, [{ op: "update-scene", sceneId: "s", changes: { durationFrames: 30 } }], /Animation exceeds/);
  assert.equal(edit(setup(), [{ op: "update-shot", shotId: "shot", changes: { durationFrames: 60 } }, { op: "update-scene", sceneId: "s", changes: { durationFrames: 60 } }]).project.scenes[0].durationFrames, 60);
});
test("scene removal is explicit; consumers and dependency edges protect it", () => {
  rejectsUnchanged(setup(), [{ op: "remove-scene", sceneId: "s" }], /in use/);
  const base = setup(); base.dependencies.push({ id: "dep", fromType: "shot", fromId: "shot", toType: "scene", toId: "s", relation: "uses" });
  rejectsUnchanged(base, [{ op: "remove-shot", shotId: "shot" }], /in use/);
  const result = edit(setup(), [{ op: "remove-shot", shotId: "shot" }, { op: "remove-node", nodeId: "n" }, { op: "remove-scene", sceneId: "s" }]);
  assert.equal(result.project.scenes.length, 0); assert.equal(result.project.animationTracks.length, 0);
  assert.deepEqual(result.changedSceneIds, ["s"]); assert.deepEqual(result.changedShotIds, ["shot"]); assert.deepEqual(result.changedAnimationTrackIds, ["a"]);
});
test("animation put replaces by stable ID and remove reports its change", () => {
  const result = edit(setup(), [{ op: "put-animation-track", track: animation({ keyframes: [{ frame: 0, value: 0 }, { frame: 60, value: 0.4 }] }) }]);
  assert.equal(result.project.animationTracks.length, 1); assert.equal(sampleAnimationTrack(result.project.animationTracks[0], 30)?.value, 0.2);
  const deleted = edit(result.project, [{ op: "remove-animation-track", trackId: "a" }]); assert.equal(deleted.project.animationTracks.length, 0); assert.deepEqual(deleted.changedAnimationTrackIds, ["a"]);
});
test("animation editing rejects missing targets, duplicate active targets and mismatched vectors", () => {
  for (const track of [animation({ targetNodeId: "missing" }), animation({ id: "second" }), animation({ targetProperty: "transform.position" }), animation({ targetProperty: "opacity", keyframes: [{ frame: 0, value: 2 }] })]) rejectsUnchanged(setup(), [{ op: "put-animation-track", track }], /target|tracks|Transform|Opacity/);
  assert.equal(edit(setup(), [{ op: "put-animation-track", track: animation({ id: "disabled", enabled: false }) }]).project.animationTracks.length, 2);
});
test("graph validation detects invalid root ownership and dangling references in new node edits", () => {
  rejectsUnchanged(setup(), [{ op: "add-node", sceneId: "s", node: { ...node("child"), childIds: ["missing"] } }], /hierarchy/);
  rejectsUnchanged(setup(), [{ op: "update-node", nodeId: "n", changes: { components: [{ kind: "image", data: { assetId: "missing" } }] } }], /Dangling/);
});
test("fractional/invalid frame input fails while fractional sample time is supported", () => {
  assert.throws(() => sampleAnimationTrack(animation(), -1), /non-negative/); assert.throws(() => sampleAnimationTrack(animation(), NaN), /non-negative/);
  assert.equal(sampleAnimationTrack(animation(), 1.5)?.value, 0.025);
  assert.ok(validateAnimationTrack(animation({ keyframes: [{ frame: 0.2, value: 0 }] })).length);
});
test("step switches at each exact interior key, including non-numeric values", () => {
  const track = animation({ keyframes: [{ frame: 0, value: "a", interpolation: "step" }, { frame: 10, value: "b", interpolation: "step" }, { frame: 20, value: "c", interpolation: "step" }] });
  for (const [frame, value] of [[9.99, "a"], [10, "b"], [19.99, "b"], [20, "c"]] as const) assert.equal(sampleAnimationTrack(track, frame)?.value, value);
});
test("incoming key controls its segment, preserving established protocol semantics", () => {
  const track = animation({ keyframes: [{ frame: 0, value: 0, interpolation: "step" }, { frame: 10, value: 10, interpolation: "linear" }, { frame: 20, value: 20, interpolation: "step" }] });
  assert.equal(sampleAnimationTrack(track, 5)?.value, 5); assert.equal(sampleAnimationTrack(track, 15)?.value, 10);
});
test("loop has an explicit half-open interval and clamps before a delayed first key", () => {
  const track = animation({ loop: true, keyframes: [{ frame: 10, value: 10 }, { frame: 30, value: 30 }] });
  for (const [frame, value] of [[0,10], [9,10], [10,10], [20,20], [30,10], [35,15], [70,10]]) assert.equal(sampleAnimationTrack(track, frame)?.value, value);
});
test("one-key and disabled tracks have deterministic isolated samples", () => {
  const track = animation({ keyframes: [{ frame: 10, value: [1,2,3] }] });
  const sample = sampleAnimationTrack(track, 20)!; (sample.value as number[])[0] = 99;
  assert.deepEqual(sampleAnimationTrack(track, 0)?.value, [1,2,3]); assert.equal(sampleAnimationTrack({ ...track, enabled: false }, 1), undefined);
});
test("bezier easing solves x(t), not simply y(progress)", () => {
  assert.ok(Math.abs(sampleEasing("ease", 0.5) - 0.802403387584857) < 1e-10);
  assert.ok(Math.abs(sampleEasing("ease-in", 0.5) - 0.3153568125725393) < 1e-10);
  assert.ok(Math.abs(sampleEasing("ease-out", 0.5) - 0.6846431874274608) < 1e-10);
  assert.ok(Math.abs(sampleEasing("ease-in-out", 0.5) - 0.5) < 1e-10);
});
test("bezier interpolation changes numeric vectors and permits explicit y overshoot", () => {
  const track = animation({ targetProperty: "transform.position", keyframes: [{ frame: 0, value: [0,0,0] }, { frame: 100, value: [100,50,0], interpolation: "bezier", easing: "ease-in" }] });
  const value = sampleAnimationTrack(track, 50)?.value as number[]; assert.ok(value[0] > 31 && value[0] < 32); assert.equal(value[1], value[0]/2);
  assert.ok(sampleEasing("cubic-bezier(0.3, 2, 0.6, 2)", 0.5) > 1);
});
test("unsupported curves and malformed easing never silently become linear", () => {
  for (const key of [{ interpolation: "hermite" }, { interpolation: "bezier" }, { easing: "spring" }, { easing: "cubic-bezier(2,0,1,1)" }, { easing: "cubic-bezier(0,,1,1)" }, { interpolation: "step", easing: "ease" }]) {
    const track = animation({ keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1, ...key } as never] });
    assert.ok(validateAnimationTrack(track).length); assert.throws(() => sampleAnimationTrack(track, 5));
    rejectsUnchanged(setup(), [{ op: "put-animation-track", track }], /interpolation|easing|Bezier|controls/);
  }
});
test("invalid key values, vector shapes, ordering and unsafe property paths are diagnosed", () => {
  for (const track of [animation({ keyframes: [] }), animation({ targetProperty: "__proto__.x" }), animation({ keyframes: [{ frame: 0, value: NaN }] }), animation({ keyframes: [{ frame: 0, value: [0,1] }, { frame: 2, value: [1] }] }), animation({ keyframes: [{ frame: 1, value: 1 }, { frame: 0, value: 0 }] }), animation({ keyframes: [{ frame: 0, value: 0 }, { frame: 0, value: 1 }] }), animation({ keyframes: [{ frame: 0, value: "x" }, { frame: 1, value: "y" }] })]) assert.ok(validateAnimationTrack(track).length);
});
test("linear interpolation remains finite for large opposite endpoints", () => {
  const track = animation({ keyframes: [{ frame: 0, value: -1e308 }, { frame: 2, value: 1e308 }] });
  assert.equal(sampleAnimationTrack(track, 1)?.value, 0);
});
test("sampled easing endpoints and monotonicity are deterministic over a dense grid", () => {
  for (const name of ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0,0,0,1)"]) {
    let previous = -1; for (let i=0;i<=100;i++) { const y=sampleEasing(name,i/100); assert.ok(y >= previous - 1e-12); assert.ok(y >= 0 && y <= 1); previous=y; }
    assert.equal(sampleEasing(name,0),0); assert.equal(sampleEasing(name,1),1);
  }
});
test("seeded edit sequences preserve ownership and leave rejected batches unchanged", () => {
  let project = setup(); let seed = 17;
  for (let i=0;i<80;i++) {
    seed = (seed * 48271) % 2147483647;
    const value = seed % 100;
    project = edit(project, [{ op: "update-node", nodeId: "n", changes: { transform: { position: [value, i, 0], rotation: [0,0,0], scale: [1,1,1] } } }]).project;
    assertCreativeDocument(project);
    if (i%5 === 0) rejectsUnchanged(project, [{ op: "update-shot", shotId: "shot", changes: { durationFrames: 999 } }], /bounds/);
  }
  assert.equal(project.revisions.length,82);
});

test("real repository admits one competing creative batch and keeps revision ownership", async () => {
  const { InMemoryProjectRepository } = await import("./project-repository");
  const repository = new InMemoryProjectRepository(); const source = empty(); await repository.create(source);
  const request = (id: string): ProjectPatchDocument => ({ schemaVersion: "1.3.0", projectId: source.project.id, baseRevisionId: "revision-initial", patches: [{ op: "add-scene", scene: { id, name: id, durationFrames: 120, rootNodeIds: [] } }] });
  const results = await Promise.allSettled(["a", "b"].map((id) => repository.applyPatch(source.project.id, request(id), { newRevisionId: `r-${id}`, createdAt: date, message: "CAS" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const saved = (await repository.get(source.project.id))!; assert.equal(saved.scenes.length,1); assert.equal(saved.revisions.length,2);
  saved.scenes[0].name = "caller mutation"; assert.notEqual((await repository.get(source.project.id))!.scenes[0].name, "caller mutation");
});
test("real repository rejects an invalid creative batch without changing project or revision", async () => {
  const { InMemoryProjectRepository } = await import("./project-repository");
  const repository = new InMemoryProjectRepository(); const source = setup(); await repository.create(source);
  await assert.rejects(() => repository.applyPatch(source.project.id, { schemaVersion: "1.3.0", projectId: source.project.id, baseRevisionId: source.revisions.at(-1)!.id, patches: [
    { op: "update-node", nodeId: "n", changes: { name: "must not persist" } },
    { op: "put-animation-track", track: animation({ keyframes: [{ frame: 0, value: 0 }, { frame: 120, value: 1, interpolation: "hermite" }] }) },
  ] }, { newRevisionId: "invalid", createdAt: date, message: "invalid animation" }), /Unsupported interpolation/);
  assert.deepEqual(await repository.get(source.project.id), source);
});
