import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const [patchText, projectText] = await Promise.all([
  readFile("schemas/project-patch.schema.json", "utf8"),
  readFile("schemas/project.schema.json", "utf8"),
]);
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(projectText));
const validate = ajv.compile(JSON.parse(patchText));
const base = { projectId: "project-schema-test", baseRevisionId: "revision-initial" };
const node = { op: "add-node", sceneId: "scene-main", node: {
  id: "node-test", name: "Test shape", type: "shape",
  transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }, components: [],
} };
const asset = { op: "add-asset", asset: { id: "asset-test", kind: "image", uri: "artifact://sha256/" + "a".repeat(64), contentHash: "a".repeat(64) } };
const creative = [
  { op: "add-scene", scene: { id: "scene-new", name: "New scene", durationFrames: 120, rootNodeIds: [] } },
  { op: "update-scene", sceneId: "scene-new", changes: { name: "Updated scene", durationFrames: 180 } },
  { op: "remove-scene", sceneId: "scene-new" },
  { op: "add-shot", sequenceId: "sequence-main", shot: { id: "shot-new", name: "Shot", sceneId: "scene-new", startFrame: 0, durationFrames: 120 } },
  { op: "update-shot", shotId: "shot-new", changes: { startFrame: 10, durationFrames: 100 } },
  { op: "remove-shot", shotId: "shot-new" },
  { op: "put-animation-track", track: { id: "track-new", targetNodeId: "node-test", targetProperty: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 1, interpolation: "bezier", easing: "ease-in-out" }] } },
  { op: "remove-animation-track", trackId: "track-new" },
];
const check = (value, expected, label) => {
  const valid = validate(value);
  if (valid !== expected) throw new Error(`${label}: ${JSON.stringify(validate.errors)}`);
};
for (const operation of [node]) check({ ...base, schemaVersion: "1.1.0", patches: [operation] }, true, "Patch 1.1 node");
for (const operation of [node, asset]) check({ ...base, schemaVersion: "1.2.0", patches: [operation] }, true, "Patch 1.2 operation");
for (const operation of creative) {
  check({ ...base, schemaVersion: "1.3.0", patches: [operation] }, true, `Patch 1.3 ${operation.op}`);
  check({ ...base, schemaVersion: "1.2.0", patches: [operation] }, false, `Patch 1.2 must reject ${operation.op}`);
  check({ ...base, schemaVersion: "1.1.0", patches: [operation] }, false, `Patch 1.1 must reject ${operation.op}`);
}
for (const operation of [asset]) check({ ...base, schemaVersion: "1.1.0", patches: [operation] }, false, "Patch 1.1 must reject asset");
for (const invalid of [
  { op: "add-scene", scene: { id: "s", name: "S", durationFrames: 0, rootNodeIds: [] } },
  { op: "put-animation-track", track: { id: "t", targetProperty: "opacity", keyframes: [] } },
  { op: "update-shot", shotId: "x", changes: { id: "mutate-identity" } },
]) check({ ...base, schemaVersion: "1.3.0", patches: [invalid] }, false, `Invalid Patch 1.3 ${invalid.op}`);
console.log("Project Patch 1.1.0/1.2.0/1.3.0 compatibility and creative operation schemas passed.");
