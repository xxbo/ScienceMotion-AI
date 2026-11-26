import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProjectAnimationTrack, ProjectDocument } from "../contracts/project";
import { prepareThreeCameraScene, prepareThreeStaticScene, ThreeStaticSceneError } from "../renderers/three/three-static-scene";
import { hashProject } from "./project-snapshots";

const fixture = () => JSON.parse(readFileSync("examples/three-static-scene.json", "utf8")) as ProjectDocument;
const request = (project: ProjectDocument) => ({ project, revisionId: project.revisions.at(-1)!.id, snapshotHash: hashProject(project), startFrame: 6, durationFrames: 42 });
const track = (values: Partial<ProjectAnimationTrack> = {}): ProjectAnimationTrack => ({ id: "camera-position", targetNodeId: "view-camera",
  targetProperty: "transform.position", keyframes: [{ frame: 10, value: [2, 2.3, 8] }, { frame: 20, value: [4, 2.3, 8] }], ...values });

test("unkeyed and disabled-track scenes keep the exact original static projection", () => {
  const project = fixture();
  project.animationTracks.push(track({ enabled: false, targetNodeId: "blue-box" }));
  const input = request(project);
  const { model, cameraAt } = prepareThreeCameraScene(input);
  assert.deepEqual(model, prepareThreeStaticScene(input));
  assert.equal(cameraAt, undefined);
});

test("camera pose channels sample scene-local frames and accept the terminal boundary key", () => {
  const project = fixture();
  project.animationTracks.push(track(), track({ id: "camera-rotation", targetProperty: "transform.rotation",
    keyframes: [{ frame: 24, value: [-14, 10, 0] }, { frame: 48, value: [-14, 34, 24] }] }));
  const original = structuredClone(project);
  const { model, cameraAt } = prepareThreeCameraScene(request(project));
  assert.ok(cameraAt);
  const rad = (degrees: number) => degrees * Math.PI / 180;
  assert.deepEqual(model.range, { startFrame: 6, durationFrames: 42 });
  assert.deepEqual(model.camera.position, [0, 2.3, 8]);
  assert.deepEqual(cameraAt(6), { position: [2, 2.3, 8], rotationRadians: [rad(-14), rad(10), 0] });
  assert.deepEqual(cameraAt(15).position, [3, 2.3, 8]);
  assert.deepEqual(cameraAt(36), { position: [4, 2.3, 8], rotationRadians: [rad(-14), rad(22), rad(12)] });
  const edits = cameraAt(6); edits.position[0] = 99; edits.rotationRadians[1] = 0;
  assert.equal(cameraAt(6).position[0], 2);
  assert.equal(cameraAt(6).rotationRadians[1], rad(10));
  assert.deepEqual(project, original);
  assert.throws(() => cameraAt(48), { code: "THREE_STATIC_INVALID_REQUEST" });
});

test("camera-only sampling preserves the unauthored channel and canonical step, easing and loop semantics", () => {
  const project = fixture();
  project.animationTracks.push(track({ loop: true, keyframes: [{ frame: 2, value: [0, 2.3, 8] },
    { frame: 12, value: [2, 2.3, 8], interpolation: "step" }, { frame: 22, value: [4, 2.3, 8], interpolation: "bezier", easing: "ease-in" }] }));
  const { model, cameraAt } = prepareThreeCameraScene(request(project));
  assert.ok(cameraAt);
  assert.deepEqual(cameraAt(11).position, [0, 2.3, 8]);
  assert.deepEqual(cameraAt(12).position, [2, 2.3, 8]);
  assert.ok(cameraAt(17).position[0] > 2.5 && cameraAt(17).position[0] < 2.8);
  assert.deepEqual(cameraAt(22).position, cameraAt(2).position);
  assert.deepEqual(cameraAt(32).position, cameraAt(12).position);
  assert.deepEqual(cameraAt(17).rotationRadians, model.camera.rotationRadians);
});

test("camera rotation interpolates authored XYZ degrees without imposing an angle wrap", () => {
  const project = fixture();
  project.animationTracks.push(track({ targetProperty: "transform.rotation", keyframes: [{ frame: 0, value: [-14, 350, 0] }, { frame: 20, value: [-14, 370, 0] }] }));
  const { cameraAt } = prepareThreeCameraScene(request(project));
  assert.ok(cameraAt);
  assert.equal(cameraAt(10).rotationRadians[1], 2 * Math.PI);
  assert.deepEqual(cameraAt(47).position, [0, 2.3, 8]);
});

test("invalid camera keys and unapproved channels report the precise track and field", () => {
  for (const [tracks, code, field] of [
    [[track({ targetProperty: "camera.fovYDegrees" })], "UNSUPPORTED_ANIMATION", "/0"],
    [[track({ targetNodeId: "blue-box" })], "UNSUPPORTED_ANIMATION", "/0"],
    [[track({ keyframes: [{ frame: 0, value: [0, 1] }] })], "INVALID_ANIMATION", "/0/keyframes/0/value"],
    [[track({ keyframes: [{ frame: 0, value: [0, 0, 1e45] }] })], "INVALID_ANIMATION", "/0/keyframes/0/value"],
    [[track({ keyframes: [{ frame: 49, value: [1, 2, 8] }] })], "INVALID_ANIMATION", "/0/keyframes/0/frame"],
    [[track({ keyframes: [{ frame: 0, value: [0, 0, 8], interpolation: "hermite" }] })], "INVALID_ANIMATION", "/0"],
    [[track(), track({ id: "duplicate" })], "INVALID_ANIMATION", "/1/targetProperty"],
  ] as const) {
    const project = fixture();
    project.animationTracks = [...tracks];
    assert.throws(() => prepareThreeCameraScene(request(project)), error => {
      assert.ok(error instanceof ThreeStaticSceneError);
      assert.equal(error.code, `THREE_STATIC_${code}`);
      assert.equal(error.diagnostic.path, `/project/animationTracks${field}`);
      assert.equal(error.diagnostic.trackId, tracks.at(-1)!.id);
      assert.equal(error.diagnostic.nodeId, tracks.at(-1)!.targetNodeId);
      assert.equal(error.diagnostic.sceneId, "scene-study");
      return true;
    });
  }
});
