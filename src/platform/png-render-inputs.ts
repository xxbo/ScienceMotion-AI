import { createHash } from "node:crypto";
import type { ArtifactStore } from "../contracts/artifact";
import type { ProjectGraphRenderRequest } from "../contracts/renderer";
import { projectPngArtifactIds } from "./project-assets";
import { MAX_PNG_BYTES, MAX_PNG_PIXELS, PngInputError, pngDimensions } from "./png-input";
import { firstSequencePngClips } from "./project-timeline";

function requestPngArtifactIds(request: ProjectGraphRenderRequest): string[] {
  const ids = new Set(projectPngArtifactIds(request.project));
  if (!request.sceneId) for (const { artifactId } of firstSequencePngClips(request.project)) ids.add(artifactId);
  return [...ids];
}

export async function loadRenderPngAssets(request: ProjectGraphRenderRequest, artifacts: Pick<ArtifactStore, "get" | "read">) {
  const ids = requestPngArtifactIds(request);
  if (ids.length === 0) return undefined;
  let bytesRemaining = MAX_PNG_BYTES, pixelsRemaining = MAX_PNG_PIXELS;
  const imageAssets: Record<string, string> = {};
  for (const id of ids) {
    request.signal?.throwIfAborted();
    const record = await artifacts.get(id);
    if (!record || record.kind !== "image" || record.mediaType !== "image/png")
      throw new PngInputError("HOST_PNG_INVALID", "Snapshot PNG artifact is missing or has an incompatible type");
    if (record.sizeBytes > bytesRemaining) throw new PngInputError("HOST_PNG_LIMIT", "Render PNG inputs exceed their aggregate byte limit");
    const bytes = await artifacts.read(id);
    if (!bytes || bytes.byteLength !== record.sizeBytes)
      throw new PngInputError("HOST_PNG_INVALID", "Snapshot PNG artifact is missing or has inconsistent bytes");
    bytesRemaining -= bytes.byteLength;
    const { width, height } = pngDimensions(bytes);
    pixelsRemaining -= width * height;
    if (pixelsRemaining < 0) throw new PngInputError("HOST_PNG_LIMIT", "Render PNG inputs exceed their aggregate pixel limit");
    imageAssets[id] = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  request.signal?.throwIfAborted();
  return imageAssets;
}

/** Called inside the selected renderer, including after a worker receives the job file. */
export function verifiedPngSources(request: ProjectGraphRenderRequest) {
  const ids = requestPngArtifactIds(request), images = request.imageAssets ?? {};
  if (Object.keys(images).length !== ids.length)
    throw new PngInputError("HOST_PNG_INVALID", "Render PNG payload does not match the snapshot");
  if (ids.length === 0) return undefined;
  let bytesRemaining = MAX_PNG_BYTES, pixelsRemaining = MAX_PNG_PIXELS;
  const sources: Record<string, string> = {};
  for (const id of ids) {
    request.signal?.throwIfAborted();
    const encoded = images[id];
    if (!Object.hasOwn(images, id) || typeof encoded !== "string")
      throw new PngInputError("HOST_PNG_INVALID", "Render PNG payload is missing a snapshot asset");
    if (encoded.length > 4 * Math.ceil(bytesRemaining / 3))
      throw new PngInputError("HOST_PNG_LIMIT", "Render PNG inputs exceed their aggregate byte limit");
    const bytes = Buffer.from(encoded, "base64");
    bytesRemaining -= bytes.byteLength;
    const { width, height } = pngDimensions(bytes);
    pixelsRemaining -= width * height;
    if (bytesRemaining < 0 || pixelsRemaining < 0)
      throw new PngInputError("HOST_PNG_LIMIT", "Render PNG inputs exceed their aggregate byte or pixel limit");
    if (bytes.toString("base64") !== encoded || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== id)
      throw new PngInputError("HOST_PNG_INVALID", "Render PNG payload differs from its snapshot artifact hash");
    sources[id] = `data:image/png;base64,${encoded}`;
  }
  return sources;
}
