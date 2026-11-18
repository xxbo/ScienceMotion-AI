import type { CreativeRenderJobMaintenance } from "../contracts/creative-jobs";
import type { RenderJobRecord } from "../contracts/render-job";
import type { CreativeHostRuntime } from "./creative-host-core";
import { jobRequest } from "./creative-job-input";
import { projectArtifactBindings } from "./project-assets";
import { jobOutputOwner, jobOutputReceipt, verifyJobArtifact } from "./render-job-output";
import { activeJobStates, hasUntrackedPublication, jobFail, knownJobOutput, needsJobReconciliation,
  validateJobReceipt, validateReconciliationRequest } from "./render-job-validation";
import { hashToolInput } from "./tool-execution-store";

async function legacyOutput(runtime: CreativeHostRuntime, record: RenderJobRecord, artifactId?: string) {
  if (!artifactId) return undefined;
  const stored = await runtime.artifacts.get(artifactId);
  const provenance = stored?.provenance, input = record.input;
  if (!stored || stored.metadata?.jobId !== record.id || stored.metadata?.inputHash !== record.inputHash ||
      provenance?.projectId !== input.projectId || provenance.runId !== input.runId || provenance.callId !== input.callId ||
      provenance.toolId !== `render.${input.render.operation}` || provenance.toolVersion !== input.toolVersion ||
      provenance.parametersHash !== record.inputHash) return undefined;
  return jobOutputReceipt(record, stored.contentHash, stored.sizeBytes);
}

/** Every operation runs through host serialization with submission, publication and GC. */
export function createRenderJobMaintenance(runtime: CreativeHostRuntime): CreativeRenderJobMaintenance {
  const { jobs } = runtime;
  const requireJob = async (projectId: string, jobId: string) => {
    const entry = await jobs.inspectRetention(projectId, jobId);
    return entry ?? jobFail("RENDER_JOB_NOT_FOUND", "Job is missing or outside this project");
  };
  return {
    async inspect(projectId, jobId) {
      const entry = await jobs.inspectRetention(projectId, jobId);
      if (!entry || "prunedAt" in entry) return entry;
      const { record, retention } = entry, expected = record.input.snapshot;
      const snapshot = await runtime.projects.getSnapshot(expected.id);
      const retained = snapshot?.projectId === projectId && snapshot.contentHash === expected.contentHash &&
        snapshot.document.revisions.at(-1)?.id === expected.revisionId;
      const needsReconciliation = needsJobReconciliation(record, retention);
      const input = { retained, pinnedByJob: activeJobStates.has(record.state) || needsReconciliation,
        artifactIds: retained ? [...new Set(projectArtifactBindings(snapshot.document).map(binding => binding.artifactId))] : [] };
      const receipt = knownJobOutput(record, retention);
      const report = { ...entry, input, needsReconciliation, untrackedPublication: hasUntrackedPublication(record, retention) };
      if (!receipt) return report;

      const refs = await runtime.references(receipt.artifactId), owner = jobOutputOwner(record);
      const legacyOwner = JSON.stringify([projectId, record.input.runId, record.input.callId]);
      const referenceAttached = refs.some(ref => ref.ownerType === owner.ownerType && ref.ownerId === owner.ownerId && ref.role === owner.role);
      let availability: "verified" | "missing" | "unverified";
      try { availability = await verifyJobArtifact(runtime.artifacts, receipt) ? "verified" : "missing"; }
      catch { availability = "unverified"; }
      return { ...report, output: { receipt, availability,
        retainedByJob: !retention.release?.completedAt || referenceAttached, referenceAttached,
        legacySharedReference: refs.some(ref => ref.ownerType === "tool-run" && ref.ownerId === legacyOwner && ref.role === "host-output") } };
    },
    async reconcile(projectId, jobId, decision) {
      validateReconciliationRequest(decision);
      const entry = await requireJob(projectId, jobId);
      const prior = "prunedAt" in entry ? entry.reconciliation : entry.retention.reconciliation;
      const artifactId = decision.action === "retain-output" ? decision.artifactId : undefined;
      if (prior) {
        if (prior.action === decision.action && prior.reason === decision.reason &&
            (prior.action === "discard" || artifactId === undefined || prior.result.artifactId === artifactId)) return prior;
        return jobFail("RENDER_JOB_RECONCILIATION_CONFLICT", "Job already has a different reconciliation decision");
      }
      if ("prunedAt" in entry || !needsJobReconciliation(entry.record, entry.retention))
        return jobFail("RENDER_JOB_STATE", "Job has no unresolved terminal outcome");
      const { record, retention } = entry;
      const { action, reason } = decision;
      if (action === "discard") return jobs.reconcile(projectId, jobId, { action, reason });

      const receipt = record.publicationStartedAt
        ? retention.publication ?? await legacyOutput(runtime, record, artifactId)
        : undefined;
      if (!receipt || (artifactId !== undefined && artifactId !== receipt.artifactId))
        return jobFail("HOST_JOB_OUTPUT_UNVERIFIED", "Artifact identity is not bound to this publication");
      validateJobReceipt(receipt, record);
      if (!await verifyJobArtifact(runtime.artifacts, receipt))
        return jobFail("HOST_JOB_OUTPUT_UNVERIFIED", "Published Artifact or bytes are missing");
      await runtime.retain({ artifactId: receipt.artifactId, ...jobOutputOwner(record) });
      return jobs.reconcile(projectId, jobId, { action, reason }, receipt);
    },
    async release(projectId, jobId) {
      const entry = await requireJob(projectId, jobId);
      if ("prunedAt" in entry) return entry.release;
      const release = await jobs.releaseRetention(projectId, jobId);
      if (release.completedAt) return release;
      await runtime.releaseJobOutputs(jobOutputOwner(entry.record).ownerId);
      return jobs.releaseRetention(projectId, jobId, true);
    },
    async prune(projectId, jobId) {
      const entry = await requireJob(projectId, jobId);
      if ("prunedAt" in entry) return entry;
      return jobs.prune(projectId, jobId, hashToolInput(jobRequest(entry.record)));
    },
  };
}
