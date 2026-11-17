import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RenderWorkerEvent } from "../../src/contracts/render-worker";
import type { ProjectSnapshot } from "../../src/platform/project-snapshots";
import type { ToolExecutionRecord } from "../../src/contracts/agent-tool";
import type { ProjectDocument } from "../../src/contracts/project";
import { openCreativeHost } from "../../src/platform/creative-host";
import { FileSystemArtifactStore } from "../../src/platform/artifact-store";
import { hashProject } from "../../src/platform/project-snapshots";

interface ObservedProcess { pid: number; parent: number; group: number; command: string; startTicks: string }
function processes(root: number): ObservedProcess[] {
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
    try { const stat = readFileSync(`/proc/${p.pid}/stat`, "utf8"); return [{ ...p, startTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] }]; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  });
}
async function assertReaped(processes: ObservedProcess[]) {
  for (const p of processes) {
    try {
      const stat = await readFile(`/proc/${p.pid}/stat`, "utf8");
      assert.notEqual(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], p.startTicks, `Owned process ${p.pid} (${p.command}) was not reaped`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Deterministic lifecycle check against the real browser; it is not another model interaction. */
export async function verifyRenderWorkerLifecycle(directory: string, saved: ProjectSnapshot, output: string) {
  const controller = new AbortController(), events: RenderWorkerEvent[] = [];
  let observed: ObservedProcess[] = [], callbackFailure: unknown, cancelled = false;
  const host = await openCreativeHost({ directory, renderWorker: {}, onRenderWorkerEvent: event => {
    events.push(event);
    if (!cancelled && event.operation === "video" && event.progress?.phase === "rendering" &&
        (event.progress.fraction ?? 0) > 0 && (event.progress.fraction ?? 1) < 0.8) {
      cancelled = true;
      try { observed = processes(event.processId!); } catch (error) { callbackFailure = error; }
      controller.abort();
    }
  } });
  const session = host.createSession({ projectId: saved.projectId,
    toolIds: ["render.video", "render.preview", "project.inspect", "execution.list"],
    permissions: ["project.read", "snapshot.read", "artifact.write", "execution.read"] });
  let sequence = 0;
  const call = (callId: string, toolId: string, input: unknown, signal?: AbortSignal) => session.invoke({
    toolId, toolVersion: "1.0.0", input, runId: "render-worker-lifecycle", callId: `${++sequence}-${callId}`, signal,
  });
  const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
  try {
    const before = await artifacts.list();
    const result = await call("cancel-video", "render.video", { snapshotId: saved.id, startFrame: 0, durationFrames: 360 }, controller.signal);
    assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, "TOOL_CANCELLED");
    assert.equal(cancelled, true, "Cancellation must happen after real video frame progress");
    if (callbackFailure) throw callbackFailure;
    assert.ok(observed.some(p => /chrome/i.test(p.command)), "Observe a live Chromium descendant during cancellation");
    // The host service queue waits for actual worker cleanup before admitting this read.
    const inspected = await call("inspect-after-cancel", "project.inspect", {});
    assert.equal(inspected.ok, true); assert.equal(hashProject(inspected.output as ProjectDocument), saved.contentHash);
    await assertReaped(observed);
    assert.deepEqual((await artifacts.list()).map(a => a.id), before.map(a => a.id), "Cancelled render must not publish an Artifact");
    assert.ok(events.some(e => e.state === "cancelled"));
    const recovery = await call("preview-after-cancel", "render.preview", { snapshotId: saved.id, frame: 45 });
    assert.equal(recovery.ok, true, JSON.stringify(recovery.diagnostics));
    const receipt = recovery.output as { artifactId: string; contentHash: string; metadata: { snapshotHash: string; execution: { kind: string; processId: number } } };
    assert.equal(receipt.metadata.snapshotHash, saved.contentHash); assert.equal(receipt.metadata.execution.kind, "local-process");
    const bytes = await artifacts.read(receipt.artifactId); assert.ok(bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.contentHash);
    await writeFile(join(output, "recovery-preview.png"), bytes);
    const records = (await call("execution-evidence", "execution.list", {})).output as ToolExecutionRecord[];
    const cancellation = records.find(r => r.runId === "render-worker-lifecycle" && r.callId === "1-cancel-video");
    assert.equal(cancellation?.status, "cancelled"); assert.equal(cancellation?.result?.artifacts?.length ?? 0, 0);
    return { status: "passed", cancellation, observedProcesses: observed, observedProcessesReaped: true,
      noCancelledArtifact: true, projectUnchanged: true, recovery: receipt, events,
      scope: "Real Remotion video cancellation followed by a new preview, through public host tools; Linux guardian reaps detached descendants" };
  } finally { session.revoke(); await host.close(); }
}
