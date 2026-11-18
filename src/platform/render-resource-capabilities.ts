import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type Verification<T> = { state: "verified"; evidence: T } |
  { state: "not-tested" | "unavailable"; diagnostic: string };

interface CgroupEvidence {
  cpuMax: string;
  cpuUsageUsec: string;
  memoryMaxBytes: number;
  memoryOomKills: string;
}

interface StorageEvidence {
  fileSystem: "ext4";
  mountSource: string;
  capacityBytes: number;
  bytesWritten: number;
  availableBeforeBytes: number;
  availableAfterBytes: number;
  exhaustion: "ENOSPC";
}

interface ProbeOptions {
  /** A delegated cgroup v2 parent with CPU and memory enabled for children. */
  cgroupParent?: string;
  /** The root of an empty, disposable ext4 loop mount of at most 64 MiB. */
  temporaryVolume?: string;
}

const cgroup2Magic = 0x63677270;
const mib = 1024 * 1024;
const diagnostic = (error: unknown) => error instanceof Error ? error.message : String(error);

function counter(text: string, name: string): string {
  const value = text.split("\n").map(line => line.split(" ")).find(([key]) => key === name)?.[1];
  if (!value || !/^\d+$/.test(value)) throw new Error(`Missing cgroup counter ${name}`);
  return value;
}

async function testDelegation(parent: string): Promise<CgroupEvidence> {
  const enabled = (await readFile(join(parent, "cgroup.subtree_control"), "utf8")).trim().split(/\s+/);
  if (!["cpu", "memory"].every(controller => enabled.includes(controller)))
    throw new Error("Enable the cpu and memory controllers for children of the delegated parent");

  const child = await mkdtemp(join(parent, "sciencemotion-probe-"));
  try {
    const cpuMax = "50000 100000", memoryMaxBytes = 128 * mib;
    await writeFile(join(child, "cpu.max"), cpuMax);
    await writeFile(join(child, "memory.max"), String(memoryMaxBytes));
    if ((await readFile(join(child, "cpu.max"), "utf8")).trim() !== cpuMax ||
        (await readFile(join(child, "memory.max"), "utf8")).trim() !== String(memoryMaxBytes))
      throw new Error("CPU or memory controls did not read back at their requested values");

    // The short-lived child moves only itself. The caller stays outside this cgroup.
    const work = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
      const { readFileSync, writeFileSync } = require("node:fs");
      const membership = process.argv[1];
      writeFileSync(membership, "0");
      if (!readFileSync(membership, "utf8").split(/\\s+/).includes(String(process.pid))) process.exit(1);
      const end = process.hrtime.bigint() + 10_000_000n;
      while (process.hrtime.bigint() < end) {}
    `, join(child, "cgroup.procs")], { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 8192 });
    if (work.error) throw work.error;
    if (work.status !== 0) throw new Error("Could not attach the owned probe process to the delegated cgroup");
    const cpuUsageUsec = counter(await readFile(join(child, "cpu.stat"), "utf8"), "usage_usec");
    if (BigInt(cpuUsageUsec) === 0n) throw new Error("CPU accounting did not record the probe process");
    const memoryOomKills = counter(await readFile(join(child, "memory.events"), "utf8"), "oom_kill");
    return { cpuMax, cpuUsageUsec, memoryMaxBytes, memoryOomKills };
  } finally {
    await rmdir(child);
  }
}

async function inspectCgroup(parent?: string) {
  const path = resolve(parent ?? "/sys/fs/cgroup");
  let version: 2 | null = null, controllers: string[] = [], subtreeControlWritable = false;
  let verification: Verification<CgroupEvidence>;
  try {
    if ((await statfs(path)).type !== cgroup2Magic) throw new Error("The supplied path is outside a cgroup v2 filesystem");
    version = 2;
    controllers = (await readFile(join(path, "cgroup.controllers"), "utf8")).trim().split(/\s+/).filter(Boolean);
    subtreeControlWritable = await access(join(path, "cgroup.subtree_control"), constants.W_OK).then(() => true, () => false);
    verification = parent
      ? { state: "verified", evidence: await testDelegation(path) }
      : { state: "not-tested", diagnostic: "Supply an explicit delegated parent to test cgroup writes" };
  } catch (error) {
    verification = { state: "unavailable", diagnostic: diagnostic(error) };
  }
  return { path, version, controllers, subtreeControlWritable, verification };
}

const unescapeMountPath = (path: string) => path.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
  String.fromCharCode(Number.parseInt(octal, 8)));

async function inspectStorage(volume?: string): Promise<Verification<StorageEvidence>> {
  if (!volume) return { state: "not-tested", diagnostic: "Supply a dedicated ext4 loop mount to test storage exhaustion" };
  try {
    const root = await realpath(volume);
    const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n");
    const mount = mounts.find(line => line && unescapeMountPath(line.split(" ")[4]) === root);
    const [fileSystem, mountSource] = mount?.split(" - ")[1]?.split(" ") ?? [];
    if (fileSystem !== "ext4" || !/^\/dev\/loop\d+$/.test(mountSource))
      throw new Error("Storage probe requires the root of a dedicated ext4 loop mount");

    const before = await statfs(root), capacityBytes = before.blocks * before.bsize;
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0 || capacityBytes > 64 * mib ||
        (await readdir(root)).some(name => name !== "lost+found"))
      throw new Error("Storage probe requires an empty ext4 loop mount of at most 64 MiB");
    const availableBeforeBytes = before.bavail * before.bsize;
    if (availableBeforeBytes < mib) throw new Error("Storage probe needs at least 1 MiB of writable space");

    const scratch = await mkdtemp(join(root, "sciencemotion-probe-"));
    let bytesWritten = 0, exhausted = false;
    try {
      const fill = Buffer.alloc(mib);
      const file = await open(join(scratch, "fill"), "wx", 0o600);
      try {
        while (bytesWritten <= capacityBytes) {
          const { bytesWritten: written } = await file.write(fill);
          if (!written) throw new Error("Storage probe writes made no progress");
          bytesWritten += written;
          await file.sync(); // Catch delayed allocation failures as well as write failures.
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
        exhausted = true;
      } finally { await file.close(); }
    } finally { await rm(scratch, { recursive: true, force: true }); }
    if (!exhausted || !bytesWritten) throw new Error("Storage probe did not observe ENOSPC after writing data");

    const after = await statfs(root), availableAfterBytes = after.bavail * after.bsize;
    if (availableAfterBytes < availableBeforeBytes) throw new Error("The probe's storage was not reclaimed");
    return { state: "verified", evidence: { fileSystem, mountSource, capacityBytes, bytesWritten,
      availableBeforeBytes, availableAfterBytes, exhaustion: "ENOSPC" } };
  } catch (error) {
    return { state: "unavailable", diagnostic: diagnostic(error) };
  }
}

/** Tests the supplied Linux primitives in isolation. It does not enable worker enforcement. */
export async function probeRenderResources(options: ProbeOptions = {}) {
  const platform = process.platform;
  if (platform !== "linux") {
    const unavailable = { state: "unavailable" as const, diagnostic: "Render resource probes require Linux" };
    return { schemaVersion: "1.0.0" as const, platform, enforcement: "probe-only" as const,
      cgroup: { path: options.cgroupParent ?? "/sys/fs/cgroup", version: null, controllers: [],
        subtreeControlWritable: false, verification: unavailable }, storage: unavailable };
  }
  const [cgroup, storage] = await Promise.all([inspectCgroup(options.cgroupParent), inspectStorage(options.temporaryVolume)]);
  return { schemaVersion: "1.0.0" as const, platform, enforcement: "probe-only" as const, cgroup, storage };
}
