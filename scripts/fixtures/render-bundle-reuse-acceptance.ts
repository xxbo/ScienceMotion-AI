import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectDocument } from "../../src/contracts/project";
import type { RenderWorkerEvent } from "../../src/contracts/render-worker";
import { hashProject } from "../../src/platform/project-snapshots";
import { LocalRenderWorker } from "../../src/platform/render-worker";
import { prepareRenderBundle, stagePreparedRenderBundle } from "../../src/renderers/remotion/prepared-render-bundle";

const output = resolve("out/render-bundle-reuse");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-bundle-acceptance-"));
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0" };
let worker: LocalRenderWorker | undefined;
try {
  const { project } = JSON.parse(await readFile("examples/project-graph-demo.props.json", "utf8")) as { project: ProjectDocument };
  const alternate = structuredClone(project);
  alternate.project.id = "e2-alternate-project";
  const label = alternate.nodes.find(node => node.id === "title")?.components.find(component => component.kind === "text");
  assert.ok(label && label.kind === "text");
  label.data.text = "Alternate snapshot";
  const requests = [project, alternate].map(project => ({
    project, snapshotHash: hashProject(project), revisionId: project.revisions.at(-1)!.id, frame: 45,
    profile: { width: 1920, height: 1080, fps: 30 },
  }));
  const preparedBundle = await prepareRenderBundle(resolve("src/index.ts"), join(root, "prepared"));
  const events: RenderWorkerEvent[] = [];
  const renderer = worker = new LocalRenderWorker({ temporaryDirectory: root,
    policy: { maxConcurrentJobs: 2, preparedBundle }, onEvent: event => events.push(event) });
  const noJobs = async () => {
    assert.equal(renderer.status().activeJobs, 0);
    assert.deepEqual(await readdir(root), ["prepared"]);
  };
  const [first, second] = await Promise.all(requests.map(request => renderer.renderPreview(request)));
  assert.notDeepEqual(first.bytes, second.bytes);
  const started = events.filter(event => event.state === "starting");
  assert.equal(started.length, 2);
  assert.equal(new Set(started.map(event => event.processId)).size, 2);
  assert.deepEqual(new Set(started.map(event => event.snapshotHash)), new Set(requests.map(request => request.snapshotHash)));
  assert.ok(events.indexOf(started[1]) < events.findIndex(event => event.state === "completed"));
  await noJobs();
  const invalid = { code: "RENDER_WORKER_BUNDLE_INVALID" };
  for (const name of ["bundle.js", "favicon.ico"]) {
    const path = join(preparedBundle.directory, name);
    const original = await readFile(path), changed = Buffer.from(original);
    changed[0] ^= 1;
    await writeFile(path, changed);
    try { await assert.rejects(renderer.renderPreview(requests[0]), invalid); }
    finally { await writeFile(path, original); }
    await noJobs();
  }
  const link = join(preparedBundle.directory, "linked.js");
  await symlink("bundle.js", link);
  try { await assert.rejects(renderer.renderPreview(requests[0]), invalid); }
  finally { await rm(link); }
  const oversized = join(preparedBundle.directory, "oversized.asset");
  await writeFile(oversized, "");
  await truncate(oversized, 128 * 1024 * 1024 + 1);
  try { await assert.rejects(renderer.renderPreview(requests[0]), invalid); }
  finally { await rm(oversized); }
  const runtime = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  try {
    Object.defineProperty(process.versions, "node", { value: "0.0.0" });
    await assert.rejects(stagePreparedRenderBundle(preparedBundle, join(root, "version-check")), /runtime identity mismatch/);
  } finally { Object.defineProperty(process.versions, "node", runtime); }
  await noJobs();
  const cancellation = new AbortController();
  await assert.rejects(renderer.renderPreview({ ...requests[0], signal: cancellation.signal,
    onProgress: progress => { if (progress.phase === "bundling") cancellation.abort(); } }), { code: "RENDER_WORKER_CANCELLED" });
  await noJobs();
  for (const [index, result] of [first, second].entries())
    assert.deepEqual((await renderer.renderPreview(requests[index])).bytes, result.bytes);
  await noJobs();
  Object.assign(evidence, { status: "passed", bundleSha256: preparedBundle.sha256,
    parallelPreviews: started.map(event => ({
      projectId: event.projectId, snapshotHash: event.snapshotHash, processId: event.processId,
      // Events and requests can arrive in either order when the workers start concurrently.
      previewSha256: createHash("sha256").update((event.projectId === project.project.id ? first : second).bytes).digest("hex"),
    })),
    rejected: ["changed-code", "changed-asset", "symlink", "oversized", "changed-runtime"],
    cancelledDuringBundleStage: true, recoveredBothPreviews: true });
  console.log("PASS: parallel snapshots, bundle invalidation, staging limits and recovery");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await worker?.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(join(output, "acceptance.json"), JSON.stringify(evidence, null, 2) + "\n");
}
