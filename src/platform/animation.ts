import type { Keyframe, ProjectAnimationTrack } from "../contracts/project";

export interface AnimationSample {
  value: unknown;
  fromFrame: number;
  toFrame: number;
  progress: number;
}

/**
 * Samples a renderer-neutral animation track at an integer frame.
 * Linear interpolation supports numbers and equal-length numeric arrays.
 * Non-numeric values use step behavior to avoid inventing semantics.
 */
export function sampleAnimationTrack(
  track: ProjectAnimationTrack,
  frame: number
): AnimationSample | undefined {
  if (!Number.isFinite(frame) || frame < 0) throw new Error("Animation frame must be a finite non-negative number");
  if (track.enabled === false || track.keyframes.length === 0) return undefined;

  const keyframes = [...track.keyframes].sort((a, b) => a.frame - b.frame);
  for (let index = 1; index < keyframes.length; index++) {
    if (keyframes[index].frame === keyframes[index - 1].frame) {
      throw new Error(`Animation track ${track.id} has duplicate keyframes at frame ${keyframes[index].frame}`);
    }
  }

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  const sampleFrame = track.loop && last.frame > first.frame
    ? first.frame + ((frame - first.frame) % (last.frame - first.frame))
    : frame;

  if (sampleFrame <= first.frame) return { value: structuredClone(first.value), fromFrame: first.frame, toFrame: first.frame, progress: 0 };
  if (sampleFrame >= last.frame) return { value: structuredClone(last.value), fromFrame: last.frame, toFrame: last.frame, progress: 1 };

  const nextIndex = keyframes.findIndex((item) => item.frame >= sampleFrame);
  const to = keyframes[nextIndex];
  const from = keyframes[nextIndex - 1];
  const progress = (sampleFrame - from.frame) / (to.frame - from.frame);
  if (to.interpolation === "step") {
    return { value: structuredClone(from.value), fromFrame: from.frame, toFrame: to.frame, progress };
  }

  const interpolateValue = (a: unknown, b: unknown): unknown => {
    if (typeof a === "number" && typeof b === "number") return a + (b - a) * progress;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
        a.every((item) => typeof item === "number") && b.every((item) => typeof item === "number")) {
      return a.map((item, index) => (item as number) + ((b[index] as number) - (item as number)) * progress);
    }
    return structuredClone(from.value);
  };

  return {
    value: interpolateValue(from.value, to.value),
    fromFrame: from.frame,
    toFrame: to.frame,
    progress,
  };
}

export function validateAnimationTrack(track: ProjectAnimationTrack): string[] {
  const errors: string[] = [];
  if (!track.id.trim()) errors.push("Animation track ID is required");
  if (!track.targetNodeId.trim()) errors.push("Animation target node ID is required");
  if (!track.targetProperty.trim()) errors.push("Animation target property is required");
  if (track.keyframes.length === 0) errors.push("Animation track requires at least one keyframe");
  const frames = new Set<number>();
  let previous = -1;
  for (const keyframe of track.keyframes) {
    if (!Number.isInteger(keyframe.frame) || keyframe.frame < 0) errors.push("Keyframe frames must be non-negative integers");
    if (frames.has(keyframe.frame)) errors.push(`Duplicate keyframe frame: ${keyframe.frame}`);
    if (keyframe.frame < previous) errors.push("Keyframes must be sorted by ascending frame");
    frames.add(keyframe.frame);
    previous = keyframe.frame;
  }
  return errors;
}
