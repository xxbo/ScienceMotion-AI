import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import reference from "../../examples/three-static-scene.json";
import projectSchema from "../../schemas/project.schema.json";
import type { ProjectDocument } from "../contracts/project";
import { ProjectGraphRendererError, type ProjectGraphPreviewRequest } from "../contracts/renderer";
import { prepareThreeStaticScene, ThreeStaticSceneError, type ThreeStaticDiagnostic } from "../renderers/three/three-static-scene";
import { assertCreativeDocument } from "./project-creative-edits";
import { hashProject } from "./project-snapshots";

const validate = new Ajv({ strict: true }).compile<ProjectDocument>(projectSchema);
const source: unknown = reference;
assert.ok(validate(source), JSON.stringify(validate.errors));
const fixture: ProjectDocument = source;
const make = () => structuredClone(fixture);
const shot = (project: ProjectDocument) => project.shots![0];
const request = (project = make()): ProjectGraphPreviewRequest => ({ project, revisionId: project.revisions.at(-1)!.id, snapshotHash: hashProject(project), frame: 0 });
const diag = (code: string, path: string, nodeId?: string) => (error: unknown) => {
  assert.ok(error instanceof ThreeStaticSceneError && error instanceof ProjectGraphRendererError);
  assert.equal(error.code, `THREE_STATIC_${code}`);
  assert.equal(error.diagnostic.path, path);
  assert.equal(error.diagnostic.nodeId, nodeId);
  assert.ok(error.diagnostic.message.length > 0);
  assert.ok(error.message.includes(path));
  return true;
};
const reject = (edit: (project: ProjectDocument) => void, code: string, path: string, nodeId?: string) => {
  const project = make(); edit(project);
  assert.throws(() => prepareThreeStaticScene(request(project)), diag(code, path, nodeId));
};

test("static 3D normalizes a canonical retained scene without mutating or aliasing it", () => {
  const project = make();
  assertCreativeDocument(project);
  const input = request(project);
  const normalized = prepareThreeStaticScene(input);
  assert.deepEqual({ ...normalized, camera: normalized.camera.nodeId, meshes: normalized.meshes.map(node => node.nodeId), lights: normalized.lights.map(light => light.nodeId) }, {
    sceneId: "scene-study", sequenceId: "sequence-main", shotId: "shot-study", profile: { width: 640, height: 360, fps: 24 },
    range: { startFrame: 0, durationFrames: 1 }, backgroundColor: "#07111f", camera: "view-camera", meshes: ["blue-box", "amber-sphere"], lights: ["fill-light", "key-light"],
  });
  assert.equal(normalized.camera.projection, "perspective");
  assert.deepEqual(normalized.camera.position, [0, 2.3, 8]);
  assert.ok(Math.abs(normalized.camera.rotationRadians[0] + 7 * Math.PI / 90) < 1e-14);
  assert.deepEqual([normalized.camera.fovYDegrees, normalized.camera.near, normalized.camera.far], [38, 0.1, 50]);
  assert.deepEqual(normalized.meshes.map(node => node.geometry), [{ primitive: "box", width: 1.8, height: 1.6, depth: 1.4 }, { primitive: "sphere", radius: 1 }]);
  assert.deepEqual(normalized.meshes[0].transform.scale, [1.1, 1, 0.9]);
  assert.ok(Math.abs(normalized.meshes[0].transform.rotationRadians[1] - Math.PI / 6) < 1e-14);
  assert.deepEqual(normalized.lights, [
    { nodeId: "fill-light", type: "ambient", color: "#ffffff", intensity: 0.45 },
    { nodeId: "key-light", type: "directional", color: "#ffffff", intensity: 2, position: [-4, 5, 6], target: [0, 0, 0] },
  ]);
  const reordered = make();
  reordered.nodes.reverse();
  assert.deepEqual(prepareThreeStaticScene(request(reordered)), normalized);
  normalized.camera.position[2] = 40;
  normalized.meshes[0].transform.scale[1] = 3;
  const key = normalized.lights[1]; assert.equal(key.type, "directional"); key.target[1] = 8;
  assert.deepEqual(project, make());
  assert.equal(hashProject(project), input.snapshotHash);
});

test("static 3D pins identity, viewport, scene selection and zero-based frame bounds", () => {
  const input = request();
  const profile = { width: 640, height: 360, fps: 24 };
  assert.deepEqual(prepareThreeStaticScene({ ...input, profile, sceneId: "scene-study", frame: 47 }).range, { startFrame: 47, durationFrames: 1 });
  const { frame: _frame, ...base } = input;
  assert.deepEqual(prepareThreeStaticScene({ ...base, startFrame: 12, durationFrames: 36 }).range, { startFrame: 12, durationFrames: 36 });
  for (const frame of [-1, 1.5, 48, Infinity]) assert.throws(() => prepareThreeStaticScene({ ...input, frame }), diag("INVALID_REQUEST", "/frame"));
  assert.throws(() => prepareThreeStaticScene({ ...base, startFrame: 48, durationFrames: 1 }), diag("INVALID_REQUEST", "/startFrame"));
  for (const durationFrames of [0, 3, 0.5])
    assert.throws(() => prepareThreeStaticScene({ ...base, startFrame: 46, durationFrames }), diag("INVALID_REQUEST", "/durationFrames"));
  assert.throws(() => prepareThreeStaticScene({ ...input, profile: { ...profile, fps: 30 } }), diag("INVALID_REQUEST", "/profile"));
  assert.throws(() => prepareThreeStaticScene({ ...input, sceneId: "missing" }), diag("INVALID_REQUEST", "/sceneId"));
  assert.throws(() => prepareThreeStaticScene({ ...input, revisionId: "stale" }), diag("INVALID_SNAPSHOT", "/revisionId"));
  input.project.nodes[3].transform.position[0] = 0;
  assert.throws(() => prepareThreeStaticScene(input), diag("INVALID_SNAPSHOT", "/snapshotHash"));
  const stopped = new Error("Stop this preflight");
  assert.throws(() => prepareThreeStaticScene({ ...input, signal: AbortSignal.abort(stopped) }), error => error === stopped);
});

test("static 3D refuses other coordinate conventions and editorial features before projection", () => {
  reject(p => { p.project.coordinateSystem = "screen-y-down"; }, "UNSUPPORTED_PROJECT", "/project/project/coordinateSystem");
  reject(p => { p.project.colorSpace = "display-p3"; }, "UNSUPPORTED_PROJECT", "/project/project/colorSpace");
  reject(p => { p.scenes.push({ id: "extra", name: "Extra", durationFrames: 48, rootNodeIds: [] }); }, "UNSUPPORTED_TIMELINE", "/project/scenes");
  reject(p => { shot(p).startFrame = 5; shot(p).durationFrames = 43; }, "UNSUPPORTED_TIMELINE", "/project/shots/0/startFrame");
  reject(p => { shot(p).inFrame = 1; p.scenes[0].durationFrames++; }, "UNSUPPORTED_TIMELINE", "/project/shots/0/inFrame");
  reject(p => { p.sequences[0].captions = [{ id: "caption", startFrame: 0, durationFrames: 10, text: "Unsupported here" }]; }, "UNSUPPORTED_FEATURE", "/project/sequences/0/captions");
  reject(p => { shot(p).transitionOut = "dissolve"; }, "UNSUPPORTED_FEATURE", "/project/shots/0/transitionOut");
  reject(p => { p.assets.push({ id: "mesh-file", uri: "artifact://external", kind: "model" }); }, "UNSUPPORTED_FEATURE", "/project/assets");
  assert.throws(() => prepareThreeStaticScene({ ...request(), imageAssets: { picture: "unused" } }), diag("UNSUPPORTED_FEATURE", "/imageAssets"));
});

test("static 3D reports a camera key or constraint by source identity and ignores disabled entries", () => {
  const p = make(), original = prepareThreeStaticScene(request(p));
  p.animationTracks.push({ id: "camera-move", targetNodeId: "view-camera", targetProperty: "transform.position", keyframes: [{ frame: 0, value: [0, 0, 8] }] });
  const details = (error: unknown) => (error as ThreeStaticSceneError).diagnostic as ThreeStaticDiagnostic;
  assert.throws(() => prepareThreeStaticScene(request(p)), error => {
    diag("UNSUPPORTED_ANIMATION", "/project/animationTracks/0", "view-camera")(error);
    assert.equal(details(error).trackId, "camera-move");
    assert.equal(details(error).sceneId, "scene-study");
    return true;
  });
  p.animationTracks[0].enabled = false;
  p.constraints.push({ id: "aim", type: "look-at", sourceNodeId: "view-camera", targetNodeId: "blue-box", enabled: true, parameters: {} });
  assert.throws(() => prepareThreeStaticScene(request(p)), error => {
    diag("UNSUPPORTED_FEATURE", "/project/constraints/0", "view-camera")(error);
    assert.equal(details(error).constraintId, "aim");
    return true;
  });
  p.constraints[0].enabled = false;
  assert.deepEqual(prepareThreeStaticScene(request(p)), original);
});

test("static 3D rejects non-root and unsupported node types without silently dropping them", () => {
  reject(p => { p.nodes[3].type = "text"; }, "UNSUPPORTED_NODE", "/project/nodes/3/type", "blue-box");
  reject(p => { p.nodes[3].childIds = ["amber-sphere"]; p.nodes[4].parentId = "blue-box"; p.scenes[0].rootNodeIds.pop(); },
    "UNSUPPORTED_NODE", "/project/nodes/3", "blue-box");
  reject(p => { p.scenes[0].rootNodeIds.push("blue-box"); }, "INVALID_ROOTS", "/project/scenes/0/rootNodeIds/5", "blue-box");
  reject(p => { p.scenes[0].rootNodeIds.pop(); }, "INVALID_ROOTS", "/project/scenes/0/rootNodeIds", "amber-sphere");
});

test("static 3D checks transform and geometry values including float32 overflow", () => {
  const base = "/project/nodes/3";
  reject(p => { p.nodes[3].transform.position[2] = Infinity; }, "INVALID_TRANSFORM", base + "/transform/position", "blue-box");
  reject(p => { p.nodes[3].transform.scale = [-1, 1, 1]; }, "INVALID_TRANSFORM", base + "/transform/scale", "blue-box");
  reject(p => { p.nodes[3].transform.pivot = [0, 1, 0]; }, "INVALID_TRANSFORM", base + "/transform/pivot", "blue-box");
  reject(p => { p.nodes[3].transform.scale[0] = 1e38; p.nodes[3].components[0].data.width = 1e38; }, "INVALID_TRANSFORM", base + "/transform/scale", "blue-box");
  reject(p => { p.nodes[3].components[0].data.width = 0; }, "INVALID_GEOMETRY", base + "/components/0/data/width", "blue-box");
  reject(p => { p.nodes[3].components[0].data.primitive = "gltf"; }, "INVALID_GEOMETRY", base + "/components/0/data/primitive", "blue-box");
  reject(p => { p.nodes[4].components[0].data.radius = Number.MIN_VALUE; }, "INVALID_GEOMETRY", "/project/nodes/4/components/0/data/radius", "amber-sphere");
});

test("static 3D rejects unsupported materials, extra fields and engine-specific components", () => {
  const base = "/project/nodes/3/components";
  reject(p => { p.nodes[3].components[1].data.model = "physical"; }, "INVALID_MATERIAL", base + "/1/data/model", "blue-box");
  reject(p => { p.nodes[3].components[1].data.color = "#0055aaff"; }, "INVALID_MATERIAL", base + "/1/data/color", "blue-box");
  reject(p => { p.nodes[3].components[1].data["texture/source"] = "external"; }, "UNSUPPORTED_FIELD", base + "/1/data/texture~1source", "blue-box");
  reject(p => { p.nodes[3].components[0].engine = "three.js"; }, "INVALID_COMPONENT", base + "/0/engine", "blue-box");
  reject(p => { p.nodes[3].components.push(structuredClone(p.nodes[3].components[0])); }, "INVALID_COMPONENT", base + "/2/kind", "blue-box");
  reject(p => { p.nodes[3].components.pop(); }, "INVALID_COMPONENT", base, "blue-box");
});

test("static 3D requires exactly one usable perspective camera", () => {
  reject(p => { p.nodes.shift(); p.scenes[0].rootNodeIds.shift(); }, "INVALID_CAMERA", "/project/scenes/0/rootNodeIds");
  reject(p => { p.nodes.push({ ...structuredClone(p.nodes[0]), id: "spare-camera" }); p.scenes[0].rootNodeIds.push("spare-camera"); },
    "INVALID_CAMERA", "/project/nodes/5", "spare-camera");
  const at = "/project/nodes/0/components/0/data";
  reject(p => { p.nodes[0].components[0].data.projection = "orthographic"; }, "INVALID_CAMERA", at + "/projection", "view-camera");
  for (const fovYDegrees of [0, 180, 1e-42])
    reject(p => { p.nodes[0].components[0].data.fovYDegrees = fovYDegrees; }, "INVALID_CAMERA", at + "/fovYDegrees", "view-camera");
  reject(p => { p.nodes[0].components[0].data.near = 0; }, "INVALID_CAMERA", at + "/near", "view-camera");
  reject(p => { p.nodes[0].components[0].data.far = 0.1; }, "INVALID_CAMERA", at + "/far", "view-camera");
  reject(p => { p.nodes[0].transform.scale[0] = 2; }, "INVALID_TRANSFORM", "/project/nodes/0/transform/scale", "view-camera");
});

test("static 3D validates the supported light types and explicit directional aim", () => {
  reject(p => { p.nodes[1].components[0].data.type = "spot"; }, "INVALID_LIGHT", "/project/nodes/1/components/0/data/type", "fill-light");
  reject(p => { p.nodes[1].components[0].data.intensity = -0.1; }, "INVALID_LIGHT", "/project/nodes/1/components/0/data/intensity", "fill-light");
  reject(p => { p.nodes[1].transform.position[1] = 3; }, "INVALID_TRANSFORM", "/project/nodes/1/transform/position", "fill-light");
  reject(p => { p.nodes[2].components[0].data.target = [-4, 5, 6]; }, "INVALID_LIGHT", "/project/nodes/2/components/0/data/target", "key-light");
  reject(p => { p.nodes[2].transform.rotation[1] = 15; }, "INVALID_TRANSFORM", "/project/nodes/2/transform/rotation", "key-light");
});
