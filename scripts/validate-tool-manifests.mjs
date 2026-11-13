import Ajv from "ajv";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const schema = JSON.parse(await readFile("schemas/tool-manifest.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const namespacePattern = new RegExp(schema.properties.namespace.pattern);
const projectVersionPattern = new RegExp(schema.properties.projectSchemaVersions.items.pattern);
for (const namespace of ["geometry", "graphics.2d", "engine.3d", "audio.sfx", "simulation.physics"]) {
  if (!namespacePattern.test(namespace)) throw new Error(`Tool namespace schema rejects valid namespace: ${namespace}`);
}
for (const version of ["1.0.0", "1.1.0", "12.34.56"]) {
  if (!projectVersionPattern.test(version)) throw new Error(`Tool project schema version pattern rejects valid version: ${version}`);
}
const directory = "tools/manifests";
const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("No tool manifests found.");
  process.exit(1);
}
const ids = new Set();
let failed = false;
for (const file of files) {
  const path = join(directory, file);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (!validate(manifest)) {
    failed = true;
    console.error(`Invalid tool manifest: ${path}`);
    for (const error of validate.errors ?? []) console.error(`- ${error.instancePath || "/"}: ${error.message}`);
    continue;
  }
  const key = `${manifest.id}@${manifest.version}`;
  if (ids.has(key)) {
    failed = true;
    console.error(`Duplicate tool manifest: ${key}`);
  }
  ids.add(key);
}
if (failed) process.exit(1);
console.log(`Validated ${files.length} tool manifest(s).`);
