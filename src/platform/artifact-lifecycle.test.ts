import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixture from "../../projects/cpu-cache/project.json";
import type { ProjectDocument } from "../contracts/project";
import { InMemoryArtifactStore, FileSystemArtifactStore } from "./artifact-store";
import { FileSystemArtifactReferenceStore, InMemoryArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";

const bytes = new TextEncoder().encode("artifact-lifecycle-content");
const project = structuredClone(fixture) as unknown as ProjectDocument;

 test("references are idempotent and protect artifacts shared by multiple projects", async () => {
  const artifacts = new InMemoryArtifactStore();
  const refs = new InMemoryArtifactReferenceStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, refs);
  const artifact = await artifacts.put({ bytes, kind: "image", mediaType: "image/png" });
  const first = await manager.attach({ artifactId: artifact.id, ownerType: "project", ownerId: "project-a", role: "cover" });
  const duplicate = await manager.attach({ artifactId: artifact.id, ownerType: "project", ownerId: "project-a", role: "cover" });
  await manager.attach({ artifactId: artifact.id, ownerType: "project", ownerId: "project-b", role: "thumbnail" });
  assert.equal(first.id, duplicate.id);
  assert.equal(await refs.count(artifact.id), 2);
  await manager.detach(first.id);
  assert.equal(await refs.count(artifact.id), 1);
  assert.ok(await artifacts.get(artifact.id));
});

test("project linking adds canonical asset metadata and a durable reference", async () => {
  const artifacts = new InMemoryArtifactStore();
  const refs = new InMemoryArtifactReferenceStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, refs);
  const artifact = await artifacts.put({ bytes, kind: "image", mediaType: "image/png", license: "CC-BY-4.0", attribution: "ScienceMotion" });
  const linked = await manager.attachToProject(project, artifact.id, { assetId: "asset-lifecycle-cover", kind: "image", role: "cover" });
  assert.equal(project.assets.some((asset) => asset.id === "asset-lifecycle-cover"), false);
  assert.equal(linked.assets.find((asset) => asset.id === "asset-lifecycle-cover")?.uri, artifact.uri);
  assert.equal(linked.assets.find((asset) => asset.id === "asset-lifecycle-cover")?.contentHash, artifact.contentHash);
  assert.equal((await refs.list({ ownerType: "project", ownerId: project.project.id })).length, 1);
});

test("garbage collection respects references and retention grace period", async () => {
  const artifacts = new InMemoryArtifactStore();
  const refs = new InMemoryArtifactReferenceStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, refs);
  const kept = await artifacts.put({ bytes, kind: "data", mediaType: "application/octet-stream" });
  const unreferenced = await artifacts.put({ bytes: new TextEncoder().encode("orphan"), kind: "data", mediaType: "application/octet-stream" });
  await manager.attach({ artifactId: kept.id, ownerType: "project", ownerId: "project-kept", role: "dataset" });
  const result = await manager.collectGarbage({ olderThanMs: 0, now: new Date("2035-01-01T00:00:00.000Z") });
  assert.ok(await artifacts.get(kept.id));
  assert.equal(await artifacts.get(unreferenced.id), undefined);
  assert.equal(result.deleted.includes(unreferenced.id), true);
  assert.equal(result.retained >= 1, true);
  assert.equal(result.scanned, 2);
});

test("filesystem reference store survives manager restart and supports owner lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-artifact-refs-"));
  try {
    const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
    const referencePath = join(directory, "references");
    const artifact = await artifacts.put({ bytes, kind: "document", mediaType: "text/plain" });
    const firstManager = new LocalArtifactLifecycleManager(artifacts, new FileSystemArtifactReferenceStore(referencePath));
    const reference = await firstManager.attach({ artifactId: artifact.id, ownerType: "project", ownerId: "project-persisted", role: "research" });
    const restartedManager = new LocalArtifactLifecycleManager(artifacts, new FileSystemArtifactReferenceStore(referencePath));
    assert.equal((await restartedManager.references(artifact.id))[0].id, reference.id);
    assert.equal(await new FileSystemArtifactReferenceStore(referencePath).count(artifact.id), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle rejects missing artifacts and conflicting project asset IDs", async () => {
  const artifacts = new InMemoryArtifactStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, new InMemoryArtifactReferenceStore());
  await assert.rejects(() => manager.attach({ artifactId: "sha256:" + "0".repeat(64), ownerType: "project", ownerId: "p", role: "x" }), /does not exist/);
  const artifact = await artifacts.put({ bytes, kind: "image", mediaType: "image/png" });
  const conflicting = structuredClone(project);
  conflicting.assets.push({ id: "asset-conflict", kind: "image", uri: "artifact://other", contentHash: "other" });
  await assert.rejects(() => manager.attachToProject(conflicting, artifact.id, { assetId: "asset-conflict", kind: "image", role: "cover" }), /different content/);
});


test("project asset removal detaches only its own reference", async () => {
  const artifacts = new InMemoryArtifactStore();
  const refs = new InMemoryArtifactReferenceStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, refs);
  const artifact = await artifacts.put({ bytes, kind: "image", mediaType: "image/png" });
  const linked = await manager.attachToProject(project, artifact.id, {
    assetId: "asset-to-remove", kind: "image", role: "cover",
  });
  await manager.attach({ artifactId: artifact.id, ownerType: "project", ownerId: "another-project", role: "asset:shared" });
  const updated = await manager.detachProjectAsset(linked, "asset-to-remove");
  assert.equal(updated.assets.some((asset) => asset.id === "asset-to-remove"), false);
  assert.equal(project.assets.some((asset) => asset.id === "asset-to-remove"), false);
  const remaining = await manager.references(artifact.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].ownerId, "another-project");
  assert.ok(await artifacts.get(artifact.id));
});

test("reference reconciliation repairs missing and stale project asset references", async () => {
  const artifacts = new InMemoryArtifactStore();
  const refs = new InMemoryArtifactReferenceStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, refs);
  const artifact = await artifacts.put({ bytes, kind: "image", mediaType: "image/png" });
  const source = structuredClone(project);
  source.assets.push({
    id: "asset-needs-reference", kind: "image", uri: artifact.uri,
    contentHash: artifact.contentHash,
  });
  await manager.attach({
    artifactId: artifact.id, ownerType: "project", ownerId: source.project.id,
    role: "asset:asset-no-longer-in-project",
  });
  const result = await manager.reconcileProjectReferences(source);
  assert.deepEqual(result.attached, ["asset-needs-reference"]);
  assert.deepEqual(result.detached, ["asset-no-longer-in-project"]);
  assert.deepEqual(result.missingArtifacts, []);
  const refsAfter = await manager.references(artifact.id);
  assert.equal(refsAfter.length, 1);
  assert.equal(refsAfter[0].role, "asset:asset-needs-reference");
});

test("reference reconciliation reports project assets whose blobs are missing", async () => {
  const artifacts = new InMemoryArtifactStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, new InMemoryArtifactReferenceStore());
  const source = structuredClone(project);
  source.assets.push({
    id: "asset-missing-blob", kind: "image",
    uri: "artifact://sha256/" + "a".repeat(64),
    contentHash: "a".repeat(64),
  });
  const result = await manager.reconcileProjectReferences(source);
  assert.deepEqual(result.missingArtifacts, ["asset-missing-blob"]);
  assert.deepEqual(result.attached, []);
});


test("concurrent attach and garbage collection cannot delete a newly referenced artifact", async () => {
  const artifacts = new InMemoryArtifactStore();
  const refs = new InMemoryArtifactReferenceStore();
  const manager = new LocalArtifactLifecycleManager(artifacts, refs);
  const artifact = await artifacts.put({ bytes, kind: "data", mediaType: "application/octet-stream" });
  const attachPromise = manager.attach({
    artifactId: artifact.id, ownerType: "project", ownerId: "race-project", role: "asset:race",
  });
  const gcPromise = manager.collectGarbage({ olderThanMs: 0, now: new Date("2035-01-01T00:00:00.000Z") });
  await Promise.all([attachPromise, gcPromise]);
  assert.ok(await artifacts.get(artifact.id));
  assert.equal(await refs.count(artifact.id), 1);
});

test("filesystem reference store rejects malformed reference IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-reference-path-"));
  try {
    const store = new FileSystemArtifactReferenceStore(directory);
    await assert.rejects(() => store.attach({
      id: "../escape", artifactId: "sha256:" + "0".repeat(64),
      ownerType: "project", ownerId: "p", role: "asset:x", createdAt: new Date().toISOString(),
    }), /Invalid artifact reference ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
