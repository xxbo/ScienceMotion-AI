import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { ToolExecutionRecord } from "../src/contracts/agent-tool";
import type { CreativeDeliveryReport, DeliverySnapshot } from "../src/contracts/creative-delivery";
import type { CreativeHost, CreativeSession, SnapshotReceipt } from "../src/contracts/creative-host";
import type { CreativePlanner, CreativePlannerContext, CreativeRunReport } from "../src/contracts/creative-planner";
import type { ProjectAsset, ProjectDocument } from "../src/contracts/project";
import type { ProjectPatchDocument, ProjectPatchOperation } from "../src/contracts/project-patch";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { verifyCreativeDelivery, verifyCreativeDeliveryRecovery } from "../src/platform/creative-delivery";
import { openCreativeHost } from "../src/platform/creative-host";
import { runCreativePlan } from "../src/platform/creative-runner";
import { pngArtifactForAsset } from "../src/platform/project-assets";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { readVerifiedJobArtifact } from "../src/platform/render-job-output";
import { hashToolInput } from "../src/platform/tool-execution-store";
import { fitPngToolId, pngFitPlugin, type FitPngInput } from "./fixtures/png-fit-plugin";
import type { WaterMotionBaseline } from "./fixtures/water-motion-baseline";

type RGB = readonly [number, number, number];
type Pixel = readonly [x: number, y: number, rgb: RGB];
type ImportResult = { asset: ProjectAsset; artifactId: string; revisionId: string };
type Scenario = { mode: "compose" } | { mode: "reject"; previousArtifactId: string } | { mode: "resume"; snapshotId: string };

const fixture = JSON.parse(await readFile("examples/water-motion-baseline.json", "utf8")) as WaterMotionBaseline;
const source = fixture.snapshot.document;
assert.equal(hashProject(source), fixture.snapshot.contentHash);
const [sequence] = source.sequences, [scene] = source.scenes, shot = source.shots![0];
const { width, height, fps, durationFrames } = sequence;
const projectId = "water-composition", assetId = "water-diagram";
const approvedId = "composed", restoredId = "restored", resumedId = "resumed";
const firstBox = { x: 64, y: 42, width: 176, height: 132 };
const secondBox = { x: 392, y: 98, width: 160, height: 124 };
const left: RGB = [44, 183, 155], right: RGB = [232, 136, 64], background: RGB = [16, 39, 64];
const firstPixels: Pixel[] = [[84, 90, left], [220, 90, right], [84, 52, background]];
const secondPixels: Pixel[] = [[416, 148, left], [530, 148, right], [416, 107, background]];
const limits = { maxTurns: 10, timeoutMs: 30_000, maxOutputBytes: 256 * 1024 };
const brief = "Fit the approved PNG onto the water-motion scene and retain a verifiable checkpoint.";
const output = resolve("out/cross-plugin-composition");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "sciencemotion-composition-"));
const directory = join(root, "workspace");
const store = new FileSystemArtifactStore(join(directory, "artifacts"));
const assetImports = ["original", "replacement"].map(sourceId => ({ projectId, sourceId, path: join(root, sourceId + ".png"), mediaType: "image/png" as const }));
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  newModelCalls: 0, projectId, baseline: { id: fixture.snapshot.id, contentHash: fixture.snapshot.contentHash } };
const seed: ProjectPatchOperation[] = [
  { op: "add-scene", scene: { ...scene, rootNodeIds: [] } },
  ...source.nodes.map((node): ProjectPatchOperation => ({ op: "add-node", sceneId: scene.id, node })),
  { op: "add-shot", sequenceId: sequence.id, shot },
  ...source.animationTracks.map((track): ProjectPatchOperation => ({ op: "put-animation-track", track })),
];
let host: CreativeHost | undefined, callCount = 0;

const save = (name: string, value: unknown) => writeFile(join(output, name + ".json"), JSON.stringify(value, null, 2) + "\n");
const revision = (document: ProjectDocument) => document.revisions.at(-1)!.id;
const authored = (document: ProjectDocument) => ({ ...document, project: { ...document.project, updatedAt: "" }, revisions: [] });
const hashBytes = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const toApproval = (snapshot: ProjectSnapshot): DeliverySnapshot =>
  ({ id: snapshot.id, revisionId: revision(snapshot.document), contentHash: snapshot.contentHash });

function png(w: number, h: number, a: RGB, b: RGB) {
  const image = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    image.data.set([...(x < w / 2 ? a : b), 255], (y * w + x) * 4);
  return PNG.sync.write(image);
}

function propose(context: CreativePlannerContext, toolId: string, input: unknown) {
  const manifest = context.catalogue.tools.find(tool => tool.id === toolId);
  assert.ok(manifest, `Expected ${toolId} in the scoped catalogue`);
  return JSON.stringify({ kind: "invoke", toolId, toolVersion: manifest.version, input });
}

function planner(scenario: Scenario): CreativePlanner {
  return { async propose(context) {
    const invoke = (toolId: string, input: unknown) => propose(context, toolId, input);
    const prior = context.observation;
    if (!prior) {
      if (scenario.mode === "compose")
        return invoke("project.create", { name: "Composed water motion", episodeId: source.editorial.episodeId, width, height, fps, durationFrames });
      if (scenario.mode === "reject") return invoke("assets.import", { sourceId: "replacement", assetId, replace: true });
      return invoke("project.snapshot.inspect", { snapshotId: scenario.snapshotId });
    }
    const { decision, result } = prior;
    if (!result.ok) {
      assert.equal(scenario.mode, "reject");
      assert.equal(decision.toolId, fitPngToolId);
      assert.equal(result.diagnostics[0]?.code, "COMPOSITION_ARTIFACT_MISMATCH");
      return JSON.stringify({ kind: "needs-input", question: "Which retained PNG binding should the composition continue from?" });
    }
    switch (decision.toolId) {
      case "project.create": {
        const { projectId, revisionId } = result.output as { projectId: string; revisionId: string };
        return invoke("project.patch.apply", { schemaVersion: "1.3.0", projectId, baseRevisionId: revisionId, patches: seed });
      }
      case "assets.import": {
        const imported = result.output as ImportResult;
        return invoke(fitPngToolId, { assetId: imported.asset.id, baseRevisionId: imported.revisionId,
          artifactId: scenario.mode === "reject" ? scenario.previousArtifactId : imported.artifactId,
          sceneId: scene.id, ...(scenario.mode === "reject"
            ? { nodeId: "second-diagram", box: secondBox }
            : { nodeId: "diagram", box: firstBox }) } satisfies FitPngInput);
      }
      case "project.snapshot.inspect": {
        const snapshot = result.output as ProjectSnapshot;
        const asset = snapshot.document.assets.find(candidate => candidate.id === assetId);
        const artifactId = pngArtifactForAsset(asset);
        assert.ok(asset && artifactId);
        return invoke(fitPngToolId, { assetId: asset.id, artifactId, baseRevisionId: revision(snapshot.document),
          sceneId: scene.id, nodeId: "second-diagram", box: secondBox } satisfies FitPngInput);
      }
      case fitPngToolId:
        return invoke("project.patch.apply", result.output);
      case "project.patch.apply": {
        const patch = decision.input as ProjectPatchDocument;
        if (patch.patches[0]?.op === "add-scene") return invoke("assets.import", { sourceId: "original", assetId });
        const { revisionId } = result.output as { revisionId: string };
        return invoke("project.snapshot.save", { snapshotId: scenario.mode === "resume" ? resumedId : approvedId, revisionId });
      }
      case "project.snapshot.save":
        return JSON.stringify({ kind: "finish", summary: `Retained ${(result.output as SnapshotReceipt).id}.` });
      default:
        throw new Error(`Unexpected observation ${decision.toolId}`);
    }
  } };
}

const editor = (host: CreativeHost) => host.createSession({ projectId,
  toolIds: ["project.create", "project.patch.apply", "assets.import", fitPngToolId, "project.snapshot.save", "project.snapshot.inspect"],
  permissions: ["project.read", "project.write", "artifact.read", "artifact.write", "snapshot.read", "snapshot.write"] });
const continuation = (host: CreativeHost) => host.createSession({ projectId,
  toolIds: ["project.patch.apply", fitPngToolId, "project.snapshot.save", "project.snapshot.inspect"],
  permissions: ["project.read", "project.write", "artifact.read", "snapshot.read", "snapshot.write"] });
const deliverySession = (host: CreativeHost) => host.createSession({ projectId,
  toolIds: ["project.snapshot.inspect", "render.preview", "render.video"], permissions: ["snapshot.read", "artifact.write"] });
const reader = (host: CreativeHost) => host.createSession({ projectId,
  toolIds: ["project.inspect", "project.snapshot.inspect", "execution.list"], permissions: ["project.read", "snapshot.read", "execution.read"] });

async function invoke<T>(session: CreativeSession, toolId: string, input: unknown = {}) {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest);
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input, runId: "verify-cross-plugin-composition", callId: `call-${++callCount}` });
  assert.ok(result.ok, `${toolId} ${JSON.stringify(result.diagnostics)}`);
  return result.output as T;
}

async function snapshot(session: CreativeSession, id: string) {
  const saved = await invoke<ProjectSnapshot>(session, "project.snapshot.inspect", { snapshotId: id });
  assert.equal(saved.id, id);
  assert.equal(saved.projectId, projectId);
  assert.equal(saved.contentHash, hashProject(saved.document));
  return saved;
}

function callAt(report: CreativeRunReport, index: number, id: string) {
  const turn = report.turns[index];
  assert.ok(turn?.decision.kind === "invoke" && turn.call?.result, `Expected a confirmed ${id} invocation in ${report.runId}`);
  assert.equal(turn.decision.toolId, id);
  return { input: turn.decision.input, result: turn.call.result, callId: turn.call.callId, version: turn.decision.toolVersion };
}

function assertPixels(bytes: Uint8Array, channels: number, samples: Pixel[], tolerance = 0) {
  assert.equal(bytes.length, width * height * channels);
  for (const [x, y, rgb] of samples) {
    const start = (y * width + x) * channels;
    const actual = Array.from(bytes.subarray(start, start + 3));
    assert.ok(actual.every((channel, i) => Math.abs(channel - rgb[i]) <= tolerance), `Pixel (${x},${y}) is ${actual}, expected ${rgb}`);
  }
}

function checkPreview(bytes: Uint8Array, samples: Pixel[]) {
  const image = PNG.sync.read(Buffer.from(bytes));
  assert.deepEqual([image.width, image.height], [width, height]);
  assertPixels(image.data, 4, samples);
}

async function preserveDelivery(label: string, report: CreativeDeliveryReport) {
  assert.deepEqual(report.range, fixture.workload.video);
  assert.equal(report.video.decoded.frames, fixture.workload.video.durationFrames);
  assert.equal(report.previews.length, 1);
  const preview = report.previews[0].job.result, video = report.video.job.result;
  assert.ok(preview && video);
  const [image, movie] = await Promise.all([readVerifiedJobArtifact(store, preview), readVerifiedJobArtifact(store, video)]);
  assert.ok(image && movie);
  checkPreview(image, firstPixels);
  const mp4 = join(output, `${label}.mp4`);
  await writeFile(join(output, `${label}.png`), image);
  await writeFile(mp4, movie);
  const frame = execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-i", mp4, "-map", "0:v:0",
    "-frames:v", "1", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
    { maxBuffer: width * height * 3 + 1024, timeout: 15_000 });
  assertPixels(frame, 3, firstPixels, 8);
  await save(label + "-delivery", report);
}

try {
  const originalBytes = png(96, 48, left, right);
  const replacementBytes = png(48, 96, [144, 112, 225], [69, 123, 216]);
  await Promise.all(assetImports.map(({ path }, index) => writeFile(path, index === 0 ? originalBytes : replacementBytes)));
  host = await openCreativeHost({ directory, assetImports, plugins: [pngFitPlugin] });
  const session = editor(host);
  const tools = (await session.discover()).tools.filter(tool => ["assets.import", fitPngToolId, "project.patch.apply"].includes(tool.id))
    .map(({ id, version, pluginId, execution }) => ({ id, version, pluginId, permissions: execution.permissions }));
  assert.equal(tools.length, 3);
  assert.equal(tools.find(tool => tool.id === "assets.import")?.pluginId, "builtin.workspace");
  assert.equal(tools.find(tool => tool.id === "project.patch.apply")?.pluginId, "builtin.workspace");
  const fit = tools.find(tool => tool.id === fitPngToolId);
  assert.equal(fit?.pluginId, pngFitPlugin.id);
  assert.deepEqual(fit.permissions, ["project.read", "artifact.read"]);
  await save("tool-identities", tools);

  const composed = await runCreativePlan(session, planner({ mode: "compose" }), { brief, limits });
  await save("composition-run", composed);
  assert.equal(composed.stop.reason, "finished", JSON.stringify(composed.stop));
  assert.equal(composed.turns.length, 7);
  const produced = callAt(composed, 2, "assets.import"), consumed = callAt(composed, 3, fitPngToolId);
  const applied = callAt(composed, 4, "project.patch.apply"), retained = callAt(composed, 5, "project.snapshot.save");
  const imported = produced.result.output as ImportResult;
  assert.ok(produced.result.ok && consumed.result.ok && applied.result.ok && retained.result.ok);
  assert.equal(imported.artifactId, hashBytes(originalBytes));
  assert.equal(produced.result.artifacts?.[0]?.id, imported.artifactId);
  assert.deepEqual(consumed.input, { assetId: imported.asset.id, artifactId: imported.artifactId, baseRevisionId: imported.revisionId,
    sceneId: scene.id, nodeId: "diagram", box: firstBox });
  assert.deepEqual(applied.input, consumed.result.output);
  const originalArtifact = await store.get(imported.artifactId);
  assert.deepEqual(originalArtifact?.provenance, { projectId, runId: composed.runId, callId: produced.callId, toolId: "assets.import",
    toolVersion: produced.version, pluginId: "builtin.workspace" });
  await writeFile(join(output, "original-source.png"), originalBytes);

  const approved = await snapshot(reader(host), approvedId);
  assert.equal(approved.contentHash, (retained.result.output as SnapshotReceipt).contentHash);
  assert.equal(revision(approved.document), (applied.result.output as { revisionId: string }).revisionId);
  assert.deepEqual(approved.document.nodes.slice(0, -1), source.nodes);
  assert.deepEqual(approved.document.animationTracks, source.animationTracks);
  const image = approved.document.nodes.find(node => node.id === "diagram");
  assert.deepEqual(image?.transform.position, [64, 64, 0]);
  assert.deepEqual(image?.components, [{ kind: "image", data: { assetId, width: 176, height: 88 } }]);
  await save("approved-snapshot", approved);
  const delivery = await verifyCreativeDelivery(deliverySession(host), store,
    { approved: toApproval(approved), range: fixture.workload.video, maxPreviewFrames: 1 });
  await preserveDelivery("approved", delivery);

  const rejected = await runCreativePlan(session, planner({ mode: "reject", previousArtifactId: imported.artifactId }), { brief, limits });
  await save("rejected-run", rejected);
  assert.equal(rejected.stop.reason, "needs-input", JSON.stringify(rejected.stop));
  assert.equal(rejected.turns.length, 3);
  const replaced = callAt(rejected, 0, "assets.import"), rejectedFit = callAt(rejected, 1, fitPngToolId);
  const replacement = replaced.result.output as ImportResult;
  assert.ok(replaced.result.ok && !rejectedFit.result.ok && rejectedFit.result.output === undefined);
  assert.equal(replacement.artifactId, hashBytes(replacementBytes));
  assert.notEqual(replacement.artifactId, imported.artifactId);
  assert.deepEqual(rejectedFit.input, { ...(consumed.input as FitPngInput), baseRevisionId: replacement.revisionId,
    nodeId: "second-diagram", box: secondBox });
  assert.deepEqual(rejectedFit.result.diagnostics, [{ level: "error", code: "COMPOSITION_ARTIFACT_MISMATCH",
    message: "The supplied PNG does not match the asset binding in this revision.",
    details: { assetId, suppliedArtifactId: imported.artifactId, expectedArtifactId: replacement.artifactId } }]);
  await writeFile(join(output, "replacement-source.png"), replacementBytes);
  const afterReject = await invoke<ProjectDocument>(reader(host), "project.inspect");
  assert.equal(revision(afterReject), replacement.revisionId);
  assert.equal(afterReject.revisions.length, approved.document.revisions.length + 1);
  assert.deepEqual(authored(afterReject), { ...authored(approved.document), assets: [replacement.asset] });
  assert.deepEqual(await snapshot(reader(host), approvedId), approved);
  await save("head-after-rejection", afterReject);

  await host.close();
  await Promise.all(assetImports.map(({ path }) => rm(path)));
  host = await openCreativeHost({ directory, plugins: [pngFitPlugin] });
  const reopened = deliverySession(host);
  for (const job of [...delivery.previews.map(item => item.job), delivery.video.job])
    assert.deepEqual(await reopened.jobs.get(job.id), job);
  const restorer = host.createSession({ projectId, toolIds: ["project.snapshot.restore", "project.snapshot.save"],
    permissions: ["project.write", "snapshot.restore", "project.read", "snapshot.write"], allowDestructive: true });
  const restoredProject = await invoke<ProjectDocument>(restorer, "project.snapshot.restore", {
    snapshotId: approved.id, baseRevisionId: replacement.revisionId, message: "Recover the retained cross-plugin composition",
  });
  assert.equal(restoredProject.revisions.at(-1)?.snapshotHash, approved.contentHash);
  assert.deepEqual(authored(restoredProject), authored(approved.document));
  const savedRestore = await invoke<SnapshotReceipt>(restorer, "project.snapshot.save", { snapshotId: restoredId, revisionId: revision(restoredProject) });
  const restored = await snapshot(reader(host), restoredId);
  assert.equal(restored.contentHash, savedRestore.contentHash);
  await save("restored-snapshot", restored);
  const recovery = await verifyCreativeDeliveryRecovery(reopened, store, { reference: delivery, restored: toApproval(restored) });
  await save("recovery", recovery);
  await preserveDelivery("restored", recovery.restored);

  const resumed = await runCreativePlan(continuation(host), planner({ mode: "resume", snapshotId: restoredId }), { brief, limits });
  await save("resumed-run", resumed);
  assert.equal(resumed.stop.reason, "finished", JSON.stringify(resumed.stop));
  assert.equal(resumed.turns.length, 5);
  const reopenedInput = callAt(resumed, 0, "project.snapshot.inspect"), resumedFit = callAt(resumed, 1, fitPngToolId);
  const resumedPatch = callAt(resumed, 2, "project.patch.apply");
  assert.deepEqual(reopenedInput.result.output, restored);
  assert.deepEqual(resumedFit.input, { ...(rejectedFit.input as FitPngInput), baseRevisionId: revision(restored.document) });
  assert.deepEqual(resumedPatch.input, resumedFit.result.output);
  const continued = await snapshot(reader(host), resumedId);
  assert.equal(revision(continued.document), (resumedPatch.result.output as { revisionId: string }).revisionId);
  assert.equal(continued.document.revisions.at(-1)?.parentRevisionId, revision(restored.document));
  const second = continued.document.nodes.find(node => node.id === "second-diagram");
  assert.deepEqual(second?.transform.position, [392, 120, 0]);
  assert.deepEqual(second?.components, [{ kind: "image", data: { assetId, width: 160, height: 80 } }]);
  assert.deepEqual(continued.document.nodes.slice(0, -1), restored.document.nodes);
  await save("resumed-snapshot", continued);
  const preview = await invoke<{ artifactId: string; metadata: { snapshotHash: string; revisionId: string } }>(reopened, "render.preview",
    { snapshotId: resumedId, frame: fixture.workload.previewFrame });
  assert.equal(preview.metadata.snapshotHash, continued.contentHash);
  assert.equal(preview.metadata.revisionId, revision(continued.document));
  const bytes = await store.read(preview.artifactId);
  assert.ok(bytes);
  assert.equal(hashBytes(bytes), preview.artifactId);
  checkPreview(bytes, [...firstPixels, ...secondPixels]);
  await writeFile(join(output, "resumed.png"), bytes);
  await save("resumed-preview", preview);

  const ledger = await invoke<ToolExecutionRecord[]>(reader(host), "execution.list");
  const matched = [composed, rejected, resumed].flatMap(report => {
    const calls = report.turns.filter(turn => turn.call);
    const records = ledger.filter(record => record.runId === report.runId);
    assert.equal(records.length, calls.length);
    for (const turn of calls) {
      assert.ok(turn.decision.kind === "invoke" && turn.call?.result);
      const record = records.find(item => item.callId === turn.call?.callId);
      assert.ok(record);
      assert.deepEqual([record.projectId, record.toolId, record.toolVersion, record.inputHash, record.status, record.result],
        [projectId, turn.decision.toolId, turn.decision.toolVersion, hashToolInput(turn.decision.input),
          turn.call.result.ok ? "succeeded" : "failed", turn.call.result]);
    }
    return records;
  });
  await save("executions", [...matched, ...ledger.filter(record => record.toolId === "project.snapshot.restore")]);
  Object.assign(evidence, { status: "passed", tools, originalArtifact, replacementArtifactId: replacement.artifactId,
    approved: toApproval(approved), restored: toApproval(restored), resumed: toApproval(continued),
    runIds: { compose: composed.runId, reject: rejected.runId, resume: resumed.runId },
    rejection: { code: "COMPOSITION_ARTIFACT_MISMATCH", callId: rejectedFit.callId, postRejectRevisionId: revision(afterReject) },
    sourcesRemovedBeforeReopen: true, comparison: recovery.comparison, matchedExecutionRecords: matched.length });
  console.log("PASS: confirmed cross-plugin PNG handoffs, stale binding rejection, checkpoint restore and resumed composition");
} catch (error) {
  Object.assign(evidence, { status: "failed", failure: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  try { await host?.close(); }
  finally {
    try { await save("evidence", evidence); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
