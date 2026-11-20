import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectAnimationTrack } from "../contracts/project";
import { sampleAnimationTrack, validateAnimationTrack } from "./animation";
import { keyframeEditPatches } from "./keyframe-edits";

test("keyframe edits keep the track identity, sort retimed keys and clear easing explicitly", () => {
  const track: ProjectAnimationTrack = { id: "opacity", targetNodeId: "box", targetProperty: "opacity", loop: true,
    keyframes: [{ frame: 0, value: 0 }, { frame: 4, value: 0.5 }, { frame: 8, value: 1, interpolation: "bezier", easing: "ease-in" }] };
  const before = structuredClone(track);
  const [patch] = keyframeEditPatches([track], [
    { op: "update", trackId: track.id, frame: 8, changes: { frame: 10, interpolation: "step", easing: null } },
    { op: "insert", trackId: track.id, keyframe: { frame: 6, value: 0.6 } },
    { op: "remove", trackId: track.id, frame: 4 },
  ]);
  assert.ok(patch.op === "put-animation-track");
  assert.deepEqual(patch.track, { ...track, keyframes: [{ frame: 0, value: 0 }, { frame: 6, value: 0.6 }, { frame: 10, value: 1, interpolation: "step" }] });
  assert.deepEqual(track, before);
  assert.deepEqual(validateAnimationTrack(patch.track), []);
  assert.equal(sampleAnimationTrack(patch.track, 9)?.value, 0.6);
  assert.equal(sampleAnimationTrack(patch.track, 10)?.value, 0);
  assert.equal(sampleAnimationTrack({ ...patch.track, loop: false }, 10)?.value, 1);
  assert.throws(() => keyframeEditPatches([track], [{ op: "update", trackId: track.id, frame: 4, changes: { frame: 8 } }]), /already has a key/);
});
