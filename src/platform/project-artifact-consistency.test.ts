import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectAsset, ProjectDocument } from "../contracts/project";
import type { ProjectPatchDocument } from "../contracts/project-patch";
import { InMemoryArtifactStore, FileSystemArtifactStore } from "./artifact-store";
import { InMemoryArtifactReferenceStore, FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { FileSystemProjectWorkspace } from "./filesystem-project-workspace";
import { artifactIdForAsset, assertAssetRemovable } from "./project-assets";
import { applyProjectPatch } from "./project-patches";
import { hashProject } from "./project-snapshots";

const time = "2026-11-15T00:00:00.000Z";
const meta = (id: string) => ({ newRevisionId: id, createdAt: time, message: id });
function project(id = "p"): ProjectDocument {
  return { schemaVersion: "1.1.0", project: { id, name: id, createdAt: time, updatedAt: time, units: "unitless", coordinateSystem: "screen-y-down", timebase: { fps: 30, ticksPerFrame: 1 }, colorSpace: "srgb" },
    editorial: { episodeId: "ep" }, sequences: [{ id: "seq", name: "Sequence", durationFrames: 60, fps: 30, width: 1920, height: 1080, shotIds: ["shot"] }],
    scenes: [{ id: "scene", name: "Scene", durationFrames: 60, rootNodeIds: ["node"] }],
    shots: [{ id: "shot", name: "Shot", sceneId: "scene", startFrame: 0, durationFrames: 60 }],
    nodes: [{ id: "node", name: "Shape", type: "shape", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] }],
    animationTracks: [], assets: [], dependencies: [], prefabs: [], constraints: [], revisions: [{ id: "r0", createdAt: time, message: "initial" }] };
}
function patch(p: ProjectDocument, operations: ProjectPatchDocument["patches"]): ProjectPatchDocument {
  return { schemaVersion: "1.2.0", projectId: p.project.id, baseRevisionId: p.revisions.at(-1)!.id, patches: operations };
}
async function blob(store: InMemoryArtifactStore | FileSystemArtifactStore, text = "a", id = "asset"): Promise<ProjectAsset> {
  const record = await store.put({ bytes: new TextEncoder().encode(text), kind: "image", mediaType: "image/png" });
  return { id, kind: "image", uri: record.uri, contentHash: record.contentHash };
}
const gc = { olderThanMs: 0, now: new Date("2100-01-01T00:00:00Z") };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sciencemotion-project-artifacts-"));
  const artifacts = new FileSystemArtifactStore(join(root, "artifacts"));
  const refs = new FileSystemArtifactReferenceStore(join(root, "refs"));
  const lifecycle = new LocalArtifactLifecycleManager(artifacts, refs);
  const path = join(root, "workspace");
  const workspace = await FileSystemProjectWorkspace.open(path, lifecycle);
  return { root, path, artifacts, refs, lifecycle, workspace };
}

test("asset Patch 1.2 adds/replaces/removes assets with revisions; 1.1 rejects new operations", async () => {
  const store = new InMemoryArtifactStore(); const a = await blob(store); const b = await blob(store, "b");
  const source = project(); const before = hashProject(source);
  const addition = patch(source, [{ op: "add-asset", asset: a }]);
  assert.throws(() => applyProjectPatch(source, { ...addition, schemaVersion: "1.1.0" }, { ...meta("r1"), currentRevisionId: "r0" }), /require Patch Schema 1.2.0/);
  let result = applyProjectPatch(source, addition, { ...meta("r1"), currentRevisionId: "r0" });
  assert.deepEqual(result.changedAssetIds, ["asset"]); assert.equal(hashProject(source), before);
  result = applyProjectPatch(result.project, patch(result.project, [{ op: "replace-asset", assetId: "asset", asset: b }]), { ...meta("r2"), currentRevisionId: "r1" });
  assert.equal(result.project.assets[0].contentHash, b.contentHash);
  result = applyProjectPatch(result.project, patch(result.project, [{ op: "remove-asset", assetId: "asset" }]), { ...meta("r3"), currentRevisionId: "r2" });
  assert.equal(result.project.assets.length, 0); assert.equal(result.project.schemaVersion, "1.1.0");
});

test("in-use clip/dependency/component assets are rejected without partial mutation", () => {
  for (const kind of ["clip", "dependency", "component", "assetIds"]) {
    const p = project(); p.assets.push({ id: "a", kind: "image", uri: "external.png" });
    if (kind === "clip") p.clips = [{ id: "clip", assetId: "a", startFrame: 0, durationFrames: 1 }];
    if (kind === "dependency") p.dependencies.push({ id: "dep", fromType: "node", fromId: "node", toType: "asset", toId: "a", relation: "uses" });
    if (kind === "component") p.nodes[0].components.push({ kind: "image", data: { nested: { assetId: "a" } } });
    if (kind === "assetIds") p.nodes[0].components.push({ kind: "custom", data: { assetIds: ["a"] } });
    const before = hashProject(p);
    assert.throws(() => applyProjectPatch(p, patch(p, [{ op: "update-node", nodeId: "node", changes: { name: "partial" } }, { op: "remove-asset", assetId: "a" }]), { ...meta("r1"), currentRevisionId: "r0" }), /Asset is in use/);
    assert.equal(hashProject(p), before);
  }
});

test("asset patch refuses identity changes and dangling references introduced later in a batch", () => {
  const p = project(); p.assets.push({ id: "a", kind: "image", uri: "external.png" });
  assert.throws(() => applyProjectPatch(p, patch(p, [{ op: "replace-asset", assetId: "a", asset: { ...p.assets[0], id: "b" } }]), { ...meta("r1"), currentRevisionId: "r0" }), /immutable/);
  assert.throws(() => applyProjectPatch(p, patch(p, [{ op: "remove-asset", assetId: "a" }, { op: "update-node", nodeId: "node", changes: { components: [{ kind: "image", data: { assetId: "a" } }] } }]), { ...meta("r1"), currentRevisionId: "r0" }), /Dangling/);
});

test("external hashed assets stay external; artifact URI/hash disagreements are rejected", () => {
  assert.equal(artifactIdForAsset({ id: "external", uri: "https://example.invalid/picture.png", contentHash: "a".repeat(64) }), undefined);
  assert.equal(artifactIdForAsset({ id: "local", uri: "artifact://sha256/" + "a".repeat(64) }), "sha256:" + "a".repeat(64));
  assert.throws(() => artifactIdForAsset({ id: "bad", uri: "artifact://sha256/" + "a".repeat(64), contentHash: "b".repeat(64) }), /conflict/);
  assert.throws(() => artifactIdForAsset({ id: "bad", uri: "artifact://elsewhere/file" }), /Invalid artifact URI/);
});

test("reconciliation repairs changed content under one asset ID and preserves other owners", async () => {
  const artifacts = new InMemoryArtifactStore(); const refs = new InMemoryArtifactReferenceStore(); const life = new LocalArtifactLifecycleManager(artifacts, refs);
  const a = await blob(artifacts); const b = await blob(artifacts, "b"); const p = project(); p.assets = [a];
  await life.reconcileProjectReferences(p); await life.attach({ artifactId: artifactIdForAsset(a)!, ownerType: "project", ownerId: "other", role: "asset:shared" });
  p.assets = [b]; const result = await life.reconcileProjectReferences(p);
  assert.deepEqual(result.attached, ["asset"]); assert.deepEqual(result.detached, ["asset"]);
  assert.equal((await life.references(artifactIdForAsset(a)!)).length, 1);
  assert.equal((await refs.list({ ownerId: "p" }))[0].artifactId, artifactIdForAsset(b));
});

test("missing bytes or URI/hash conflicts preserve old references conservatively", async () => {
  const artifacts = new InMemoryArtifactStore(); const refs = new InMemoryArtifactReferenceStore(); const life = new LocalArtifactLifecycleManager(artifacts, refs);
  const a = await blob(artifacts); const p = project(); p.assets = [a]; await life.reconcileProjectReferences(p);
  const before = await refs.list(); const missing = { ...a, uri: "artifact://sha256/" + "a".repeat(64), contentHash: "a".repeat(64) };
  p.assets = [missing]; assert.deepEqual((await life.reconcileProjectReferences(p)).missingArtifacts, ["asset"]);
  assert.deepEqual(await refs.list(), before);
  p.assets = [{ ...missing, contentHash: "b".repeat(64) }]; await assert.rejects(() => life.reconcileProjectReferences(p), /conflict/);
  assert.deepEqual(await refs.list(), before);
});

test("legacy unlink checks consumers and works for URI-only local assets", async () => {
  const artifacts = new InMemoryArtifactStore(); const refs = new InMemoryArtifactReferenceStore(); const life = new LocalArtifactLifecycleManager(artifacts, refs);
  const a = await blob(artifacts); delete a.contentHash;
  const p = project(); p.assets = [a]; await life.reconcileProjectReferences(p);
  p.clips = [{ id: "clip", assetId: "asset", startFrame: 0, durationFrames: 1 }];
  await assert.rejects(() => life.detachProjectAsset(p, "asset"), /in use/); assert.equal(await refs.count(artifactIdForAsset(a)!), 1);
  p.clips = []; const next = await life.detachProjectAsset(p, "asset");
  assert.equal(next.assets.length, 0); assert.equal((await refs.list()).length, 0);
});

test("shared-store managers serialize attach with GC and respect the grace period", async () => {
  const artifacts = new InMemoryArtifactStore(); const refs = new InMemoryArtifactReferenceStore();
  const first = new LocalArtifactLifecycleManager(artifacts, refs); const second = new LocalArtifactLifecycleManager(artifacts, refs);
  const a = await blob(artifacts); const orphan = await blob(artifacts, "orphan");
  await Promise.all([first.attach({ artifactId: artifactIdForAsset(a)!, ownerType: "project", ownerId: "p", role: "asset:a" }), second.collectGarbage({ olderThanMs: 86_400_000 })]);
  assert.ok(await artifacts.get(artifactIdForAsset(a)!)); assert.ok(await artifacts.get(artifactIdForAsset(orphan)!));
  assert.deepEqual((await second.collectGarbage(gc)).deleted, [artifactIdForAsset(orphan)]);
  await assert.rejects(() => second.collectGarbage({ olderThanMs: NaN }), /Invalid/);
});

test("filesystem artifact and reference publication tolerates concurrent identical writes", async () => {
  const h = await setup();
  try {
    const assets = await Promise.all(Array.from({ length: 20 }, () => blob(h.artifacts)));
    assert.equal(new Set(assets.map((a) => a.uri)).size, 1);
    const references = await Promise.all(Array.from({ length: 20 }, () => h.lifecycle.attach({ artifactId: artifactIdForAsset(assets[0])!, ownerType: "project", ownerId: "p", role: "asset:a" })));
    assert.equal(new Set(references.map((r) => r.id)).size, 1); assert.equal(await h.refs.count(artifactIdForAsset(assets[0])!), 1);
    assert.equal((await readdir(join(h.root, "refs"))).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("workspace snapshot survives project asset removal, GC, restart and restore", async () => {
  const h = await setup(); let workspace = h.workspace;
  try {
    const p = project(); p.assets = [await blob(h.artifacts)]; const id = artifactIdForAsset(p.assets[0])!;
    await workspace.create(p); const saved = await workspace.saveSnapshot("p", "r0", { id: "snapshot", createdAt: time });
    await workspace.applyPatch("p", patch(p, [{ op: "remove-asset", assetId: "asset" }]), meta("r1"));
    assert.equal((await h.refs.list({ ownerType: "project", ownerId: "p" })).length, 0);
    assert.equal((await h.lifecycle.references(id))[0].ownerType, "snapshot");
    assert.deepEqual((await workspace.collectGarbage(gc)).deleted, []);
    await workspace.close(); workspace = await FileSystemProjectWorkspace.open(h.path, h.lifecycle);
    assert.equal((await workspace.getSnapshot("snapshot"))!.contentHash, saved.contentHash);
    const restored = await workspace.restoreSnapshot("snapshot", "r1", meta("r2"));
    assert.equal(restored.assets[0].uri, p.assets[0].uri); assert.equal(restored.revisions.at(-1)!.parentRevisionId, "r1");
    assert.equal(restored.revisions.length, 3); assert.ok(await h.artifacts.read(id));
    await workspace.releaseSnapshot("snapshot"); assert.deepEqual((await workspace.collectGarbage(gc)).deleted, []);
    await workspace.applyPatch("p", patch(restored, [{ op: "remove-asset", assetId: "asset" }]), meta("r3"));
    assert.deepEqual((await workspace.collectGarbage(gc)).deleted, [id]);
  } finally { await workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("two projects sharing an artifact retain independent references after one removes it", async () => {
  const h = await setup();
  try {
    const a = await blob(h.artifacts); const first = project("first"); first.assets = [a]; const second = project("second"); second.assets = [a];
    await h.workspace.create(first); await h.workspace.create(second);
    await h.workspace.applyPatch("first", patch(first, [{ op: "remove-asset", assetId: "asset" }]), meta("r1"));
    assert.equal(await h.refs.count(artifactIdForAsset(a)!), 1); assert.deepEqual((await h.workspace.collectGarbage(gc)).deleted, []);
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("workspace CAS admits only one competing patch and snapshots are immutable", async () => {
  const h = await setup();
  try {
    const p = project(); await h.workspace.create(p);
    const results = await Promise.allSettled(["r1", "r2"].map((id) => h.workspace.applyPatch("p", patch(p, [{ op: "update-node", nodeId: "node", changes: { name: id } }]), meta(id))));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const current = (await h.workspace.get("p"))!; assert.equal(current.revisions.length, 2);
    const snapshot = await h.workspace.saveSnapshot("p", current.revisions.at(-1)!.id, { id: "same", createdAt: time });
    await assert.rejects(() => h.workspace.saveSnapshot("p", current.revisions.at(-1)!.id, { id: "same", createdAt: time }), /already exists/);
    assert.equal((await h.workspace.getSnapshot("same"))!.contentHash, snapshot.contentHash);
    await assert.rejects(() => h.workspace.restoreSnapshot("same", "r0", meta("r3")), /Revision conflict/);
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

for (const afterPublication of [false, true]) {
  test(`workspace recovers ${afterPublication ? "new" : "old"} head after ${afterPublication ? "uncertain publication" : "failed publication"}`, async () => {
    const h = await setup(); let workspace = h.workspace;
    try {
      const p = project(); const a = await blob(h.artifacts); const b = await blob(h.artifacts, "b"); p.assets = [a]; await workspace.create(p);
      const internals = workspace as unknown as { writeState(state: unknown): Promise<void> };
      const write = internals.writeState.bind(workspace); let writes = 0;
      internals.writeState = async (state) => { writes++; if (writes === 2) { if (afterPublication) await write(state); throw new Error("injected publication failure"); } await write(state); };
      await assert.rejects(() => workspace.applyPatch("p", patch(p, [{ op: "replace-asset", assetId: "asset", asset: b }]), meta("r1")), /requires recovery/);
      await assert.rejects(() => workspace.collectGarbage(gc), /recovery required/);
      assert.ok(await h.artifacts.read(artifactIdForAsset(a)!)); assert.ok(await h.artifacts.read(artifactIdForAsset(b)!));
      await workspace.close(); workspace = await FileSystemProjectWorkspace.open(h.path, h.lifecycle);
      const expected = afterPublication ? b : a; const other = afterPublication ? a : b;
      assert.equal((await workspace.get("p"))!.assets[0].uri, expected.uri);
      assert.equal((await h.refs.list({ ownerType: "transaction" })).length, 0);
      assert.deepEqual((await workspace.collectGarbage(gc)).deleted, [artifactIdForAsset(other)]);
      assert.ok(await h.artifacts.read(artifactIdForAsset(expected)!));
    } finally { await workspace.close(); await rm(h.root, { recursive: true, force: true }); }
  });
}

test("reference cleanup failure retains transaction pins and is repaired on reopen", async () => {
  const h = await setup(); let workspace = h.workspace;
  try {
    const p = project(); p.assets = [await blob(h.artifacts)]; await workspace.create(p); const b = await blob(h.artifacts, "b");
    const reconcile = h.lifecycle.reconcileOwner.bind(h.lifecycle);
    h.lifecycle.reconcileOwner = async () => { throw new Error("injected cleanup failure"); };
    await assert.rejects(() => workspace.applyPatch("p", patch(p, [{ op: "replace-asset", assetId: "asset", asset: b }]), meta("r1")), /requires recovery/);
    assert.ok((await h.refs.list({ ownerType: "transaction" })).length > 0);
    h.lifecycle.reconcileOwner = reconcile;
    await workspace.close(); workspace = await FileSystemProjectWorkspace.open(h.path, h.lifecycle);
    assert.equal((await workspace.get("p"))!.revisions.at(-1)!.id, "r1");
    assert.equal((await h.refs.list({ ownerType: "transaction" })).length, 0);
    assert.equal((await h.refs.list({ ownerType: "project", ownerId: "p" }))[0].artifactId, artifactIdForAsset(b));
  } finally { await workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshot release failure keeps recoverable pins until authoritative state is inspected", async () => {
  const h = await setup(); let workspace = h.workspace;
  try {
    const p = project(); p.assets = [await blob(h.artifacts)]; await workspace.create(p);
    await workspace.saveSnapshot("p", "r0", { id: "s", createdAt: time });
    await workspace.applyPatch("p", patch(p, [{ op: "remove-asset", assetId: "asset" }]), meta("r1"));
    const release = h.lifecycle.releaseOwner.bind(h.lifecycle);
    h.lifecycle.releaseOwner = async (owner) => { if (owner.ownerType === "snapshot") throw new Error("cleanup interrupted"); await release(owner); };
    await assert.rejects(() => workspace.releaseSnapshot("s"), /requires recovery/);
    assert.equal((await h.refs.list({ ownerType: "snapshot" })).length, 1);
    h.lifecycle.releaseOwner = release;
    await workspace.close(); workspace = await FileSystemProjectWorkspace.open(h.path, h.lifecycle);
    assert.equal(await workspace.getSnapshot("s"), undefined);
    assert.deepEqual((await workspace.collectGarbage(gc)).deleted, [artifactIdForAsset(p.assets[0])]);
  } finally { await workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("missing or corrupt snapshot bytes refuse restore and recovery without dropping reference evidence", async () => {
  const h = await setup();
  try {
    const p = project(); p.assets = [await blob(h.artifacts)]; await h.workspace.create(p);
    await h.workspace.saveSnapshot("p", "r0", { id: "s", createdAt: time });
    const before = await h.refs.list(); const hash = p.assets[0].contentHash!;
    await writeFile(join(h.root, "artifacts", "blobs", hash.slice(0, 2), hash), "corrupted");
    await assert.rejects(() => h.workspace.restoreSnapshot("s", "r0", meta("r1")), /integrity/);
    assert.equal((await h.workspace.get("p"))!.revisions.at(-1)!.id, "r0");
    await h.workspace.close();
    await assert.rejects(() => FileSystemProjectWorkspace.open(h.path, h.lifecycle), /integrity/);
    assert.deepEqual(await h.refs.list(), before);
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("exclusive writer and ledger integrity prevent accidental concurrent hosts or silent resets", async () => {
  const h = await setup();
  try {
    await assert.rejects(() => FileSystemProjectWorkspace.open(h.path, h.lifecycle), /EEXIST/);
    await h.workspace.create(project()); await h.workspace.close();
    const path = join(h.path, "workspace.json"); const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.state.projects[0].project.name = "tampered"; await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(() => FileSystemProjectWorkspace.open(h.path, h.lifecycle), /integrity/);
    assert.ok((await readFile(path, "utf8")).includes("tampered"));
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshot read and restore retain isolation from caller mutations", async () => {
  const h = await setup();
  try {
    await h.workspace.create(project()); const saved = await h.workspace.saveSnapshot("p", "r0", { id: "s", createdAt: time });
    saved.document.nodes[0].name = "outside mutation";
    assert.equal((await h.workspace.getSnapshot("s"))!.document.nodes[0].name, "Shape");
    const current = (await h.workspace.get("p"))!; current.nodes[0].name = "outside mutation";
    assert.equal((await h.workspace.get("p"))!.nodes[0].name, "Shape");
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("independent workspaces do not clean each other's project or snapshot references", async () => {
  const h = await setup(); const second = await FileSystemProjectWorkspace.open(join(h.root, "workspace-two"), h.lifecycle);
  try {
    const p = project(); p.assets = [await blob(h.artifacts)];
    await h.workspace.create(p); await second.create(p);
    await h.workspace.saveSnapshot("p", "r0", { id: "same", createdAt: time });
    await second.saveSnapshot("p", "r0", { id: "same", createdAt: time });
    await h.workspace.applyPatch("p", patch(p, [{ op: "remove-asset", assetId: "asset" }]), meta("r1"));
    await h.workspace.releaseSnapshot("same");
    assert.equal((await h.refs.list({ ownerType: "snapshot" })).length, 1);
    assert.equal((await h.refs.list({ ownerType: "project", ownerId: "p" })).length, 1);
    assert.deepEqual((await h.workspace.collectGarbage(gc)).deleted, []);
    assert.equal((await second.getSnapshot("same"))!.document.assets[0].uri, p.assets[0].uri);
  } finally { await second.close(); await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("failed pre-publication pin leaves the previous head authoritative and recoverable", async () => {
  const h = await setup(); let workspace = h.workspace;
  try {
    const p = project(); p.assets = [await blob(h.artifacts)]; await workspace.create(p); const b = await blob(h.artifacts, "b");
    const attach = h.lifecycle.attach.bind(h.lifecycle);
    h.lifecycle.attach = async (input) => { if (input.ownerType === "transaction" && input.artifactId === artifactIdForAsset(b)) throw new Error("pin failed"); return attach(input); };
    await assert.rejects(() => workspace.applyPatch("p", patch(p, [{ op: "replace-asset", assetId: "asset", asset: b }]), meta("r1")), /requires recovery/);
    h.lifecycle.attach = attach;
    await workspace.close(); workspace = await FileSystemProjectWorkspace.open(h.path, h.lifecycle);
    assert.equal((await workspace.get("p"))!.revisions.at(-1)!.id, "r0");
    assert.equal((await h.refs.list({ ownerType: "transaction" })).length, 0);
    assert.ok(await h.artifacts.read(artifactIdForAsset(p.assets[0])!));
  } finally { await workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("a metadata record without its blob is not accepted as a valid project dependency", async () => {
  const h = await setup();
  try {
    const a = await blob(h.artifacts); const hash = a.contentHash!;
    await rm(join(h.root, "artifacts", "blobs", hash.slice(0, 2), hash));
    const p = project(); p.assets = [a];
    await assert.rejects(() => h.workspace.create(p), /Missing artifact bytes/);
    assert.equal(await h.workspace.get("p"), undefined); assert.equal((await h.refs.list()).length, 0);
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("corrupt reference evidence blocks garbage collection instead of guessing a zero count", async () => {
  const h = await setup();
  try {
    const a = await blob(h.artifacts);
    await writeFile(join(h.root, "refs", "invalid.json"), "{}").catch(async () => {
      const { mkdir } = await import("node:fs/promises"); await mkdir(join(h.root, "refs"), { recursive: true });
      await writeFile(join(h.root, "refs", "invalid.json"), "{}");
    });
    const result = await h.workspace.collectGarbage(gc);
    assert.equal(result.errors.length, 1); assert.equal(result.deleted.length, 0);
    assert.ok(await h.artifacts.read(artifactIdForAsset(a)!));
  } finally { await h.workspace.close(); await rm(h.root, { recursive: true, force: true }); }
});

test("legacy project-link conflict diagnostics remain compatible", async () => {
  const artifacts = new InMemoryArtifactStore(); const life = new LocalArtifactLifecycleManager(artifacts, new InMemoryArtifactReferenceStore());
  const a = await blob(artifacts); const p = project(); p.assets = [{ id: "asset", kind: "image", uri: "artifact://other", contentHash: "other" }];
  await assert.rejects(() => life.attachToProject(p, artifactIdForAsset(a)!, { assetId: "asset", kind: "image", role: "cover" }), /different content/);
});
