import { createHash } from "node:crypto";
import type { ArtifactProvenance, ArtifactRecord, ArtifactStore } from "../contracts/artifact";
import type { PendulumTrajectory } from "../contracts/pendulum-trajectory";
import { parsePendulumTrajectory, PendulumTrajectoryError } from "./pendulum-trajectory";

// A compact v1 trajectory with 10,001 finite samples fits under this byte limit.
const maxTrajectoryBytes = 4 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const mediaType = "application/json";

function verifyRecord(record: ArtifactRecord | undefined, artifactId: string) {
  if (!record || record.kind !== "data" || record.mediaType !== mediaType || record.id !== artifactId ||
      !/^[0-9a-f]{64}$/.test(record.contentHash) || artifactId !== `sha256:${record.contentHash}` ||
      record.uri !== `artifact://sha256/${record.contentHash}` || !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes < 1 || record.sizeBytes > maxTrajectoryBytes)
    throw new PendulumTrajectoryError("/artifact", "must be a retained JSON data artifact with a valid trajectory identity and size");
  return record;
}

export function encodePendulumTrajectory(trajectory: PendulumTrajectory): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parsePendulumTrajectory(trajectory)) + "\n");
}

export async function retainPendulumTrajectory(store: Pick<ArtifactStore, "put">, trajectory: PendulumTrajectory, provenance?: ArtifactProvenance) {
  const bytes = encodePendulumTrajectory(trajectory);
  const record = verifyRecord(await store.put({ bytes, kind: "data", mediaType, provenance }), `sha256:${sha(bytes)}`);
  if (record.sizeBytes !== bytes.byteLength) throw new PendulumTrajectoryError("/artifact", "does not match the published trajectory size");
  return record;
}

export async function readPendulumTrajectory(store: Pick<ArtifactStore, "get" | "read">, artifactId: string) {
  const record = verifyRecord(await store.get(artifactId), artifactId);
  const bytes = await store.read(artifactId);
  if (!bytes || bytes.byteLength !== record.sizeBytes || sha(bytes) !== record.contentHash)
    throw new PendulumTrajectoryError("/artifact", "does not match the retained trajectory bytes");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PendulumTrajectoryError("/artifact", "must contain valid UTF-8 JSON"); }
  return { record, bytes, trajectory: parsePendulumTrajectory(value) };
}
