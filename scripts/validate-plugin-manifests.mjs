import Ajv from "ajv";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const schema = JSON.parse(await readFile("schemas/plugin-manifest.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const files = (await readdir("tools/plugins")).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("No plugin manifests found.");
  process.exit(1);
}
const ids = new Set();
let failed = false;
for (const file of files) {
  const path = join("tools/plugins", file);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (!validate(manifest)) {
    failed = true;
    console.error(`Invalid plugin manifest: ${path}`);
    for (const error of validate.errors ?? []) console.error(`- ${error.instancePath || "/"}: ${error.message}`);
    continue;
  }
  if (ids.has(manifest.id)) {
    failed = true;
    console.error(`Duplicate plugin ID: ${manifest.id}`);
  }
  ids.add(manifest.id);
}
if (failed) process.exit(1);
console.log(`Validated ${files.length} plugin manifest(s).`);
