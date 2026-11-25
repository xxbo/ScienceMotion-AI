import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeHost } from "../src/contracts/creative-host";
import type { FollowPathParameters, ProjectDocument, SceneNode } from "../src/contracts/project";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { openCreativeHost } from "../src/platform/creative-host";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { derivePendulumPathReference } from "./fixtures/pendulum-path-reference";
import type { PendulumReference } from "./fixtures/pendulum-reference";

type MotionResult = { revisionId: string; changedConstraintIds: string[]; changedNodeIds: string[] };
type Receipt = { artifactId: string; contentHash: string; mediaType: string; metadata: Record<string, unknown> };
const output = resolve("out/pendulum-motion-edit");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-motion-edit-"));
const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const revision = (p: ProjectDocument) => p.revisions.at(-1)!.id;
const motion = { constraintId: "edit-probe-motion", followerNodeId: "edit-probe-dot", guideNodeId: "edit-probe-guide" };
const controlPath = "M0 0 H96", editedPath = "M0 0 L40 30 H96";
const keys = (end: number) => [{ frame: 0, value: 0 }, { frame: end, value: 1 }];
const frame = 24, amber = [255, 189, 86, 255];
const crop = { left: 30, top: 199, right: 154, bottom: 258 }; // Half-open pixels covering only the test guide and dot.
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", motion, frame, crop, rgba: amber };
let host: CreativeHost | undefined;

function probeNode(id: string, type: SceneNode["type"], position: SceneNode["transform"]["position"], data: Record<string, unknown>): SceneNode {
  return { id, name: id, type, transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ kind: "geometry", data }] };
}

function scan(png: PNG, baseline: PNG | undefined) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, matching = 0, changedInside = 0, changedOutside = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const offset = 4 * (y * png.width + x);
    const inside = x >= crop.left && x < crop.right && y >= crop.top && y < crop.bottom;
    if (baseline && !png.data.subarray(offset, offset + 4).equals(baseline.data.subarray(offset, offset + 4))) {
      if (inside) changedInside++; else changedOutside++;
    }
    if (!amber.every((value, channel) => value === png.data[offset + channel])) continue;
    assert.ok(inside, "The probe must not leak into the unedited pendulum artwork");
    matching++;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  assert.ok(matching > 100 && matching <= 155 && x1 - x0 < 14 && y1 - y0 < 14, "Exactly one visible 14 px amber dot is required");
  if (baseline) assert.ok(changedInside > 100 && changedOutside === 0, "Only the probe pixels may change");
  return { center: [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2], matching, changedInside, changedOutside };
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const reference = JSON.parse(await readFile("examples/pendulum-motion-reference.json", "utf8")) as PendulumReference;
  const frozen = derivePendulumPathReference(reference).snapshot;
  const { projectId, document } = frozen, { profile } = reference.workload, sceneId = document.scenes[0].id;
  evidence.reference = { id: reference.snapshot.id, contentHash: reference.snapshot.contentHash };
  evidence.pathReference = { id: frozen.id, contentHash: frozen.contentHash };
  evidence.profile = profile;
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  try {
    await workspace.create(document);
    assert.deepEqual(await workspace.saveSnapshot(projectId, revision(document), { id: frozen.id, createdAt: frozen.createdAt }), frozen);
  } finally { await workspace.close(); }
  host = await openCreativeHost({ directory });
  const session = host.createSession({ projectId, permissions: ["project.read", "project.write", "artifact.read", "snapshot.write", "snapshot.read", "artifact.write", "execution.read"],
    toolIds: ["project.patch.apply", "project.inspect", "animation.path.bind", "animation.path.edit", "project.snapshot.save", "project.snapshot.inspect", "render.preview", "execution.list"] });
  let calls = 0;
  async function call(toolId: string, input: object) {
    const tool = await session.manifest(toolId);
    assert.ok(tool);
    const callId = `call-${++calls}`;
    const result = await session.invoke({ toolId, toolVersion: tool.version, input, runId: "p2-1-c-motion-edit", callId });
    return { callId, result };
  }
  async function invoke<T>(toolId: string, input: object) {
    const { result } = await call(toolId, input);
    assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
    return result.output as T;
  }
  const inspect = () => invoke<ProjectDocument>("project.inspect", {});
  const inspectSnapshot = (snapshotId: string) => invoke<ProjectSnapshot>("project.snapshot.inspect", { snapshotId });
  const save = async (name: string, revisionId: string) => {
    const snapshotId = `pendulum-edit-${name}`;
    const receipt = await invoke<Omit<ProjectSnapshot, "document">>("project.snapshot.save", { revisionId, snapshotId });
    const snapshot = await inspectSnapshot(snapshotId);
    assert.equal(revision(snapshot.document), revisionId);
    assert.equal(snapshot.contentHash, hashProject(snapshot.document));
    assert.deepEqual(receipt, { id: snapshotId, projectId, schemaVersion: snapshot.schemaVersion, createdAt: snapshot.createdAt, contentHash: snapshot.contentHash });
    await writeFile(join(output, `${name}.json`), JSON.stringify(snapshot, null, 2) + "\n");
    return snapshot;
  };
  function checkScoped(previous: ProjectSnapshot, next: ProjectSnapshot, change: (target: ProjectDocument) => void) {
    const expected = structuredClone(previous.document);
    assert.deepEqual(next.document.revisions.slice(0, -1), expected.revisions);
    assert.equal(next.document.revisions.at(-1)?.parentRevisionId, revision(expected));
    assert.notEqual(next.contentHash, previous.contentHash);
    expected.revisions = next.document.revisions;
    expected.project.updatedAt = next.document.project.updatedAt;
    change(expected);
    assert.deepEqual(next.document, expected);
  }

  // Add an independent probe to the spare area of the diagram, leaving B's pendulum and its path alone.
  const guide = probeNode(motion.guideNodeId, "path", [42, 214, 0], { pathData: controlPath, fill: "transparent", stroke: "#819ab9", strokeWidth: 2, width: 98, height: 38 });
  const dot = probeNode(motion.followerNodeId, "shape", [35, 207, 0], { primitive: "circle", width: 14, height: 14, fill: "#ffbd56" });
  const setup = await invoke<{ revisionId: string }>("project.patch.apply", { schemaVersion: "1.3.0", projectId, baseRevisionId: revision(document),
    patches: [guide, dot].map(node => ({ op: "add-node", sceneId, node })) });
  const bound = await invoke<MotionResult>("animation.path.bind", { ...motion, baseRevisionId: setup.revisionId, keyframes: keys(48), anchor: [7, 7] });
  assert.deepEqual(bound, { revisionId: bound.revisionId, changedConstraintIds: [motion.constraintId], changedNodeIds: [] });
  const before = await save("before", bound.revisionId);
  assert.deepEqual(before.document.nodes.slice(0, document.nodes.length), document.nodes);
  assert.deepEqual(before.document.constraints.slice(0, document.constraints.length), document.constraints);

  const edit = (baseRevisionId: string, changes: object) => ({ baseRevisionId, constraintId: motion.constraintId, changes });
  const path = await invoke<MotionResult>("animation.path.edit", edit(bound.revisionId, { pathData: editedPath }));
  assert.deepEqual(path, { revisionId: path.revisionId, changedConstraintIds: [motion.constraintId], changedNodeIds: [guide.id] });
  const reshaped = await save("path", path.revisionId);
  checkScoped(before, reshaped, target => { target.nodes.find(node => node.id === guide.id)!.components[0].data.pathData = editedPath; });

  const rejections = [];
  for (const { input, code, extra } of [
    { input: edit(path.revisionId, { pathData: "M0 0 Q40 30 96 30" }), code: "FOLLOW_PATH_GUIDE_INVALID", extra: motion },
    { input: edit(path.revisionId, { pathData: controlPath, keyframes: keys(121) }), code: "FOLLOW_PATH_TIMING_INVALID", extra: { ...motion, frame: 121, durationFrames: 120 } },
    { input: edit(bound.revisionId, { keyframes: keys(24) }), code: "PROJECT_REVISION_CONFLICT", extra: { constraintId: motion.constraintId, expectedRevisionId: bound.revisionId, currentRevisionId: path.revisionId } },
  ]) {
    const { callId, result } = await call("animation.path.edit", input);
    assert.equal(result.ok, false);
    assert.notEqual(result.metadata?.outcomeUnknown, true);
    assert.equal(result.diagnostics[0]?.code, code);
    assert.deepEqual(result.diagnostics[0]?.details, extra);
    const afterRejectedEdit = await inspect();
    assert.equal(revision(afterRejectedEdit), path.revisionId);
    assert.equal(hashProject(afterRejectedEdit), reshaped.contentHash);
    rejections.push({ callId, input, diagnostic: result.diagnostics[0], revisionId: path.revisionId, contentHash: reshaped.contentHash });
  }
  const timing = await invoke<MotionResult>("animation.path.edit", edit(path.revisionId, { keyframes: keys(24) }));
  assert.deepEqual(timing, { revisionId: timing.revisionId, changedConstraintIds: [motion.constraintId], changedNodeIds: [] });
  const retimed = await save("timing", timing.revisionId);
  checkScoped(reshaped, retimed, target => {
    (target.constraints.find(item => item.id === motion.constraintId)!.parameters as FollowPathParameters).progress.keyframes = keys(24);
  });
  evidence.edits = { bound, path, timing };

  let baseline: PNG | undefined;
  const previews = [];
  for (const { name, snapshot, expected } of [
    { name: "before", snapshot: before, expected: [90, 214] },
    { name: "path", snapshot: reshaped, expected: [85, 244] }, // 53 px along a 50 px diagonal and a 56 px horizontal segment.
    { name: "timing", snapshot: retimed, expected: [138, 244] },
  ]) {
    const snapshotId = snapshot.id, revisionId = revision(snapshot.document);
    const receipt = await invoke<Receipt>("render.preview", { snapshotId, frame });
    assert.equal(receipt.mediaType, "image/png");
    assert.deepEqual(receipt.metadata, { snapshotId, snapshotHash: snapshot.contentHash, revisionId, frame, ...profile,
      rendererId: "remotion.project-graph", rendererVersion: "1.0.0" });
    const bytes = await artifacts.read(receipt.artifactId);
    assert.ok(bytes);
    assert.equal(digest(bytes), receipt.contentHash);
    assert.equal(receipt.artifactId, `sha256:${receipt.contentHash}`);
    const png = PNG.sync.read(Buffer.from(bytes));
    assert.deepEqual([png.width, png.height], [profile.width, profile.height]);
    const measured = scan(png, baseline);
    assert.deepEqual(measured.center, expected);
    baseline ??= png;
    const file = `${name}.png`;
    await writeFile(join(output, file), bytes);
    previews.push({ file, snapshot: `${name}.json`, expected, measured, receipt, rgbaHash: digest(png.data) });
  }
  for (const retained of [frozen, before, reshaped, retimed]) assert.deepEqual(await inspectSnapshot(retained.id), retained);
  const executions = await invoke<ToolExecutionRecord[]>("execution.list", {});
  evidence.rejections = rejections.map(rejection => {
    const record = executions.find(execution => execution.callId === rejection.callId);
    assert.ok(record);
    assert.equal(record.status, "failed");
    assert.equal(record.errorCode, rejection.diagnostic.code);
    assert.deepEqual(record.result?.diagnostics, [rejection.diagnostic]);
    assert.notEqual(record.result?.metadata?.outcomeUnknown, true);
    return { ...rejection, record };
  });
  evidence.previews = previews;
  evidence.status = "passed";
  console.log("Verified the shared pendulum canvas with three Remotion previews. Only the targeted motion probe moved; all three rejections preserved the revision and content hash.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n"); }
  finally {
    try { await host?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
