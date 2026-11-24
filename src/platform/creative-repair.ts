import { randomUUID } from "node:crypto";
import type { CreativeSession, SnapshotReceipt } from "../contracts/creative-host";
import type { CreativePlanner, CreativePlannerContext } from "../contracts/creative-planner";
import type { CreativeRepairCheckpoint, CreativeRepairFinding, CreativeRepairOptions, CreativeRepairPlanner, CreativeRepairReport,
  CreativeRepairReports, CreativeRepairStop } from "../contracts/creative-repair";
import { CreativePlanningError, parseCreativeDecision } from "./creative-planner";
import { compareRepairFindings, inspectionInput, inspectionTools, matchesInspection, repairFindings, type RepairCheck } from "./creative-repair-evidence";
import { repairToolIds, scopedRepairFindings } from "./creative-repair-scope";
import { runCreativePlan } from "./creative-runner";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { hashToolInput } from "./tool-execution-store";

function proposal(catalogue: CreativePlannerContext["catalogue"], toolId: string, input: unknown): string | undefined {
  const selected = catalogue.tools.find(tool => tool.id === toolId);
  return selected && JSON.stringify({ kind: "invoke", toolId, toolVersion: selected.version, input });
}

const isRevisionConflict = (diagnostics: readonly { code: string; message: string }[]) =>
  diagnostics.some(item => item.code === "HOST_REVISION_CONFLICT" || item.message.startsWith("Revision conflict:"));

/** Inspect, propose one scoped edit, retain its revision, and recheck the same evidence coverage. */
export async function repairCreativeSnapshot(session: Pick<CreativeSession, "projectId" | "discover" | "manifest" | "invoke">,
  planner: CreativeRepairPlanner, options: CreativeRepairOptions): Promise<CreativeRepairReport> {
  const { snapshotId, checks: selection, maxRepairs = 3, limits, ...runOptions } = options;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0)
    throw new CreativePlanningError("REPAIR_LIMIT_INVALID", "Use a nonnegative integer for the repair limit");
  const checks = structuredClone(selection ?? { model: {}, layout: {}, timeline: {} });
  const enabled = (Object.keys(inspectionTools) as RepairCheck[]).filter(check => checks[check] !== undefined);
  if (!enabled.length) throw new CreativePlanningError("REPAIR_CHECKS_EMPTY", "Select at least one inspection");

  let baseline: CreativeRepairCheckpoint | undefined, baselineReports: CreativeRepairReports | undefined;
  let lastVerified: CreativeRepairCheckpoint | undefined, rejectedCandidate: CreativeRepairCheckpoint | undefined;
  let pending: { id: string; targets: CreativeRepairFinding[]; revisionId?: string; receipt?: SnapshotReceipt } | undefined;
  let snapshot: ProjectSnapshot | undefined, reports: CreativeRepairReports = {};
  let repairsVerified = 0, stopped: CreativeRepairStop | undefined;
  const attempted = new Set<string>();
  const finish = (reason: CreativeRepairStop, summary: string) => {
    stopped = reason;
    return JSON.stringify({ kind: "finish", summary });
  };

  const controller: CreativePlanner = { async propose(context, signal) {
    const invoke = (toolId: string, input: unknown) => proposal(context.catalogue, toolId, input) ??
      finish("tool-failed", `The scoped catalogue does not contain ${toolId}`);
    const observed = context.observation;
    if (!observed) return invoke("project.snapshot.inspect", { snapshotId });
    const { decision, result } = observed;
    if (!result.ok) {
      if (isRevisionConflict(result.diagnostics)) return finish("revision-conflict", "The project revision changed during inspection or repair");
      return finish("tool-failed", `Repair stopped after ${decision.toolId} failed`);
    }

    if (decision.toolId === "project.snapshot.inspect") {
      const loaded = result.output as ProjectSnapshot | undefined;
      const expectedId = pending?.id ?? snapshotId;
      if (!loaded?.document?.sequences?.[0] || loaded.id !== expectedId || loaded.projectId !== session.projectId ||
          loaded.document.project.id !== session.projectId || loaded.contentHash !== hashProject(loaded.document) ||
          !loaded.document.revisions.at(-1)?.id || (pending && (loaded.contentHash !== pending.receipt?.contentHash ||
            loaded.document.revisions.at(-1)?.id !== pending.revisionId || loaded.document.revisions.at(-1)?.parentRevisionId !== lastVerified?.revisionId)))
        return finish("incomparable-inspection", "Snapshot identity, hash or revision lineage was inconsistent");
      snapshot = loaded;
      reports = {};
    } else if (decision.toolId === "project.snapshot.save") {
      const receipt = result.output as SnapshotReceipt | undefined;
      if (!pending || !receipt || receipt.id !== pending.id || receipt.projectId !== session.projectId || !/^[0-9a-f]{64}$/.test(receipt.contentHash))
        return finish("incomparable-inspection", "The repair snapshot receipt did not match the requested revision");
      pending.receipt = receipt;
      return invoke("project.snapshot.inspect", { snapshotId: pending.id });
    } else if (repairToolIds.has(decision.toolId)) {
      const revisionId = (result.output as { revisionId?: unknown } | undefined)?.revisionId;
      if (!pending || typeof revisionId !== "string" || !revisionId || revisionId === lastVerified?.revisionId)
        return finish("tool-failed", "The repair tool did not return a new revision identity");
      pending.revisionId = revisionId;
      return invoke("project.snapshot.save", { snapshotId: pending.id, revisionId });
    } else {
      const check = enabled.find(item => inspectionTools[item] === decision.toolId);
      const report = result.output as NonNullable<CreativeRepairReports[RepairCheck]>;
      if (!check || !snapshot || !matchesInspection(check, report, snapshot, checks, baselineReports))
        return finish("incomparable-inspection", "Inspection was truncated or differed in snapshot identity or coverage");
      reports = { ...reports, [check]: report };
    }

    if (!snapshot) return finish("incomparable-inspection", "Repair requires a loaded snapshot");
    const next = enabled.find(check => !reports[check]);
    if (next) return invoke(inspectionTools[next], inspectionInput(next, snapshot.id, checks, baselineReports));
    const checkpoint: CreativeRepairCheckpoint = { snapshotId: snapshot.id, snapshotHash: snapshot.contentHash,
      revisionId: snapshot.document.revisions.at(-1)!.id, findings: repairFindings(reports) };
    if (!lastVerified) {
      baseline = checkpoint;
      baselineReports = reports;
    } else if (pending) {
      const verdict = compareRepairFindings(lastVerified.findings, checkpoint.findings, pending.targets);
      if (verdict !== "improved") {
        rejectedCandidate = checkpoint;
        return finish(verdict, verdict === "regressed" ? "The candidate introduced or expanded a finding" : "The candidate did not reduce a targeted finding");
      }
      repairsVerified++;
    }
    lastVerified = checkpoint;
    pending = undefined;
    if (!checkpoint.findings.length) return finish("verified", "The selected inspection coverage is clear");
    if (attempted.size >= maxRepairs) return finish("repair-limit", "The repair budget ended with unresolved findings");

    const tools = context.catalogue.tools.filter(tool => repairToolIds.has(tool.id));
    if (!tools.length) return finish("unresolved", "The scoped catalogue has no supported repair tools");
    const catalogue = { tools, total: tools.length, limit: context.catalogue.limit, offset: 0 };
    const raw = await planner.propose({ protocolVersion: context.protocolVersion, projectId: context.projectId, brief: context.brief,
      catalogue, repair: structuredClone({ ...checkpoint, document: snapshot.document, reports }) }, signal);
    signal?.throwIfAborted();
    const edit = parseCreativeDecision(raw);
    if (edit.kind !== "invoke") {
      stopped = edit.kind === "needs-input" ? "needs-input" : "unresolved";
      return raw;
    }
    const targets = scopedRepairFindings(edit, snapshot.document, checkpoint.findings);
    if (!targets.length || !tools.some(tool => tool.id === edit.toolId))
      return finish("out-of-scope", "The proposal must use one permitted edit on a diagnosed target of this revision");
    const { baseRevisionId: _base, ...operation } = edit.input as Record<string, unknown>;
    const key = hashToolInput([edit.toolId, edit.toolVersion, operation]);
    if (attempted.has(key)) return finish("repeated-proposal", "The planner repeated an earlier edit");
    attempted.add(key);
    pending = { id: `repair-${randomUUID()}`, targets };
    return raw;
  } };

  const run = await runCreativePlan(session, controller, { ...runOptions, limits: { timeoutMs: 90_000, ...limits } });
  const lastResult = run.turns.at(-1)?.call?.result;
  const conflict = !!lastResult && isRevisionConflict(lastResult.diagnostics);
  const stop = run.stop.reason === "finished" || run.stop.reason === "needs-input" ? stopped ?? "execution-stopped"
    : conflict ? "revision-conflict" : "execution-stopped";
  return { schemaVersion: "1.0.0", stop, baseline, lastVerified, rejectedCandidate,
    repairsAttempted: run.turns.filter(turn => turn.call && turn.decision.kind === "invoke" && repairToolIds.has(turn.decision.toolId)).length,
    repairsVerified, run };
}
