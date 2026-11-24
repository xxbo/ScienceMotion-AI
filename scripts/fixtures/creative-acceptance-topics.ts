import assert from "node:assert/strict";
import type { CreativePlanner, CreativePlannerContext } from "../../src/contracts/creative-planner";
import type { CreativeRepairPlannerContext } from "../../src/contracts/creative-repair";
import type { TimelinePatchOperation } from "../../src/contracts/project-patch";
import { creativeLoopTopics } from "./creative-loop-topics";

export const profile = { width: 640, height: 360, fps: 10 };
export const cutFrame = 80, durationFrames = cutFrame * 2, keyFrame = 40;
export const markerId = "marker", trackId = "marker-motion", draftId = "draft";
export const voice = {
  source: "docs/showcase/cpu-cache-30s.mp4",
  sourceId: "approved-voice",
  assetId: "narration",
  sourceStartSeconds: 6.2,
  startFrame: 2,
  durationFrames: 156,
  firstCaption: "数据在缓存里，就是命中，沿近路返回。\n找不到，就要继续向下查找，必要时访问内存。",
  secondCaption: "缓存有效，靠的是局部性\n刚用过的数据可能再用，相邻的数据也常被连续访问。",
};

export const acceptanceTopics = creativeLoopTopics.filter(({ id }) => id === "cache-loop" || id === "water-loop")
  .map(({ id, name, brief }) => ({ id, name, brief, narrated: id === "cache-loop" }));
export type AcceptanceTopic = typeof acceptanceTopics[number];

export function propose(context: CreativePlannerContext, toolId: string, input: unknown) {
  const manifest = context.catalogue.tools.find(tool => tool.id === toolId);
  assert.ok(manifest, `Expected a scoped manifest for ${toolId}`);
  return JSON.stringify({ kind: "invoke", toolId, toolVersion: manifest.version, input });
}

const scene = (sceneId: string, name: string, startFrame: number) =>
  ({ toolId: "project.scene.create", input: { sceneId, name, startFrame, durationFrames: cutFrame } });
const text = (sceneId: string, nodeId: string, text: string, y: number, fontSize: number) =>
  ({ toolId: "graphics.2d.text.create", input: { sceneId, nodeId, text, x: 46, y, width: 548, height: 50, fontSize, color: "#eff5fc" } });
const shape = (sceneId: string, nodeId: string, x: number, y: number, width: number, height: number, fill: string, primitive = "rect") =>
  ({ toolId: "graphics.2d.shape.create", input: { sceneId, nodeId, primitive, x, y, width, height, fill } });

function timelineEdits(narrated: boolean): TimelinePatchOperation[] {
  const edits: TimelinePatchOperation[] = [{ op: "set-transition", fromShotId: "shot-first", toShotId: "shot-second",
    transition: { type: "crossfade", durationFrames: 6 } }];
  if (narrated) edits.push(
    { op: "place-clip", trackId: "voice", clip: { id: "spoken", assetId: voice.assetId, startFrame: voice.startFrame, durationFrames: voice.durationFrames } },
    { op: "set-caption", captionId: "hit", caption: { text: voice.firstCaption, startFrame: 0, durationFrames: 77 } },
    { op: "set-caption", captionId: "locality", caption: { text: voice.secondCaption, startFrame: 82, durationFrames: 69 } },
  );
  return edits;
}

/** A local adapter that advances only after the runner returns a confirmed tool result. */
export function fixturePlanner(topic: AcceptanceTopic): CreativePlanner {
  const cache = topic.narrated;
  const first = cache ? "缓存命中，数据沿近路返回" : "蒸发，让液态水进入空气";
  const second = cache ? "刚用过的数据，之后可能再用" : "冷却凝结，水滴可能形成降水";
  const positions = cache ? [[504, 185, 0], [320, 185, 0], [114, 185, 0]] : [[312, 252, 0], [312, 190, 0], [312, 130, 0]];
  const panels = cache ? [
    shape("first", "bus", 102, 197, 432, 4, "#4f86a9"),
    shape("second", "recent-data", 88, 154, 464, 74, "#3a8b84"),
  ] : [
    shape("first", "pool", 92, 276, 456, 32, "#399ab6"),
    shape("second", "cloud", 212, 130, 216, 84, "#6c8ba3", "ellipse"),
    shape("second", "rain-drop", 304, 238, 20, 20, "#68cde7", "circle"),
  ];
  const calls = [
    { toolId: "project.create", input: { name: topic.name, episodeId: topic.id, ...profile, durationFrames } },
    scene("first", first, 0), scene("second", second, cutFrame),
    shape("first", "first-bg", 0, 0, profile.width, profile.height, "#102237"),
    shape("second", "second-bg", 0, 0, profile.width, profile.height, "#163945"),
    text("first", "first-title", first, 50, 32), text("second", "second-title", second, 50, 32),
    ...panels,
    shape("first", markerId, positions[0][0], positions[0][1], 24, 24, "#f5bf62", "circle"),
    { toolId: "animation.keyframes.set", input: { trackId, targetNodeId: markerId, targetProperty: "transform.position",
      keyframes: [0, keyFrame, cutFrame - 1].map((frame, index) => ({ frame, value: positions[index], interpolation: "linear" })) } },
    ...(cache ? [{ toolId: "assets.import", input: { sourceId: voice.sourceId, assetId: voice.assetId, mediaType: "audio/wav" } }] : []),
  ];
  let index = 0;
  return { async propose(context) {
    const previous = context.observation;
    if (!previous) return propose(context, "project.inspect", {});
    if (previous.decision.toolId === "project.inspect") {
      assert.ok(previous.result.diagnostics.some(item => item.code === "PROJECT_NOT_FOUND"));
    } else {
      assert.ok(previous.result.ok, JSON.stringify(previous.result.diagnostics));
    }
    if (previous.decision.toolId === "project.snapshot.save")
      return JSON.stringify({ kind: "finish", summary: "Saved both authored shots and the approved timeline." });
    const next = calls[index++];
    if (next) return propose(context, next.toolId, next.input);
    const { revisionId } = previous.result.output as { revisionId: string };
    assert.ok(revisionId);
    return previous.decision.toolId === "timeline.edit"
      ? propose(context, "project.snapshot.save", { snapshotId: draftId, revisionId })
      : propose(context, "timeline.edit", { baseRevisionId: revisionId, edits: timelineEdits(cache) });
  } };
}

export function fixtureRepair(context: CreativeRepairPlannerContext, regress = false) {
  const { document, findings, revisionId } = context.repair;
  if (findings.some(item => item.nodeId === markerId)) {
    const key = document.animationTracks.find(track => track.id === trackId)?.keyframes.find(key => key.frame === keyFrame);
    assert.ok(key && Array.isArray(key.value));
    const [, y, z] = key.value;
    return propose(context, "animation.keyframes.edit", { baseRevisionId: revisionId, edits: [
      { op: "update", trackId, frame: keyFrame, changes: { value: [profile.width * (regress ? 2.5 : 0.5), y, z] } },
    ] });
  }
  const gap = findings.find(item => item.code === "TIMELINE_CAPTION_NARRATION_GAP");
  const cue = document.sequences[0].captions?.find(item => item.id === gap?.captionId);
  assert.ok(gap && cue);
  const startFrame = gap.ranges.find(range => range.startFrame === cue.startFrame)?.endFrame;
  assert.ok(startFrame !== undefined && startFrame < cue.startFrame + cue.durationFrames);
  return propose(context, "timeline.edit", { baseRevisionId: revisionId, edits: [
    { op: "set-caption", captionId: cue.id, caption: { text: cue.text, startFrame, durationFrames: cue.startFrame + cue.durationFrames - startFrame } },
  ] });
}
