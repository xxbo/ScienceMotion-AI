import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProjectDocument } from "../contracts/project";
import { ProjectGraphRendererError } from "../contracts/renderer";
import { ThreeJsProjectGraphRenderer } from "../renderers/three/three-project-graph-renderer";
import { hashProject } from "./project-snapshots";

const fixture = () => JSON.parse(readFileSync("examples/three-static-scene.json", "utf8")) as ProjectDocument;
const base = (project: ProjectDocument) => ({ project, revisionId: project.revisions.at(-1)!.id, snapshotHash: hashProject(project) });
// Early rejections must never attempt to load this entry point or the encoder.
const renderer = new ThreeJsProjectGraphRenderer({ entryPoint: "/invalid/three-entry.tsx", ffmpegPath: "/invalid/ffmpeg" });

test("Three.js adapter runs the immutable static preflight before starting a browser or encoder", async () => {
  const project = fixture();
  project.animationTracks.push({ id: "camera-keys", targetNodeId: "view-camera", targetProperty: "transform.position", keyframes: [{ frame: 0, value: [0, 2.3, 8] }] });
  const stages: string[] = [];
  const onProgress = (event: { phase: string }) => { stages.push(event.phase); };
  for (const attempt of [() => renderer.renderPreview({ ...base(project), frame: 24, onProgress }),
    () => renderer.renderVideo({ ...base(project), startFrame: 0, durationFrames: 48, onProgress })]) {
    await assert.rejects(attempt, error => {
      assert.ok(error instanceof ProjectGraphRendererError);
      assert.equal(error.code, "THREE_STATIC_UNSUPPORTED_ANIMATION");
      assert.match(error.message, /view-camera.*\/project\/animationTracks\/0/);
      return true;
    });
  }
  assert.equal(stages.length, 0);
});

test("Three.js adapter checks browser and video output limits before rendering", async () => {
  const stages: string[] = [];
  const onProgress = (event: { phase: string }) => { stages.push(event.phase); };
  const odd = fixture(); odd.sequences[0].width = 641;
  await assert.rejects(() => renderer.renderVideo({ ...base(odd), startFrame: 0, durationFrames: 48, onProgress }),
    { code: "THREE_STATIC_UNSUPPORTED_OUTPUT", message: /even dimensions/ });
  const oversized = fixture(); oversized.sequences[0].height = 7681;
  await assert.rejects(() => renderer.renderPreview({ ...base(oversized), frame: 24, onProgress }),
    { code: "THREE_STATIC_UNSUPPORTED_OUTPUT", message: /7680/ });
  assert.equal(stages.length, 0);
});

test("Three.js adapter preserves a cancellation reason and does not start work for a cancelled request", async () => {
  const stop = new Error("Cancel before launching a browser");
  const stages: string[] = [];
  await assert.rejects(() => renderer.renderPreview({ ...base(fixture()), frame: 24, signal: AbortSignal.abort(stop),
    onProgress: event => { stages.push(event.phase); } }), error => error === stop);
  assert.equal(stages.length, 0);
  const controller = new AbortController();
  await assert.rejects(() => renderer.renderVideo({ ...base(fixture()), startFrame: 0, durationFrames: 48, signal: controller.signal,
    onProgress: event => { stages.push(event.phase); controller.abort(stop); } }), error => error === stop);
  assert.deepEqual(stages, ["bundling"]);
});
