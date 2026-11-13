import Ajv from "ajv";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const schema = JSON.parse(await readFile("schemas/plugin-manifest.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const files = (await readdir("tools/plugins")).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) throw new Error("No plugin manifests found.");
const keys = new Set();
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
  const key = `${manifest.id}@${manifest.version}`;
  if (keys.has(key)) { failed = true; console.error(`Duplicate plugin version: ${key}`); }
  keys.add(key);
  const dependencies = (manifest.dependencies ?? []).map((item) => item.pluginId);
  if (new Set(dependencies).size !== dependencies.length) {
    failed = true; console.error(`Duplicate dependency in ${key}`);
  }
  const versions = [manifest.version, ...(manifest.projectSchemaVersions ?? []),
    ...(manifest.dependencies ?? []).map((d) => d.versionRange).filter((r) => r && r !== "*").map((r) => r.replace(/^[~^]/, ""))];
  if (versions.some((v) => v.split(".").some((part) => !Number.isSafeInteger(Number(part))))) {
    failed = true; console.error(`Unsafe version component in ${key}`);
  }
}
if (failed) process.exit(1);
console.log(`Validated ${files.length} plugin manifest(s).`);
