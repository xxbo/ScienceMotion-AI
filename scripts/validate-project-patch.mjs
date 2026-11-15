import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const [schemaText, projectSchemaText] = await Promise.all([
  readFile("schemas/project-patch.schema.json", "utf8"), readFile("schemas/project.schema.json", "utf8"),
]);
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(projectSchemaText));
const validate = ajv.compile(JSON.parse(schemaText));
const base = { schemaVersion: "1.1.0", projectId: "project-cpu-cache", baseRevisionId: "revision-initial" };
const node = { op: "add-node", sceneId: "scene-intro", node: { id: "node-validation-fixture", name: "Validation Fixture", type: "shape",
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ kind: "geometry", data: { primitive: "rectangle" } }] } };
const asset = { id: "asset-test", kind: "image", uri: "artifact://sha256/" + "a".repeat(64), contentHash: "a".repeat(64) };
const assetOps = [{ op: "add-asset", asset }, { op: "replace-asset", assetId: asset.id, asset }, { op: "remove-asset", assetId: asset.id }];
for (const version of ["1.1.0", "1.2.0"]) {
  if (!validate({ ...base, schemaVersion: version, patches: [node] })) throw new Error(JSON.stringify(validate.errors));
}
for (const operation of assetOps) {
  if (!validate({ ...base, schemaVersion: "1.2.0", patches: [operation] })) throw new Error(JSON.stringify(validate.errors));
  if (validate({ ...base, patches: [operation] })) throw new Error("Legacy Patch protocol accepted an asset edit");
}
for (const invalid of [
  { ...base, schemaVersion: "9.0.0", patches: [node] },
  { ...base, schemaVersion: "1.2.0", patches: [{ op: "remove-asset", assetId: "a", cascade: true }] },
  { ...base, schemaVersion: "1.2.0", patches: [{ op: "add-asset", asset: { id: "a", uri: "x" } }] },
]) if (validate(invalid)) throw new Error("Invalid project patch unexpectedly accepted");
console.log("Project Patch 1.1.0/1.2.0 compatibility and asset operation schemas passed.");
