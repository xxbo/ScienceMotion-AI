import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { InMemoryArtifactStore, FileSystemArtifactStore } from "./artifact-store";

const bytes = new TextEncoder().encode("science-motion-artifact");

test("in-memory artifact store uses content hashes, deduplicates, and returns isolated bytes", async () => {
  const store = new InMemoryArtifactStore();
  const first = await store.put({
    bytes, kind: "image", mediaType: "image/png",
    provenance: { projectId: "project-a", toolId: "graphics.image.generate" },
  });
  const second = await store.put({ bytes: new Uint8Array(bytes), kind: "image", mediaType: "image/png" });
  assert.equal(first.id, second.id);
  assert.equal(first.uri, `artifact://sha256/${first.contentHash}`);
  assert.equal(first.sizeBytes, bytes.byteLength);
  const read = await store.read(first.id);
  assert.deepEqual(read, bytes);
  read![0] = 0;
  assert.deepEqual(await store.read(first.id), bytes);
  assert.equal((await store.findByHash(first.contentHash))?.id, first.id);
  assert.equal((await store.list({ projectId: "project-a" })).length, 1);
});

test("filesystem artifact store persists bytes, metadata, and deduplicates content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-artifacts-"));
  try {
    const store = new FileSystemArtifactStore(directory);
    const record = await store.put({
      bytes, kind: "document", mediaType: "text/plain",
      provenance: { projectId: "project-b", runId: "run-1", toolId: "research.source.fetch" },
      metadata: { title: "Reference notes" }, license: "CC-BY-4.0",
    });
    const duplicate = await store.put({ bytes, kind: "document", mediaType: "text/plain" });
    assert.equal(duplicate.id, record.id);
    assert.equal((await store.get(record.id))?.metadata?.title, "Reference notes");
    assert.deepEqual(await store.read(record.id), bytes);
    assert.equal((await store.findByHash(record.contentHash))?.id, record.id);
    assert.equal((await store.list({ projectId: "project-b", kind: "document" })).length, 1);
    assert.equal(await store.delete(record.id), true);
    assert.equal(await store.get(record.id), undefined);
    assert.equal(await store.read(record.id), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem artifact store detects blob tampering and rejects unsafe IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciencemotion-artifact-integrity-"));
  try {
    const store = new FileSystemArtifactStore(directory);
    const record = await store.put({ bytes, kind: "data", mediaType: "application/octet-stream" });
    const hash = record.contentHash;
    await writeFile(join(directory, "blobs", hash.slice(0, 2), hash), "tampered");
    await assert.rejects(() => store.read(record.id), /integrity check failed/);
    await assert.rejects(() => store.get("../escape"), /Invalid artifact ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact identity matches independently computed SHA-256", async () => {
  const store = new InMemoryArtifactStore();
  const record = await store.put({ bytes, kind: "other", mediaType: "application/octet-stream" });
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(record.contentHash, expected);
  assert.equal(record.id, `sha256:${expected}`);
});
