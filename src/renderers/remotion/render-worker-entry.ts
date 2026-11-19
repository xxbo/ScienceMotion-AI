import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderWorkerJob } from "../../contracts/render-worker";
import type { ProjectGraphLayoutRequest, ProjectGraphPreviewRequest, ProjectGraphRenderProgress, ProjectGraphVideoRequest } from "../../contracts/renderer";
import { hashProject } from "../../platform/project-snapshots";
import { RemotionProjectGraphRenderer } from "./remotion-project-graph-renderer";
import { PreparedBundleError, stagePreparedRenderBundle } from "./prepared-render-bundle";

// Parent/guardian own deadlines and descendant cleanup; IPC loss also ends normal workers.
process.on("disconnect", () => process.exit(1));
const directory = process.argv[2];
const boundedTemporaryStorage = process.env.SCIENCEMOTION_BOUNDED_TEMPORARY === "1";
let job: RenderWorkerJob | undefined;
const send = (message: Record<string, unknown>, exitCode?: number) => {
  if (!process.send) process.exit(1);
  process.send({ protocolVersion: "1.0.0", jobId: job?.jobId, ...message }, (error) => {
    if (error) process.exit(1);
    if (exitCode !== undefined) process.exit(exitCode);
  });
};
try {
  const input = join(directory, "request.json");
  if ((await stat(input)).size > 12 * 1024 * 1024) throw new Error("Worker request too large");
  job = JSON.parse(await readFile(input, "utf8")) as RenderWorkerJob;
  if (job.protocolVersion !== "1.0.0" || !["preview", "video", "layout"].includes(job.operation) ||
      hashProject(job.request.project) !== job.request.snapshotHash || job.request.project.revisions.at(-1)?.id !== job.request.revisionId)
    throw new Error("Worker request snapshot identity/integrity mismatch");
  send({ type: "ready" });
  let lastProgressAt = 0, lastPhase = "";
  const onProgress = (progress: ProjectGraphRenderProgress) => {
    const now = Date.now();
    if (progress.phase !== lastPhase || now - lastProgressAt >= 100) { lastPhase = progress.phase; lastProgressAt = now; send({ type: "progress", ...progress }); }
  };
  const preparedBundle = job.preparedBundle;
  const load = preparedBundle && (() => stagePreparedRenderBundle(preparedBundle, join(tmpdir(), "sciencemotion-prepared-bundle")));
  const renderer = new RemotionProjectGraphRenderer(job.entryPoint, boundedTemporaryStorage, load), request = { ...job.request, onProgress };
  const bytes = job.operation === "layout" ? Buffer.from(JSON.stringify(await renderer.measureLayout(request as ProjectGraphLayoutRequest)))
    : Buffer.from((await (job.operation === "preview" ? renderer.renderPreview(request as ProjectGraphPreviewRequest) : renderer.renderVideo(request as ProjectGraphVideoRequest))).bytes);
  if (!bytes.length || bytes.length > job.maxOutputBytes) { send({ type: "error", code: "RENDER_WORKER_OUTPUT_LIMIT", message: "Worker output exceeds its byte limit" }, 1); }
  else {
    await writeFile(join(directory, "output.bin"), bytes, { flag: "wx", mode: 0o600 });
    send({ type: "result", operation: job.operation, projectId: job.request.project.project.id, revisionId: job.request.revisionId,
      snapshotHash: job.request.snapshotHash, rendererId: renderer.id, rendererVersion: renderer.version, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }, 0);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const noSpace = (error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC" || /\bENOSPC\b|No space left on device/i.test(message);
  const code = boundedTemporaryStorage && noSpace ? "RENDER_WORKER_TEMPORARY_LIMIT"
    : error instanceof PreparedBundleError ? "RENDER_WORKER_BUNDLE_INVALID" : "RENDER_WORKER_EXECUTION_FAILED";
  send({ type: "error", code, message: message.slice(0, 2048) }, 1);
}
