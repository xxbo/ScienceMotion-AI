import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import projectSchema from "../schemas/project.schema.json";
import type { ProjectDocument } from "../src/contracts/project";
import { assertCreativeDocument } from "../src/platform/project-creative-edits";
import { hashProject, InMemorySnapshotStore } from "../src/platform/project-snapshots";
import { prepareThreeStaticScene, ThreeStaticSceneError, type ThreeStaticDiagnostic, type ThreeStaticRequest } from "../src/renderers/three/three-static-scene";

const fixture = "examples/three-static-scene.json";
const output = resolve("out/three-static-contract");
await mkdir(output, { recursive: true });
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const referenceHash = "c6ac973ff3672a2e3db19d9d82c68859eeef2bfbec4eaff8e7343611e3c2b5b8";
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", fixture, renderedFrames: 0 };

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const decoded: unknown = JSON.parse(await readFile(fixture, "utf8"));
  const validate = new Ajv({ allErrors: true, strict: true }).compile<ProjectDocument>(projectSchema);
  assert.ok(validate(decoded), JSON.stringify(validate.errors));
  const project: ProjectDocument = decoded;
  assertCreativeDocument(project);
  assert.equal(hashProject(project), referenceHash);
  const snapshot = new InMemorySnapshotStore().save(project, { id: "three-static-v1", createdAt: project.project.updatedAt });
  assert.equal(snapshot.contentHash, referenceHash);
  const revisionId = project.revisions.at(-1)!.id, profile = { width: 640, height: 360, fps: 24 };
  const request = { project: snapshot.document, revisionId, snapshotHash: snapshot.contentHash, profile, sceneId: "scene-study" };
  evidence.reference = { id: snapshot.id, revisionId, contentHash: snapshot.contentHash };
  await save("snapshot.json", snapshot);

  const preview = prepareThreeStaticScene({ ...request, frame: 24 });
  const range = prepareThreeStaticScene({ ...request, startFrame: 0, durationFrames: 48 });
  assert.deepEqual(range, { ...preview, range: { startFrame: 0, durationFrames: 48 } });
  assert.deepEqual(preview.range, { startFrame: 24, durationFrames: 1 });
  assert.deepEqual(range.profile, profile);
  assert.deepEqual(range.meshes.map(({ nodeId, geometry }) => [nodeId, geometry.primitive]), [["blue-box", "box"], ["amber-sphere", "sphere"]]);
  assert.deepEqual([range.camera.nodeId, range.camera.projection, range.lights.length], ["view-camera", "perspective", 2]);
  await save("static-scene.json", range);

  function change(edit: (draft: ProjectDocument) => void): ThreeStaticRequest {
    const draft = structuredClone(project);
    edit(draft);
    assert.ok(validate(draft), JSON.stringify(validate.errors));
    assertCreativeDocument(draft);
    return { ...request, project: draft, snapshotHash: hashProject(draft), frame: 24 };
  }
  const faults: Array<{ name: string; input: ThreeStaticRequest; code: ThreeStaticDiagnostic["code"]; path: string; nodeId?: string }> = [
    { name: "2d-coordinate-convention", input: change(p => { p.project.coordinateSystem = "screen-y-down"; }),
      code: "THREE_STATIC_UNSUPPORTED_PROJECT", path: "/project/project/coordinateSystem" },
    { name: "extra-camera", input: change(p => { p.nodes.push({ ...structuredClone(p.nodes[0]), id: "spare-camera" }); p.scenes[0].rootNodeIds.push("spare-camera"); }),
      code: "THREE_STATIC_INVALID_CAMERA", path: "/project/nodes/5", nodeId: "spare-camera" },
    { name: "invalid-camera-clip", input: change(p => { p.nodes[0].components[0].data.far = 0.05; }),
      code: "THREE_STATIC_INVALID_CAMERA", path: "/project/nodes/0/components/0/data/far", nodeId: "view-camera" },
    { name: "external-mesh-primitive", input: change(p => { p.nodes[3].components[0].data.primitive = "gltf"; }),
      code: "THREE_STATIC_INVALID_GEOMETRY", path: "/project/nodes/3/components/0/data/primitive", nodeId: "blue-box" },
    { name: "texture-field", input: change(p => { p.nodes[4].components[1].data.map = "texture.png"; }),
      code: "THREE_STATIC_UNSUPPORTED_FIELD", path: "/project/nodes/4/components/1/data/map", nodeId: "amber-sphere" },
    { name: "enabled-camera-track", input: change(p => { p.animationTracks.push({ id: "camera-track", targetNodeId: "view-camera",
      targetProperty: "transform.position", keyframes: [{ frame: 0, value: [0, 2.3, 8] }, { frame: 47, value: [0, 2.3, 6] }] }); }),
      code: "THREE_STATIC_UNSUPPORTED_ANIMATION", path: "/project/animationTracks/0", nodeId: "view-camera" },
    { name: "frame-after-shot", input: { ...request, frame: 48 }, code: "THREE_STATIC_INVALID_REQUEST", path: "/frame" },
    { name: "stale-snapshot-identity", input: { ...request, snapshotHash: "0".repeat(64), frame: 24 }, code: "THREE_STATIC_INVALID_SNAPSHOT", path: "/snapshotHash" },
  ];
  const diagnostics: Array<{ name: string; diagnostic: ThreeStaticDiagnostic }> = [];
  for (const { name, input, code, path, nodeId } of faults) {
    assert.throws(() => prepareThreeStaticScene(input), error => {
      assert.ok(error instanceof ThreeStaticSceneError);
      assert.equal(error.code, code);
      assert.equal(error.diagnostic.path, path);
      assert.equal(error.diagnostic.nodeId, nodeId);
      if (name === "enabled-camera-track") assert.equal(error.diagnostic.trackId, "camera-track");
      diagnostics.push({ name, diagnostic: error.diagnostic });
      return true;
    });
  }
  assert.deepEqual(snapshot.document, project);
  assert.equal(hashProject(snapshot.document), referenceHash);
  await save("diagnostics.json", diagnostics);
  evidence.selection = { profile, previewFrame: 24, range: range.range, sceneId: range.sceneId, cameraNodeId: range.camera.nodeId };
  evidence.rejectedRequests = diagnostics.length;
  evidence.status = "passed";
  console.log(`Verified ${snapshot.id}: shared ProjectDocument, matching static preview and range inputs, and ${diagnostics.length} scoped rejections. No frames were rendered.`);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally { await save("evidence.json", evidence); }
