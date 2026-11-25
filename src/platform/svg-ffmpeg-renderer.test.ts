import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WaterMotionBaseline } from "../../scripts/fixtures/water-motion-baseline";
import type { ProjectDocument } from "../contracts/project";
import { SvgFfmpegProjectGraphRenderer } from "../renderers/svg-ffmpeg/svg-ffmpeg-project-graph-renderer";
import { hashProject } from "./project-snapshots";

const baseline = JSON.parse(readFileSync(new URL("../../examples/water-motion-baseline.json", import.meta.url), "utf8")) as WaterMotionBaseline;
const project = () => structuredClone(baseline.snapshot.document);
const request = (document = project()) => ({
  project: document, revisionId: document.revisions.at(-1)!.id, snapshotHash: hashProject(document),
  frame: baseline.workload.previewFrame,
});
const neverSpawn = new SvgFfmpegProjectGraphRenderer("unused-test-ffmpeg");
const unsupported = (message: RegExp) => ({ name: "ProjectGraphRendererError", code: "SVG_FFMPEG_UNSUPPORTED", message });

test("SVG preview rejects a different revision, altered snapshot, or out-of-range frame", async () => {
  const input = request();
  for (const altered of [{ revisionId: "other" }, { snapshotHash: "0".repeat(64) }, { frame: 80 }, { frame: 1.5 }]) {
    await assert.rejects(neverSpawn.renderPreview({ ...input, ...altered }), {
      name: "ProjectGraphRendererError", code: "SVG_FFMPEG_INVALID_REQUEST",
    });
  }
});

test("SVG preflight rejects graphics and timeline features it cannot reproduce", async () => {
  const cases: Array<[(document: ProjectDocument) => void, RegExp]> = [
    [p => { p.nodes[0].components[0].data.fill = "#10274080"; }, /opaque hex fill/],
    [p => { p.nodes[0].components[0].data.strokeWidth = 1; }, /visible stroke/],
    [p => { p.nodes[0].components[0].data.mask = "mask-id"; }, /extra geometry fields/],
    [p => { p.nodes[0].transform.rotation[2] = 1; }, /other than a 2D translation/],
    [p => { p.animationTracks[0].keyframes[1].easing = "ease-in"; }, /linear 2D position keys/],
    [p => { p.sequences[0].captions = [{ id: "caption", text: "Caption", startFrame: 12, durationFrames: 10 }]; }, /captions or transitions/],
    [p => { p.shots![0].durationFrames = 40; }, /Timeline gaps/],
  ];
  for (const [change, message] of cases) {
    const doc = project();
    change(doc);
    await assert.rejects(neverSpawn.renderPreview(request(doc)), unsupported(message));
  }
  await assert.rejects(neverSpawn.renderPreview({ ...request(), profile: { width: 640, height: 360, fps: 20 } }), unsupported(/profile.*match/));
  const odd = project();
  odd.sequences[0].width = 641;
  await assert.rejects(neverSpawn.renderVideo({ ...request(odd), startFrame: 12, durationFrames: 40 }), unsupported(/requires even/));
  await assert.rejects(neverSpawn.renderVideo({ ...request(), startFrame: 12, durationFrames: 40, audioAssets: { wav: "AA==" } }), unsupported(/media assets/));
});

test("SVG adapter distinguishes a missing binary from unsupported input", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciencemotion-ffmpeg-test-"));
  try {
    await assert.rejects(new SvgFfmpegProjectGraphRenderer(join(root, "not-installed")).renderPreview(request()), {
      name: "ProjectGraphRendererError", code: "SVG_FFMPEG_UNAVAILABLE", message: /FFmpeg executable/,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SVG adapter respects cancellation before work and after frame staging", async () => {
  const reason = new Error("Cancelled by caller");
  await assert.rejects(neverSpawn.renderPreview({ ...request(), signal: AbortSignal.abort(reason) }), error => error === reason);
  const controller = new AbortController();
  await assert.rejects(neverSpawn.renderVideo({ ...request(), startFrame: 12, durationFrames: 2, signal: controller.signal,
    onProgress: ({ phase }) => { if (phase === "encoding") controller.abort(reason); },
  }), error => error === reason);
});
