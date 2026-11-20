import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { CreativeAssetImport } from "../contracts/creative-host";
import { CreativeHostError } from "./creative-host-core";
import { MAX_PNG_BYTES, PngInputError, validateStaticPng } from "./png-input";

export function approvedAssetImports(input: readonly CreativeAssetImport[] = [], baseDirectory = process.cwd()): CreativeAssetImport[] {
  if (!Array.isArray(input)) throw new CreativeHostError("HOST_ASSET_IMPORT_CONFIG", "Expected an array of approved asset sources");
  const sources = new Set<string>();
  return Array.from(input, (source: CreativeAssetImport) => {
    if (!source || typeof source !== "object" || Array.isArray(source) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(source)) ||
        Object.keys(source).some(key => !["projectId", "sourceId", "path", "license", "attribution"].includes(key)) ||
        [source.projectId, source.sourceId, source.path].some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) ||
        source.projectId.length > 256 || source.sourceId.length > 256 ||
        [source.license, source.attribution].some(value => value !== undefined && (typeof value !== "string" || value.length > 1024)))
      throw new CreativeHostError("HOST_ASSET_IMPORT_CONFIG", "Approved sources require a project ID, source ID and local path");
    const key = JSON.stringify([source.projectId, source.sourceId]);
    if (sources.has(key)) throw new CreativeHostError("HOST_ASSET_IMPORT_CONFIG", "Duplicate approved source in a project");
    sources.add(key);
    return { ...source, path: resolve(baseDirectory, source.path) };
  });
}

export async function readApprovedPng(source: CreativeAssetImport, maxArtifactBytes: number) {
  let bytes: Buffer;
  try {
    const input = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await input.stat();
      if (!stat.isFile()) throw new CreativeHostError("HOST_ASSET_IMPORT_UNAVAILABLE", "Approved source must be a regular local file");
      if (stat.size > Math.min(maxArtifactBytes, MAX_PNG_BYTES))
        throw new CreativeHostError("HOST_PNG_LIMIT", "Approved PNG exceeds the supported byte limit");
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await input.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("File changed");
        offset += bytesRead;
      }
      const after = await input.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("File changed");
    } finally { await input.close(); }
  } catch (error) {
    if (error instanceof CreativeHostError) throw error;
    throw new CreativeHostError("HOST_ASSET_IMPORT_UNAVAILABLE", "Could not read the approved PNG source");
  }
  try {
    return { bytes, ...await validateStaticPng(bytes), license: source.license, attribution: source.attribution };
  } catch (error) {
    if (error instanceof PngInputError) throw new CreativeHostError(error.code, error.message);
    throw error;
  }
}
