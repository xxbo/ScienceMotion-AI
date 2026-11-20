import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const patchSchema = JSON.parse(await readFile("schemas/project-patch.schema.json", "utf8"));
const collectRefs = (value, refs = []) => {
  if (!value || typeof value !== "object") return refs;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const child of Object.values(value)) collectRefs(child, refs);
  return refs;
};
const externalRefs = collectRefs(patchSchema).filter((ref) => !ref.startsWith("#/"));
if (externalRefs.length) throw new Error(`Patch Schema must be self-contained; found external refs: ${externalRefs.join(", ")}`);
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(patchSchema);
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
const check = (value, expected, label, validator = validate) => {
  const valid = validator(value);
  if (valid !== expected) throw new Error(`${label}: ${JSON.stringify(validator.errors)}`);
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
const timelineSchema = JSON.parse(await readFile("schemas/project-timeline-patch.schema.json", "utf8"));
const validateTimeline = ajv.compile(timelineSchema);
const crossfade = { op: "set-transition", fromShotId: "shot-new", toShotId: "shot-2",
  transition: { type: "crossfade", durationFrames: 5 } };
const caption = { op: "set-caption", captionId: "narration", caption: { text: "Caption", startFrame: 0, durationFrames: 3 } };
const timeline = [
  { op: "move-shot", shotId: "shot-new", startFrame: 0 },
  { op: "trim-shot", shotId: "shot-new", inFrame: 5, durationFrames: 12 },
  { op: "reorder-shots", shotIds: ["shot-new", "shot-2"] },
  { op: "place-clip", trackId: "video", clip: { id: "clip", assetId: "asset-test", startFrame: 0, durationFrames: 3 } },
  crossfade, { ...crossfade, transition: null },
  { op: "place-clip", trackId: "audio", clip: { id: "voice", assetId: "wave", startFrame: 0, durationFrames: 12, inFrame: 3, gain: 0.5 } },
  caption, { ...caption, caption: null },
];
const batch = { ...base, schemaVersion: "1.4.0", patches: timeline };
check(batch, true, "Timeline batch", validateTimeline);
check(batch, false, "Legacy schema must reject Patch 1.4");
for (const operation of [node, { ...timeline[0], startFrame: -1 }, { ...timeline[1], durationFrames: 0 },
  { ...timeline[2], shotIds: ["shot-new", "shot-new"] }, { ...timeline[3], path: "extra.png" },
  { ...caption, caption: { ...caption.caption, durationFrames: 0 } },
  { ...crossfade, transition: { type: "crossfade", durationFrames: 1 } }]) {
  check({ ...batch, patches: [operation] }, false, `Invalid Timeline Patch ${operation.op}`, validateTimeline);
}
console.log("Legacy Project Patch compatibility and Timeline Patch 1.4.0 validation passed.");
