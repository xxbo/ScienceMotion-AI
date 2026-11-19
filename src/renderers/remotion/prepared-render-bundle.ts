import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { RenderWorkerPreparedBundle } from "../../contracts/render-worker";

const maxBytes = 128 * 1024 * 1024;
const maxEntries = 4096;
const require = createRequire(import.meta.url);
type Entry = { path: string; size: number; directory: boolean };

export class PreparedBundleError extends Error {}

function environment() {
  return {
    format: "sciencemotion.remotion-bundle.v1",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    remotion: require("remotion/package.json").version,
    bundler: require("@remotion/bundler/package.json").version,
    renderer: require("@remotion/renderer/package.json").version,
  };
}

async function listEntries(directory: string) {
  if (!(await lstat(directory)).isDirectory()) throw new PreparedBundleError("Expected a local bundle directory");
  const folders = [""], entries: Entry[] = [];
  let total = 0;
  for (const folder of folders) {
    const handle = await opendir(join(directory, folder));
    for await (const entry of handle) {
      if (entries.length === maxEntries) throw new PreparedBundleError("Prepared bundle exceeds its entry limit");
      const path = join(folder, entry.name), info = await lstat(join(directory, path));
      if (info.isDirectory()) {
        folders.push(path);
        entries.push({ path, size: 0, directory: true });
      } else {
        if (!info.isFile() || info.nlink !== 1) throw new PreparedBundleError("Prepared bundle entries must be regular files or directories");
        total += info.size;
        if (total > maxBytes) throw new PreparedBundleError("Prepared bundle exceeds its byte limit");
        entries.push({ path, size: info.size, directory: false });
      }
    }
  }
  if (!entries.some(entry => entry.path === "index.html" && !entry.directory && entry.size > 0))
    throw new PreparedBundleError("Prepared bundle is missing index.html");
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function fileDigest(source: string, size: number, buffer: Buffer, destination?: string) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== size) throw new PreparedBundleError("Prepared bundle changed during verification");
    const output = destination ? await open(destination, "wx", 0o600) : undefined;
    try {
      const hash = createHash("sha256");
      let remaining = size;
      while (remaining > 0) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), null);
        if (!bytesRead) throw new PreparedBundleError("Prepared bundle file was truncated");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await output?.writeFile(chunk);
        remaining -= bytesRead;
      }
      if ((await input.read(buffer, 0, 1, null)).bytesRead) throw new PreparedBundleError("Prepared bundle file grew during verification");
      return hash.digest("hex");
    } finally { await output?.close(); }
  } finally { await input.close(); }
}

async function bundleIdentity(directory: string, destination?: string) {
  const entries = await listEntries(directory);
  const hash = createHash("sha256").update(JSON.stringify(environment()) + "\n");
  const buffer = Buffer.alloc(64 * 1024);
  for (const entry of entries) {
    const target = destination && join(destination, entry.path);
    if (entry.directory) {
      if (target) await mkdir(target, { mode: 0o700 });
      hash.update(JSON.stringify([entry.path, "directory"]) + "\n");
    } else {
      const digest = await fileDigest(join(directory, entry.path), entry.size, buffer, target);
      hash.update(JSON.stringify([entry.path, entry.size, digest]) + "\n");
    }
  }
  return hash.digest("hex");
}

/** Build a deployment input in a new directory. Run this in a dedicated build process. */
export async function prepareRenderBundle(entryPoint: string, output: string): Promise<RenderWorkerPreparedBundle> {
  const directory = resolve(output);
  await mkdir(directory, { mode: 0o700 });
  try {
    const { bundle } = await import("@remotion/bundler");
    await bundle({ entryPoint: resolve(entryPoint), outDir: directory, enableCaching: false,
      onSymlinkDetected: () => { throw new PreparedBundleError("Public assets must be self-contained regular files"); } });
    return { directory, sha256: await bundleIdentity(directory) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Verify the bytes written to the job's private temporary directory before Remotion can use them. */
export async function stagePreparedRenderBundle(bundle: Readonly<RenderWorkerPreparedBundle>, destination: string) {
  let created = false;
  try {
    await mkdir(destination, { mode: 0o700 });
    created = true;
    const sha256 = await bundleIdentity(bundle.directory, destination);
    if (sha256 !== bundle.sha256) throw new PreparedBundleError("Prepared bundle content or runtime identity mismatch");
    return destination;
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    if (error instanceof PreparedBundleError || (error as NodeJS.ErrnoException).code === "ENOSPC") throw error;
    throw new PreparedBundleError("Could not verify and stage the prepared render bundle", { cause: error });
  }
}
