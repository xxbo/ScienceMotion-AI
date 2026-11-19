import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export interface ObservedProcess { pid: number; parent: number; group: number; command: string; startTicks: string }
const startTicks = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const disappeared = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
};
export function processes(root: number): ObservedProcess[] {
  const ps = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8", timeout: 5000 });
  assert.equal(ps.status, 0, ps.stderr);
  const entries = ps.stdout.trim().split("\n").map(line => {
    const [pid, parent, group, ...name] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), command: name.join(" ") };
  });
  const owned = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of entries) if (owned.has(p.parent) && !owned.has(p.pid)) { owned.add(p.pid); changed = true; }
  }
  return entries.filter(p => owned.has(p.pid)).flatMap(p => {
    try { return [{ ...p, startTicks: startTicks(readFileSync(`/proc/${p.pid}/stat`, "utf8")) }]; }
    catch (error) { if (disappeared(error)) return []; throw error; }
  });
}
export async function stillOwned(p: ObservedProcess): Promise<boolean> {
  try { return startTicks(await readFile(`/proc/${p.pid}/stat`, "utf8")) === p.startTicks; }
  catch (error) { if (disappeared(error)) return false; throw error; }
}
export async function assertReaped(observed: ObservedProcess[]) {
  for (const p of observed) assert.equal(await stillOwned(p), false, `Owned process ${p.pid} (${p.command}) was not reaped`);
}
export async function waitReaped(observed: ObservedProcess[]) {
  const deadline = Date.now() + 10000;
  while ((await Promise.all(observed.map(stillOwned))).some(Boolean) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  await assertReaped(observed); // A zombie with the original start time is a failure too.
}
