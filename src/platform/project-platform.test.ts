import test from "node:test";
import assert from "node:assert/strict";
import fixture from "../../projects/cpu-cache/project.json";
import type { ProjectDocument, SceneNode } from "../contracts/project";
import type { ProjectPatchDocument } from "../contracts/project-patch";
import { applyProjectPatch } from "../platform/project-patches";
import { migrateProject } from "../platform/project-migrations";
import { hashProject, InMemorySnapshotStore } from "../platform/project-snapshots";

const project = structuredClone(fixture) as unknown as ProjectDocument;
const options = {
  currentRevisionId: "revision-initial",
  newRevisionId: "revision-test",
  createdAt: "2026-11-13T12:00:00.000Z",
  message: "unit test patch",
};
const node = (id: string, parentId?: string): SceneNode => ({
  id, name: id, type: "group", parentId,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  components: [],
});

test("add-node creates root and preserves source immutability", () => {
  const before = hashProject(project);
  const patch: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: project.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "add-node", sceneId: "scene-intro", node: node("node-new") }],
  };
  const result = applyProjectPatch(project, patch, options);
  assert.ok(result.project.nodes.some((item) => item.id === "node-new"));
  assert.ok(result.project.scenes[0].rootNodeIds.includes("node-new"));
  assert.equal(hashProject(project), before);
});

test("reparent-node updates both sides of hierarchy", () => {
  const source = structuredClone(project);
  source.nodes.push(node("node-parent"), node("node-child"));
  source.nodes[0].childIds = ["node-child"];
  source.nodes[1].parentId = source.nodes[0].id;
  const patch: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "reparent-node", nodeId: "node-child", sceneId: "scene-intro", newParentId: "node-cache-stack" }],
  };
  const result = applyProjectPatch(source, patch, options);
  assert.equal(result.project.nodes.find((item) => item.id === "node-child")?.parentId, "node-cache-stack");
  assert.ok(result.project.nodes.find((item) => item.id === "node-cache-stack")?.childIds?.includes("node-child"));
  assert.ok(!result.project.nodes.find((item) => item.id === "node-parent")?.childIds?.includes("node-child"));
});

test("remove-node requires explicit recursive removal and cleans references", () => {
  const source = structuredClone(project);
  source.nodes.push(node("node-child", "node-cpu"));
  source.nodes[0].childIds = ["node-child"];
  source.constraints.push({
    id: "constraint-test", type: "look-at", sourceNodeId: "node-child",
    targetNodeId: "node-memory", enabled: true, parameters: {},
  });
  source.dependencies.push({
    id: "dep-test", fromType: "node", fromId: "node-child",
    toType: "asset", toId: "asset-episode-narration", relation: "references",
  });
  const patch: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: source.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "remove-node", nodeId: "node-cpu", recursive: true }],
  };
  const result = applyProjectPatch(source, patch, options);
  assert.ok(!result.project.nodes.some((item) => ["node-cpu", "node-child"].includes(item.id)));
  assert.equal(result.project.constraints.length, 0);
  assert.equal(result.project.dependencies.length, 0);
});

test("rejects stale base revision and hierarchy cycles atomically", () => {
  const stale: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: project.project.id, baseRevisionId: "old-revision",
    patches: [{ op: "add-node", sceneId: "scene-intro", node: node("node-stale") }],
  };
  assert.throws(() => applyProjectPatch(project, stale, options), /Revision conflict/);
  const cyclicSource = structuredClone(project);
  cyclicSource.nodes.push(node("node-descendant", "node-cpu"));
  cyclicSource.nodes.find((item) => item.id === "node-cpu")!.childIds = ["node-descendant"];
  const cyclic: ProjectPatchDocument = {
    schemaVersion: "1.1.0", projectId: cyclicSource.project.id, baseRevisionId: "revision-initial",
    patches: [{ op: "reparent-node", nodeId: "node-cpu", sceneId: "scene-intro", newParentId: "node-descendant" }],
  };
  assert.throws(() => applyProjectPatch(cyclicSource, cyclic, options), /cycle/);
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

test("snapshot store restores immutable content and verifies hash", () => {
  const store = new InMemorySnapshotStore();
  const snapshot = store.save(project, { id: "snapshot-1", createdAt: options.createdAt });
  const restored = store.restore(snapshot.id);
  assert.equal(hashProject(restored), snapshot.contentHash);
  restored.project.name = "mutated copy";
  assert.equal(store.restore(snapshot.id).project.name, project.project.name);
  assert.equal(store.list(project.project.id).length, 1);
  assert.throws(() => store.save(project, { id: "snapshot-1", createdAt: options.createdAt }), /already exists/);
});
