import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import fixture from "../../projects/cpu-cache/project.json";
import type { ProjectDocument, SceneNode } from "../contracts/project";
import type { ProjectPatchDocument } from "../contracts/project-patch";
import { applyProjectPatch } from "./project-patches";
import { migrateProject } from "./project-migrations";
import { hashProject, InMemorySnapshotStore } from "./project-snapshots";
import { FileSystemSnapshotStore } from "./filesystem-snapshot-store";
import { instantiatePrefab } from "./prefabs";
import { sampleAnimationTrack, validateAnimationTrack } from "./animation";

const project = structuredClone(fixture) as unknown as ProjectDocument;
const options = { currentRevisionId: "revision-initial", newRevisionId: "revision-test", createdAt: "2026-11-13T12:00:00.000Z", message: "unit test patch" };
const node = (id: string, parentId?: string): SceneNode => ({
  id, name: id, type: "group", parentId,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [],
});

test("add-node creates root and preserves source immutability", () => {
  const before = hashProject(project);
  const patch: ProjectPatchDocument = { schemaVersion: "1.1.0", projectId: project.project.id, baseRevisionId: "revision-initial", patches: [{ op: "add-node", sceneId: "scene-intro", node: node("node-new") }] };
  const result = applyProjectPatch(project, patch, options);
  assert.ok(result.project.nodes.some((item) => item.id === "node-new"));
  assert.ok(result.project.scenes[0].rootNodeIds.includes("node-new"));
  assert.equal(hashProject(project), before);
});

test("reparent-node updates both sides of hierarchy", () => {
  const source = structuredClone(project);
  source.nodes.push(node("node-parent"), node("node-child"));
  source.scenes.find((item) => item.id === "scene-hierarchy")!.rootNodeIds.push("node-parent");
  source.nodes.find((item) => item.id === "node-parent")!.childIds = ["node-child"];
  source.nodes.find((item) => item.id === "node-child")!.parentId = "node-parent";
  const patch: ProjectPatchDocument = { schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial", patches: [{ op: "reparent-node", nodeId: "node-child", sceneId: "scene-hierarchy", newParentId: "node-cache-stack" }] };
  const result = applyProjectPatch(source, patch, options);
  assert.equal(result.project.nodes.find((item) => item.id === "node-child")?.parentId, "node-cache-stack");
  assert.ok(result.project.nodes.find((item) => item.id === "node-cache-stack")?.childIds?.includes("node-child"));
  assert.ok(!result.project.nodes.find((item) => item.id === "node-parent")?.childIds?.includes("node-child"));
});

test("recursive removal cleans constraints and dependency edges", () => {
  const source = structuredClone(project);
  const originalConstraintCount = source.constraints.length;
  const originalDependencyCount = source.dependencies.length;
  source.nodes.push(node("node-child", "node-cpu"));
  source.nodes.find((item) => item.id === "node-cpu")!.childIds = ["node-child"];
  source.constraints.push({ id: "constraint-test", type: "look-at", sourceNodeId: "node-child", targetNodeId: "node-memory", enabled: true, parameters: {} });
  source.dependencies.push({ id: "dep-test", fromType: "node", fromId: "node-child", toType: "asset", toId: "asset-episode-narration", relation: "references" });
  const patch: ProjectPatchDocument = { schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial", patches: [{ op: "remove-node", nodeId: "node-cpu", recursive: true }] };
  const result = applyProjectPatch(source, patch, options);
  assert.ok(!result.project.nodes.some((item) => ["node-cpu", "node-child"].includes(item.id)));
  assert.equal(result.project.constraints.length, originalConstraintCount);
  assert.equal(result.project.dependencies.length, originalDependencyCount - 1);
  assert.ok(!result.project.dependencies.some((item) => item.id === "dep-test"));
  assert.ok(!result.project.dependencies.some((item) =>
    (item.fromType === "node" && ["node-cpu", "node-child"].includes(item.fromId)) ||
    (item.toType === "node" && ["node-cpu", "node-child"].includes(item.toId))
  ));
});

test("rejects stale revisions and hierarchy cycles atomically", () => {
  const stale: ProjectPatchDocument = { schemaVersion: "1.1.0", projectId: project.project.id, baseRevisionId: "old-revision", patches: [{ op: "add-node", sceneId: "scene-intro", node: node("node-stale") }] };
  assert.throws(() => applyProjectPatch(project, stale, options), /Revision conflict/);
  const source = structuredClone(project);
  source.nodes.push(node("node-descendant", "node-cpu"));
  source.nodes.find((item) => item.id === "node-cpu")!.childIds = ["node-descendant"];
  const cyclic: ProjectPatchDocument = { schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial", patches: [{ op: "reparent-node", nodeId: "node-cpu", sceneId: "scene-intro", newParentId: "node-descendant" }] };
  assert.throws(() => applyProjectPatch(source, cyclic, options), /cycle/);
  assert.ok(!project.nodes.some((item) => item.id === "node-stale"));
});

test("migrates v1.0.0 project additively to v1.1.0", () => {
  const legacy = structuredClone(project) as ProjectDocument;
  (legacy as { schemaVersion: string }).schemaVersion = "1.0.0";
  delete (legacy as Partial<ProjectDocument>).prefabs;
  delete (legacy as Partial<ProjectDocument>).constraints;
  delete (legacy as Partial<ProjectDocument>).dependencies;
  const migrated = migrateProject(legacy as never);
  assert.equal(migrated.schemaVersion, "1.1.0");
  assert.deepEqual(migrated.prefabs, []);
  assert.deepEqual(migrated.constraints, []);
  assert.deepEqual(migrated.dependencies, []);
  assert.equal((legacy as { schemaVersion: string }).schemaVersion, "1.0.0");
});

test("in-memory snapshots restore immutable content and verify hashes", () => {
  const store = new InMemorySnapshotStore();
  const snapshot = store.save(project, { id: "snapshot-1", createdAt: options.createdAt });
  const restored = store.restore(snapshot.id);
  assert.equal(hashProject(restored), snapshot.contentHash);
  restored.project.name = "mutated copy";
  assert.equal(store.restore(snapshot.id).project.name, project.project.name);
  assert.equal(store.list(project.project.id).length, 1);
  assert.throws(() => store.save(project, { id: "snapshot-1", createdAt: options.createdAt }), /already exists/);
});

test("filesystem snapshots persist, restore, list, and detect tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-snapshots-"));
  try {
    const store = new FileSystemSnapshotStore(directory);
    const snapshot = await store.save(project, { id: "disk-snapshot", createdAt: options.createdAt });
    assert.equal((await store.get(snapshot.id))?.contentHash, snapshot.contentHash);
    assert.equal((await store.list(project.project.id)).length, 1);
    assert.equal(hashProject(await store.restore(snapshot.id)), snapshot.contentHash);
    const file = join(directory, "disk-snapshot.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.document.project.name = "tampered";
    await writeFile(file, JSON.stringify(raw));
    await assert.rejects(() => store.restore(snapshot.id), /integrity check failed/);
    await assert.rejects(() => store.save(project, { id: "../escape", createdAt: options.createdAt }), /unsupported path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("property: arbitrary node transforms preserve source immutability", () => {
  fc.assert(fc.property(
    fc.tuple(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ noNaN: true, noDefaultInfinity: true })),
    (position) => {
      const source = structuredClone(project);
      const before = hashProject(source);
      const patch: ProjectPatchDocument = { schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial", patches: [{ op: "update-node", nodeId: "node-cpu", changes: { transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] } } }] };
      const result = applyProjectPatch(source, patch, options);
      assert.deepEqual(result.project.nodes.find((item) => item.id === "node-cpu")?.transform.position, position);
      assert.equal(hashProject(source), before);
    }
  ), { numRuns: 100 });
});


test("prefab instantiation clones a subtree with remapped IDs without mutating source", () => {
  const source = structuredClone(project);
  source.nodes.find((item) => item.id === "node-cpu")!.childIds = ["node-memory"];
  source.nodes.find((item) => item.id === "node-memory")!.parentId = "node-cpu";
  source.prefabs.push({ id: "prefab-cpu-memory", name: "CPU Memory Pair", rootNodeIds: ["node-cpu"] });
  const before = hashProject(source);
  const result = instantiatePrefab(source, "prefab-cpu-memory", "scene-hit", {
    instanceIdPrefix: "instance-01",
    nameSuffix: "Instance 01",
    position: [100, 20, 0],
  });
  assert.equal(hashProject(source), before);
  assert.deepEqual(result.createdNodeIds.sort(), ["instance-01__node-cpu", "instance-01__node-memory"]);
  const clonedRoot = result.project.nodes.find((item) => item.id === "instance-01__node-cpu")!;
  const clonedChild = result.project.nodes.find((item) => item.id === "instance-01__node-memory")!;
  assert.equal(clonedChild.parentId, clonedRoot.id);
  assert.deepEqual(clonedRoot.childIds, [clonedChild.id]);
  assert.ok(result.project.scenes.find((item) => item.id === "scene-hit")!.rootNodeIds.includes(clonedRoot.id));
  assert.equal(clonedRoot.transform.position[0], source.nodes.find((item) => item.id === "node-cpu")!.transform.position[0] + 100);
});


test("rejects cross-scene parenting and leaves the source untouched", () => {
  const source = structuredClone(project);
  const before = hashProject(source);
  const patch: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "add-node", sceneId: "scene-intro", node: node("node-cross-scene-child", "node-cache-stack") }],
  };
  assert.throws(() => applyProjectPatch(source, patch, options), /does not belong to the target scene/);
  assert.equal(hashProject(source), before);
});

test("recursive removal cleans prefab roots and reports changed old parent", () => {
  const source = structuredClone(project);
  source.nodes.push(node("node-child", "node-cpu"));
  source.nodes.find((item) => item.id === "node-cpu")!.childIds = ["node-child"];
  source.prefabs.push({ id: "prefab-child", name: "Child Prefab", rootNodeIds: ["node-child"] });
  const remove: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "remove-node", nodeId: "node-cpu", recursive: true }],
  };
  const removed = applyProjectPatch(source, remove, options);
  assert.deepEqual(removed.project.prefabs.find((item) => item.id === "prefab-child")?.rootNodeIds, []);

  const reparentSource = structuredClone(project);
  reparentSource.nodes.push(node("node-parent"), node("node-child", "node-parent"));
  reparentSource.scenes.find((item) => item.id === "scene-hit")!.rootNodeIds.push("node-parent");
  reparentSource.nodes.find((item) => item.id === "node-parent")!.childIds = ["node-child"];
  const move: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: reparentSource.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "reparent-node", nodeId: "node-child", sceneId: "scene-hierarchy", newParentId: "node-cache-stack" }],
  };
  const moved = applyProjectPatch(reparentSource, move, options);
  assert.ok(moved.changedNodeIds.includes("node-parent"));
  assert.ok(moved.changedNodeIds.includes("node-cache-stack"));
});


test("animation tracks validate targets, ordering, and unique keyframe frames", () => {
  const track = project.animationTracks[0];
  assert.deepEqual(validateAnimationTrack(track), []);
  assert.equal(validateAnimationTrack({ ...track, keyframes: [...track.keyframes].reverse() }).includes("Keyframes must be sorted by ascending frame"), true);
  assert.ok(validateAnimationTrack({ ...track, keyframes: [track.keyframes[0], track.keyframes[0]] }).some((error) => error.includes("Duplicate")));
});

test("animation sampling interpolates numeric values and respects step keys", () => {
  const track = {
    id: "test-track", targetNodeId: "node-cpu", targetProperty: "opacity",
    keyframes: [
      { frame: 0, value: 0, interpolation: "linear" as const },
      { frame: 10, value: 1, interpolation: "linear" as const },
    ],
  };
  assert.equal(sampleAnimationTrack(track, 5)?.value, 0.5);
  assert.equal(sampleAnimationTrack({ ...track, keyframes: track.keyframes.map((key) => ({ ...key, interpolation: "step" as const })) }, 5)?.value, 0);
  assert.equal(sampleAnimationTrack(track, 20)?.value, 1);
  assert.throws(() => sampleAnimationTrack(track, -1), /non-negative/);
});

test("animation sampling interpolates vector arrays and loops deterministically", () => {
  const track = {
    id: "vector-track", targetNodeId: "node-cpu", targetProperty: "transform.position", loop: true,
    keyframes: [
      { frame: 0, value: [0, 0, 0] },
      { frame: 20, value: [20, 10, 0] },
    ],
  };
  assert.deepEqual(sampleAnimationTrack(track, 10)?.value, [10, 5, 0]);
  assert.deepEqual(sampleAnimationTrack(track, 25)?.value, [5, 2.5, 0]);
});
