import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import Ajv from "ajv";
import type { AgentTool, AgentToolManifest, ToolSearchQuery } from "../src/contracts/agent-tool";
import { InMemoryAgentToolRegistry } from "../src/platform/tool-registry";
import { InMemoryPluginManager } from "../src/platform/plugin-manager";
import schema from "../schemas/tool-manifest.schema.json";

// 100 synthetic IDs × 3 versions. These registrations are catalogue probes, not creative tools.
const namespaces = ["synthetic.graphics", "synthetic.animation", "synthetic.geometry", "synthetic.media", "synthetic.inspect"];
const versions = ["1.9.0", "1.10.0", "2.0.0"];
const manifests: AgentToolManifest[] = Array.from({ length: 100 }, (_, index) => versions.map(version => {
  const namespace = namespaces[Math.floor(index / 20)];
  return { id: `${namespace}.tool${String(index).padStart(3, "0")}`, version, namespace,
    name: `Synthetic entry ${index}`, description: "Catalogue scale fixture; no creative implementation", category: namespace.split(".")[1],
    tags: [index % 2 ? "odd" : "even", "catalogue-only"], capabilities: [index % 2 ? "geometry.3d" : "graphics.2d"],
    engines: [index % 2 ? "blender" : "remotion"], projectSchemaVersions: [index % 4 === 0 ? "9.0.0" : "1.1.0"],
    lifecycle: index % 5 === 0 ? "deprecated" as const : "beta" as const,
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    execution: { deterministic: true, stateful: false, destructive: false, cost: "low" as const },
  };
})).flat();
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
for (const manifest of manifests) assert.ok(validate(manifest), JSON.stringify(validate.errors));
let executions = 0;
const probes: AgentTool[] = manifests.map(manifest => ({ manifest, execute: async () => {
  executions++; throw new Error("Synthetic catalogue entries must never be executed");
} }));
const registry = new InMemoryAgentToolRegistry();
const timings: Record<string, number> = {};
async function timed<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  const started = performance.now(); const result = await work(); timings[name] = performance.now() - started; return result;
}
const key = (m: AgentToolManifest) => `${m.id}@${m.version}`;
await timed("register300Ms", () => { for (const probe of probes) registry.register(probe); });
const pages: AgentToolManifest[] = [];
await timed("pageAll300Ms", async () => {
  for (let offset = 0; offset < 300; offset += 37) {
    const result = await registry.discover({ includeDeprecated: true, limit: 37, offset });
    assert.equal(result.total, 300); assert.equal(result.offset, offset); assert.equal(result.limit, 37);
    assert.equal(result.tools.length, Math.min(37, 300 - offset)); pages.push(...result.tools);
  }
  assert.equal(new Set(pages.map(key)).size, 300);
  assert.deepEqual(new Set(pages.map(key)), new Set(manifests.map(key)));
  assert.equal((await registry.discover({ includeDeprecated: true, offset: 300 })).tools.length, 0);
  assert.equal((await registry.discover({ includeDeprecated: true, limit: 999 })).tools.length, 200);
});
const cases: Array<{ name: string; query: ToolSearchQuery; expected: number }> = [
  { name: "default excludes 60 deprecated entries", query: {}, expected: 240 },
  { name: "compatible schema includes deprecated", query: { projectSchemaVersion: "1.1.0", includeDeprecated: true }, expected: 225 },
  { name: "compatible and current", query: { projectSchemaVersion: "1.1.0" }, expected: 180 },
  { name: "one namespace", query: { namespaces: [namespaces[0]], includeDeprecated: true }, expected: 60 },
  { name: "one category", query: { categories: ["animation"], includeDeprecated: true }, expected: 60 },
  { name: "tags", query: { tags: ["odd", "catalogue-only"], includeDeprecated: true }, expected: 150 },
  { name: "supported 2D engine/capability", query: { engines: ["remotion"], capabilities: ["graphics.2d"], includeDeprecated: true }, expected: 150 },
  { name: "incompatible engine/capability combination", query: { engines: ["remotion"], capabilities: ["geometry.3d"], includeDeprecated: true }, expected: 0 },
  { name: "unavailable capability", query: { capabilities: ["physics.cfd"], includeDeprecated: true }, expected: 0 },
  { name: "unknown project schema", query: { projectSchemaVersion: "8.0.0", includeDeprecated: true }, expected: 0 },
  { name: "text search across versions", query: { text: "TOOL099", includeDeprecated: true }, expected: 3 },
];
// Independent fixture-index expectations also verify which IDs were returned, not just totals.
const expectedIndexes = [
  (i: number) => i % 5 !== 0,
  (i: number) => i % 4 !== 0,
  (i: number) => i % 4 !== 0 && i % 5 !== 0,
  (i: number) => i < 20,
  (i: number) => i >= 20 && i < 40,
  (i: number) => i % 2 === 1,
  (i: number) => i % 2 === 0,
  () => false, () => false, () => false,
  (i: number) => i === 99,
];
const querySamples: number[] = [];
for (let iteration = 0; iteration < 5; iteration++) for (const [caseIndex, entry] of cases.entries()) {
  const expectedIds = new Set(Array.from({ length: 100 }, (_, i) => i).filter(expectedIndexes[caseIndex]).map(i => manifests[i * 3].id));
  assert.equal(expectedIds.size * 3, entry.expected);
  const start = performance.now(), result = await registry.discover(entry.query); querySamples.push(performance.now() - start);
  assert.equal(result.total, entry.expected, entry.name);
  assert.equal(result.tools.length, Math.min(50, entry.expected));
  assert.equal(new Set(result.tools.map(key)).size, result.tools.length);
  for (const tool of result.tools) assert.ok(expectedIds.has(tool.id), `${entry.name}: unexpected ${tool.id}`);
}
await timed("resolve400Ms", async () => {
  for (let index = 0; index < 100; index++) {
    const id = manifests[index * 3].id;
    assert.equal((await registry.get(id))!.version, "2.0.0");
    for (const version of versions) assert.equal((await registry.get(id, version))!.version, version);
  }
  assert.equal(await registry.get("synthetic.missing.tool"), undefined);
  assert.equal(await registry.get(manifests[0].id, "99.0.0"), undefined);
});
await timed("conflictsAndCompatibilityMs", async () => {
  assert.throws(() => registry.register(probes[0]), /already registered/);
  const manager = new InMemoryPluginManager(registry, { projectSchemaVersion: "1.1.0" });
  const candidate = (id: string, probe: AgentTool) => ({
    manifest: { id, version: "1.0.0", name: "Conflict probe", description: "Scale fixture", toolIds: [probe.manifest.id] }, tools: [probe],
  });
  assert.ok(manager.install(candidate("scale.incompatible", probes[0])).ok);
  assert.equal((await manager.activate("scale.incompatible", "1.0.0")).diagnostics[0].code, "PLUGIN_SCHEMA_INCOMPATIBLE");
  assert.ok(manager.install(candidate("scale.conflict", probes[3])).ok);
  assert.equal((await manager.activate("scale.conflict", "1.0.0")).diagnostics[0].code, "PLUGIN_ENABLE_FAILED");
  assert.equal(registry.getImplementation(probes[3].manifest.id, probes[3].manifest.version), probes[3]);
  assert.equal((await registry.discover({ includeDeprecated: true })).total, 300);
  assert.ok(registry.unregister(manifests[0].id, "2.0.0"));
  assert.equal((await registry.get(manifests[0].id))!.version, "1.10.0", "Numeric semver order must beat lexical order");
  registry.register(probes[2]); assert.equal((await registry.discover({ includeDeprecated: true })).total, 300);
});
assert.equal(executions, 0);
querySamples.sort((a, b) => a - b);
await mkdir("out", { recursive: true });
await writeFile("out/catalogue-scale-evidence.json", JSON.stringify({ sourceCommit: process.env.GITHUB_SHA ?? null,
  environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  inventory: { syntheticManifests: 300, uniqueSyntheticToolIds: 100, namespaces: 5, versionsPerId: 3,
    syntheticExecutions: executions, productionCreativeToolsAdded: 0 },
  cases, timings, queryTiming: { count: querySamples.length, p50Ms: querySamples[Math.floor(querySamples.length * 0.5)],
    p95Ms: querySamples[Math.floor(querySamples.length * 0.95)], maxMs: querySamples.at(-1) },
  pages: { pageSize: 37, pages: Math.ceil(300 / 37), duplicates: 0, omissions: 0 },
  limitations: ["Local in-memory registry; timing observations are not performance guarantees", "Capability/engine filters describe discovery; they do not execute unsupported engines", "Synthetic manifests are not implemented creative tools"],
}, null, 2) + "\n");
console.log("PASS 300 synthetic manifests: pagination/filtering/resolution, duplicate/conflict/schema guards, zero synthetic executions");
