import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactRecord } from "../../src/contracts/artifact";
import { hashProject, type ProjectSnapshot } from "../../src/platform/project-snapshots";
import { replayAssetId } from "./pendulum-replay-project";

/** Use B's actual retained bytes and snapshot binding, never a renderer-specific re-solve. */
export async function readRetainedLongPendulum(checkout: string, directory = resolve("out/pendulum-trajectory")) {
  const json = async <T>(file: string) => JSON.parse(await readFile(join(directory, file), "utf8")) as T;
  const [evidence, snapshot, bytes] = await Promise.all([
    json<{ checkout: string; status: string; cases: Array<{ id: string; file: string; artifact: ArtifactRecord }> }>("evidence.json"),
    json<ProjectSnapshot>("snapshot.json"),
    readFile(join(directory, "long-trajectory.json")),
  ]);
  assert.deepEqual([evidence.checkout, evidence.status, snapshot.id, snapshot.contentHash],
    [checkout, "passed", "pendulum-trajectories-v1", hashProject(snapshot.document)]);
  const retained = evidence.cases.find(item => item.id === "long");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const artifactId = `sha256:${contentHash}`, uri = `artifact://sha256/${contentHash}`;
  assert.ok(retained);
  const { artifact } = retained;
  assert.deepEqual([retained.file, artifact.kind, artifact.mediaType, artifact.id, artifact.uri, artifact.contentHash, artifact.sizeBytes],
    ["long-trajectory.json", "data", "application/json", artifactId, uri, contentHash, bytes.length]);
  assert.deepEqual(snapshot.document.assets.find(asset => asset.id === replayAssetId),
    { id: replayAssetId, kind: "data", uri, contentHash });
  return { bytes, identity: { artifactId, bSnapshotHash: snapshot.contentHash, contentHash } };
}
