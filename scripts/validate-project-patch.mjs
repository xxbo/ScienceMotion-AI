import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const [schemaText, projectSchemaText] = await Promise.all([
  readFile("schemas/project-patch.schema.json", "utf8"),
  readFile("schemas/project.schema.json", "utf8"),
]);
const schema = JSON.parse(schemaText);
const projectSchema = JSON.parse(projectSchemaText);
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(projectSchema);
const validate = ajv.compile(schema);
const sample = {
  schemaVersion: "1.0.0",
  projectId: "project-cpu-cache",
  baseRevisionId: "revision-initial",
  patches: [{
    op: "add-node",
    sceneId: "scene-intro",
    node: {
      id: "node-validation-fixture",
      name: "Validation Fixture",
      type: "shape",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ kind: "geometry", data: { primitive: "rectangle" } }]
    }
  }]
};
if (!validate(sample)) {
  console.error("Project patch schema validation failed:");
  for (const error of validate.errors ?? []) console.error(`- ${error.instancePath || "/"}: ${error.message}`);
  process.exit(1);
}
console.log("Project patch schema validation passed.");
