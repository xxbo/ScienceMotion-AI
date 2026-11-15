import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** POSIX local filesystem: publish a complete synced file, optionally without replacing an existing file. */
export async function publishLocalFile(path: string, bytes: string | Uint8Array, createOnly = false): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (createOnly) {
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    } else await rename(temporary, path);
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    return true;
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
