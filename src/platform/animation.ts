import type { ProjectAnimationTrack } from "../contracts/project";

export interface AnimationSample {
  value: unknown;
  fromFrame: number;
  toFrame: number;
  /** Raw time progress. Value interpolation uses the destination key's easing. */
  progress: number;
}
const presets: Record<string, readonly number[]> = {
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1],
};
function controls(easing: string): readonly number[] {
  if (Object.hasOwn(presets, easing)) return presets[easing];
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(easing);
  const tokens = match?.[1].split(",").map((s) => s.trim());
  const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  if (!tokens || tokens.length !== 4 || tokens.some((s) => !numeric.test(s))) throw new Error(`Unsupported easing: ${easing}`);
  const values = tokens.map(Number);
  if (!values.every(Number.isFinite) || values[0] < 0 || values[0] > 1 || values[2] < 0 || values[2] > 1) throw new Error(`Invalid cubic-bezier controls: ${easing}`);
  return values;
}
/** CSS timing curves: solve x(t)=progress, then evaluate y(t). */
export function sampleEasing(easing: string, progress: number): number {
  const [x1, y1, x2, y2] = controls(easing);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("Easing progress must be in [0, 1]");
  if (progress === 0 || progress === 1 || easing === "linear") return progress;
  const cubic = (t: number, a: number, b: number) => 3 * (1-t) ** 2 * t * a + 3 * (1-t) * t*t * b + t*t*t;
  let low = 0, high = 1;
  for (let i = 0; i < 60; i++) { const mid = (low + high) / 2; if (cubic(mid, x1, x2) < progress) low = mid; else high = mid; }
  const value = cubic((low + high) / 2, y1, y2);
  if (!Number.isFinite(value)) throw new Error("Easing produced a non-finite value");
  return value;
}
const finiteVector = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const numericPair = (a: unknown, b: unknown) => (typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b)) || (finiteVector(a) && finiteVector(b) && a.length === b.length);
function jsonValue(value: unknown, active = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || active.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  active.add(value);
  const valid = Array.isArray(value) ? Array.from(value).every((v) => jsonValue(v, active)) : Object.values(value).every((v) => jsonValue(v, active));
  active.delete(value); return valid;
}

export function validateAnimationTrack(track: ProjectAnimationTrack): string[] {
  const errors: string[] = [];
  if (!track || typeof track !== "object") return ["Animation track must be an object"];
  for (const [key, label] of [["id", "Animation track ID"], ["targetNodeId", "Animation target node ID"], ["targetProperty", "Animation target property"]] as const) {
    if (typeof track[key] !== "string" || !track[key].trim()) errors.push(`${label} is required`);
  }
  if (typeof track.targetProperty === "string" && track.targetProperty.split(".").some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) errors.push("Unsafe animation target property");
  for (const key of ["loop", "enabled"] as const) if (track[key] !== undefined && typeof track[key] !== "boolean") errors.push(`Animation ${key} must be boolean`);
  if (!Array.isArray(track.keyframes) || !track.keyframes.length) return [...errors, "Animation track requires at least one keyframe"];
  const frames = new Set<number>(); let previous = -1;
  track.keyframes.forEach((key, i) => {
    if (!key || typeof key !== "object") { errors.push("Invalid keyframe"); return; }
    if (!Number.isSafeInteger(key.frame) || key.frame < 0) errors.push("Keyframe frames must be non-negative integers");
    if (frames.has(key.frame)) errors.push(`Duplicate keyframe frame: ${key.frame}`);
    if (key.frame < previous) errors.push("Keyframes must be sorted by ascending frame");
    frames.add(key.frame); previous = key.frame;
    if (!jsonValue(key.value)) errors.push("Keyframe value must be finite JSON data");
    const mode = key.interpolation ?? "linear";
    if (!["linear", "step", "bezier"].includes(mode)) errors.push(`Unsupported interpolation: ${mode}`);
    if (mode === "bezier" && !key.easing) errors.push("Bezier interpolation requires explicit easing controls");
    if (key.easing !== undefined) {
      try { if (typeof key.easing !== "string") throw new Error("Easing must be a string"); controls(key.easing); }
      catch (error) { errors.push((error as Error).message); }
      if (mode === "step" && key.easing !== "linear") errors.push("Step interpolation cannot have non-linear easing");
    }
    if (i > 0 && mode !== "step" && !numericPair(track.keyframes[i-1]?.value, key.value)) errors.push("Non-numeric or mismatched values require explicit step interpolation");
  });
  return errors;
}

/** Scene-local frames; the destination key defines its incoming segment (v1.1 compatibility). */
export function sampleAnimationTrack(track: ProjectAnimationTrack, frame: number): AnimationSample | undefined {
  if (!Number.isFinite(frame) || frame < 0) throw new Error("Animation frame must be a finite non-negative number");
  if (track.enabled === false) return undefined;
  const errors = validateAnimationTrack(track);
  if (errors.length) throw new Error(`Invalid animation track ${track.id}: ${errors.join("; ")}`);
  const keys = track.keyframes, first = keys[0], last = keys[keys.length-1];
  // No extrapolation before first. Repetition uses the half-open interval [first, last).
  const local = track.loop && frame >= first.frame && last.frame > first.frame ? first.frame + (frame-first.frame) % (last.frame-first.frame) : frame;
  const at = (key: typeof first, progress: number) => ({ value: structuredClone(key.value), fromFrame: key.frame, toFrame: key.frame, progress });
  if (local <= first.frame) return at(first, 0);
  if (local >= last.frame) return at(last, 1);
  const index = keys.findIndex((key) => key.frame >= local), to = keys[index], from = keys[index-1];
  if (local === to.frame) return at(to, 1); // Step jumps exactly at its destination key.
  const progress = (local-from.frame)/(to.frame-from.frame);
  if (to.interpolation === "step") return { value: structuredClone(from.value), fromFrame: from.frame, toFrame: to.frame, progress };
  const eased = sampleEasing(to.easing ?? "linear", progress);
  const mix = (a: number, b: number) => { const value = (1-eased)*a + eased*b; if (!Number.isFinite(value)) throw new Error("Animation produced a non-finite value"); return value; };
  const value = typeof from.value === "number" ? mix(from.value, to.value as number) : (from.value as number[]).map((a, i) => mix(a, (to.value as number[])[i]));
  return { value, fromFrame: from.frame, toFrame: to.frame, progress };
}
