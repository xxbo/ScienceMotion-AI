import { createHash } from "node:crypto";
import type { ArtifactStore } from "../contracts/artifact";
import type { RenderJobReceipt, RenderJobRecord } from "../contracts/render-job";
import { jobFail } from "./render-job-validation";

export const jobOutputOwner = ({ id, input }: RenderJobRecord) => ({
  ownerType: "render-job" as const, ownerId: JSON.stringify([input.projectId, id]), role: "host-output",
});

export function jobOutputReceipt(record: RenderJobRecord, contentHash: string, sizeBytes: number): RenderJobReceipt {
  return { jobId: record.id, inputHash: record.inputHash, artifactId: `sha256:${contentHash}`, contentHash, sizeBytes,
    mediaType: record.input.render.operation === "preview" ? "image/png" : "video/mp4",
    rendererId: record.input.renderer.id, rendererVersion: record.input.renderer.version };
}

export async function readVerifiedJobArtifact(artifacts: Pick<ArtifactStore, "get" | "read">, receipt: RenderJobReceipt): Promise<Uint8Array | undefined> {
  const stored = await artifacts.get(receipt.artifactId);
  if (!stored) return;
  if (stored.id !== receipt.artifactId || stored.contentHash !== receipt.contentHash || stored.uri !== `artifact://sha256/${receipt.contentHash}` ||
      stored.kind !== (receipt.mediaType === "image/png" ? "image" : "video") || stored.mediaType !== receipt.mediaType ||
      stored.sizeBytes !== receipt.sizeBytes)
    jobFail("HOST_ARTIFACT_CORRUPT", "Published result metadata differs from the receipt");
  const bytes = await artifacts.read(receipt.artifactId);
  if (!bytes) return;
  if (bytes.byteLength !== receipt.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== receipt.contentHash)
    jobFail("HOST_ARTIFACT_CORRUPT", "Published result failed byte/receipt verification");
  return bytes;
}

export async function verifyJobArtifact(artifacts: Pick<ArtifactStore, "get" | "read">, receipt: RenderJobReceipt): Promise<boolean> {
  return (await readVerifiedJobArtifact(artifacts, receipt)) !== undefined;
}
