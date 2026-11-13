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
