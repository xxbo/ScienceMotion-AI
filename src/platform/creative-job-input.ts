import type { CreativeJobPolicy, CreativeJobSubmission } from "../contracts/creative-jobs";
import type { RenderJobRecord, RenderJobSubmission } from "../contracts/render-job";
import type { ProjectSnapshot } from "./project-snapshots";
import { hashProject } from "./project-snapshots";
import { projectArtifactBindings } from "./project-assets";
import { jobCopy, jobFail, jobIdentity, jobInteger, jobObject, validateJobSubmission } from "./render-job-validation";

export function creativeJobPolicy(input: Partial<CreativeJobPolicy> = {}): CreativeJobPolicy {
  jobObject(input, ["maxActiveJobs", "timeoutMs"]);
  const policy = { maxActiveJobs: input.maxActiveJobs ?? 8, timeoutMs: input.timeoutMs ?? 30000 };
  jobInteger(policy.maxActiveJobs, 1, 32); jobInteger(policy.timeoutMs, 1, 300000); return policy as CreativeJobPolicy;
}
export function parseJobSubmission(value: CreativeJobSubmission): CreativeJobSubmission {
  const request = jobCopy(value);
  jobObject(request, ["submissionId", "runId", "callId", "toolId", "toolVersion", "input"]);
  for (const value of [request.submissionId, request.runId, request.callId, request.toolVersion]) jobIdentity(value);
  if (!["render.preview", "render.video"].includes(request.toolId)) jobFail("HOST_JOB_TOOL_UNSUPPORTED", "Jobs support the built-in preview/video operations only");
  jobObject(request.input, request.toolId === "render.preview" ? ["snapshotId", "frame", "sceneId"] : ["snapshotId", "startFrame", "durationFrames", "sceneId"]);
  jobIdentity(request.input.snapshotId);
  if (request.input.sceneId !== undefined) jobIdentity(request.input.sceneId);
  if (request.toolId === "render.preview") jobInteger(request.input.frame);
  else { jobInteger(request.input.startFrame); jobInteger(request.input.durationFrames, 1, 900); jobInteger(request.input.startFrame + request.input.durationFrames); }
  return request;
}
export function jobRequest(record: RenderJobRecord): CreativeJobSubmission {
  const { submissionId, runId, callId, toolVersion, snapshot, render } = record.input;
  const { operation, ...parameters } = render;
  return { submissionId, runId, callId, toolVersion, toolId: `render.${operation}`, input: { snapshotId: snapshot.id, ...parameters } } as CreativeJobSubmission;
}
export function resolvedJobInput(projectId: string, request: CreativeJobSubmission, saved: ProjectSnapshot,
  renderer: RenderJobSubmission["renderer"]): RenderJobSubmission {
  if (saved.projectId !== projectId || saved.document.project.id !== projectId || saved.id !== request.input.snapshotId)
    jobFail("HOST_SNAPSHOT_DENIED", "Snapshot is outside this session or missing");
  if (saved.schemaVersion !== saved.document.schemaVersion || hashProject(saved.document) !== saved.contentHash)
    jobFail("HOST_SNAPSHOT_CORRUPT", "Snapshot content differs from its retained identity");
  // External mutable assets cannot satisfy this API's retained-input contract.
  if (projectArtifactBindings(saved.document).length !== saved.document.assets.length)
    jobFail("HOST_JOB_ASSET_UNRETAINED", "Background jobs require local content-addressed assets");
  const sequence = saved.document.sequences[0], revisionId = saved.document.revisions.at(-1)?.id;
  if (!sequence || !revisionId) return jobFail("HOST_SNAPSHOT_INVALID", "Snapshot has no sequence/revision");
  const sceneId = request.input.sceneId;
  if (sceneId !== undefined && !saved.document.scenes.some(scene => scene.id === sceneId)) jobFail("HOST_RENDER_SCENE_INVALID", "Scene is outside the snapshot");
  const render: RenderJobSubmission["render"] = request.toolId === "render.preview"
    ? { operation: "preview", frame: request.input.frame, ...(sceneId ? { sceneId } : {}) }
    : { operation: "video", startFrame: request.input.startFrame, durationFrames: request.input.durationFrames, ...(sceneId ? { sceneId } : {}) };
  const end = render.operation === "preview" ? render.frame + 1 : render.startFrame + render.durationFrames;
  if (end > sequence.durationFrames) jobFail("HOST_RENDER_RANGE_INVALID", "Job frames exceed the snapshot sequence");
  const input: RenderJobSubmission = { projectId, submissionId: request.submissionId, runId: request.runId, callId: request.callId,
    toolVersion: request.toolVersion, snapshot: { id: saved.id, revisionId, contentHash: saved.contentHash }, render,
    profile: { width: sequence.width, height: sequence.height, fps: sequence.fps }, renderer: structuredClone(renderer) };
  validateJobSubmission(input); return input;
}
