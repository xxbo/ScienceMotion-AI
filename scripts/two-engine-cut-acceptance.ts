import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { RenderJobRecord } from "../src/contracts/render-job";
import type { RetainedShotSegment } from "../src/contracts/retained-shot-segment";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import type { ProjectSnapshot } from "../src/platform/project-snapshots";
import { RetainedShotSegmentStore } from "../src/platform/retained-shot-segment";
import { assembleShotCut, assertShotCutFrames, locateShotCutFrame } from "../src/platform/shot-cut";
import { replayProfile as profile, replayRange as range } from "./fixtures/pendulum-replay-project";

const input = resolve("out/retained-shot-segments"), output = resolve("out/two-engine-cut");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const get = async <T>(file: string) => JSON.parse(await readFile(join(input, file), "utf8")) as T;
const save = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n");
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running" };
const engines = ["remotion", "three"] as const;
const names = ["remotion.pendulum-replay", "three-js-pendulum-replay"];
type Entry = {
  engine: string; id: string; descriptorFile: string; mediaFile: string; descriptor: RetainedShotSegment;
  decodedRgbHash: string; receipt: RenderJobRecord;
};

function previewRgbHash(bytes: Buffer) {
  const png = PNG.sync.read(bytes);
  assert.deepEqual([png.width, png.height], [profile.width, profile.height]);
  const rgb = Buffer.alloc(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    assert.equal(png.data[i + 3], 255);
    rgb[j] = png.data[i]; rgb[j + 1] = png.data[i + 1]; rgb[j + 2] = png.data[i + 2];
  }
  return sha(rgb);
}

await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "sciencemotion-two-engine-cut-"));
try {
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.checkout = checkout;
  const snapshotBytes = await readFile(join(input, "source-snapshot.json"));
  const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as ProjectSnapshot;
  const a = await get<{ checkout: string; status: string; profile: typeof profile; range: typeof range; segments: Entry[] }>("evidence.json");
  assert.deepEqual([a.checkout, a.status, a.profile, a.range, a.segments.map(row => row.engine)],
    [checkout, "passed", profile, range, engines]);
  const artifactPath = join(work, "artifacts"), referencePath = join(work, "references");
  const openSegments = () => {
    const artifacts = new FileSystemArtifactStore(artifactPath);
    const refs = new FileSystemArtifactReferenceStore(referencePath);
    return new RetainedShotSegmentStore(artifacts, new LocalArtifactLifecycleManager(artifacts, refs));
  };
  const artifacts = new FileSystemArtifactStore(artifactPath), writer = openSegments();
  const inputs = [];
  for (const [index, engine] of engines.entries()) {
    const delivery = a.segments[index], descriptorFile = engine + "-segment.json", mediaFile = engine + ".mp4";
    assert.deepEqual([delivery.descriptorFile, delivery.mediaFile], [descriptorFile, mediaFile]);
    const [descriptor, video] = await Promise.all([readFile(join(input, descriptorFile)), readFile(join(input, mediaFile))]);
    assert.deepEqual(JSON.parse(descriptor.toString("utf8")), delivery.descriptor);
    assert.equal(delivery.descriptor.source.snapshot.artifactId, "sha256:" + sha(snapshotBytes));
    assert.equal("sha256:" + sha(descriptor), delivery.id);
    assert.deepEqual([delivery.descriptor.renderer.id, sha(video)], [names[index], delivery.descriptor.media.contentHash]);
    await artifacts.put({ bytes: video, kind: "video", mediaType: "video/mp4" });
    // Recover the existing A segment identities from the archived receipts and bytes,
    // not from another engine render or a new hand-authored cut fixture.
    const retained = await writer.retain(snapshot, delivery.receipt);
    assert.deepEqual([retained.record.id, retained.segment, retained.decodedRgbHash],
      [delivery.id, delivery.descriptor, delivery.decodedRgbHash]);
    inputs.push({ id: delivery.id, mediaHash: sha(video), engine, renderer: retained.segment.renderer });
  }
  assert.notEqual(inputs[0].id, inputs[1].id);
  const reader = openSegments(), ids = inputs.map(row => row.id);
  const { bytes, report } = await assembleShotCut(reader, ids);
  const { plan, verification } = report, { before, after } = verification.seam;
  assert.deepEqual(plan.spans.map(span => span.segmentId), ids);
  assert.deepEqual(plan.spans.map(span => span.output), [{ startFrame: 0, durationFrames: 89 }, { startFrame: 89, durationFrames: 89 }]);
  assert.deepEqual([plan.profile, plan.durationFrames, report.media.frameCount, report.media.durationSeconds], [profile, 178, 178, 7.12]);
  assert.deepEqual([before.outputFrame, before.sourceFrame, after.outputFrame, after.sourceFrame], [88, 95, 89, 7]);
  assert.equal(locateShotCutFrame(plan, 0).sourceFrame, 7);
  assert.equal(locateShotCutFrame(plan, 177).sourceFrame, 95);
  assert.notEqual(before.rgbHash, after.rgbHash);
  assert.equal(report.media.contentHash, sha(bytes));
  const duplicated = [...verification.rgbFrameHashes];
  duplicated[after.outputFrame] = before.rgbHash;
  assert.throws(() => assertShotCutFrames(plan, [verification.rgbFrameHashes.slice(0, 89), verification.rgbFrameHashes.slice(89)], duplicated),
    /output frame 89/);
  for (const origin of inputs) assert.equal(sha((await reader.read(origin.id)).videoBytes), origin.mediaHash);

  const path = join(work, "cut.mp4");
  await writeFile(path, bytes);
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-protocol_whitelist", "file,pipe", "-threads", "1",
    "-i", path, "-map", "0:v:0", "-vf", "select=eq(n\\,88)+eq(n\\,89)", "-frames:v", "2", "-fps_mode", "passthrough",
    "-c:v", "png", "-threads", "1", "-pix_fmt", "rgb24", "-start_number", "0", join(work, "seam-%d.png")], { timeout: 15_000 });
  const previews = [];
  for (const [index, frame] of [before, after].entries()) {
    const png = await readFile(join(work, "seam-" + index + ".png")), file = index === 0 ? "before-cut.png" : "after-cut.png";
    assert.equal(previewRgbHash(png), frame.rgbHash);
    await writeFile(join(output, file), png);
    previews.push({ file, frame, contentHash: sha(png) });
  }
  await Promise.all([writeFile(join(output, "two-engine-cut.mp4"), bytes), save("cut.json", report)]);
  evidence.inputs = inputs;
  evidence.media = report.media;
  evidence.seam = verification.seam;
  evidence.previews = previews;
  evidence.controls = { duplicatedSeamFrameRejected: after.outputFrame, inputBytesUnchanged: true };
  evidence.status = "passed";
  console.log("Verified the 178-frame stream-copy cut. Frame 88 is Remotion source frame 95. Frame 89 is Three.js source frame 7.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await save("evidence.json", evidence); }
  finally { await rm(work, { recursive: true, force: true }); }
}
