import type { Keyframe, ProjectAnimationTrack } from "../contracts/project";
import type { CreativePatchOperation } from "../contracts/project-patch";

type EditableKeyframe = Omit<Keyframe, "interpolation"> & { interpolation?: "linear" | "step" | "bezier" };
export type KeyframeEdit = { trackId: string } & (
  | { op: "insert"; keyframe: EditableKeyframe }
  | { op: "update"; frame: number; changes: Partial<Omit<EditableKeyframe, "easing">> & { easing?: string | null } }
  | { op: "remove"; frame: number }
);

const identity = { type: "string", minLength: 1, maxLength: 256 };
const frame = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const easing = { type: "string", minLength: 1 };
const keyframeFields = { frame, value: {}, interpolation: { enum: ["linear", "step", "bezier"] }, easing };
const operation = (op: KeyframeEdit["op"], fields: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: ["op", "trackId", ...Object.keys(fields)],
  properties: { op: { const: op }, trackId: identity, ...fields },
});
export const keyframeEditInput = {
  type: "object", additionalProperties: false, required: ["baseRevisionId", "edits"],
  properties: {
    baseRevisionId: identity,
    edits: { type: "array", minItems: 1, items: { oneOf: [
      operation("insert", { keyframe: { type: "object", additionalProperties: false, required: ["frame", "value"], properties: keyframeFields } }),
      operation("update", { frame, changes: { type: "object", minProperties: 1, additionalProperties: false,
        properties: { ...keyframeFields, easing: { oneOf: [easing, { type: "null" }] } } } }),
      operation("remove", { frame }),
    ] } },
  },
};

/** Assemble tracks for the existing Project Patch validator and revision guard. */
export function keyframeEditPatches(tracks: readonly ProjectAnimationTrack[], edits: readonly KeyframeEdit[]): CreativePatchOperation[] {
  const byId = new Map(tracks.map(track => [track.id, track]));
  const staged = new Map<string, { track: ProjectAnimationTrack; keys: Map<number, Keyframe> }>();
  for (const edit of edits) {
    let draft = staged.get(edit.trackId);
    if (!draft) {
      const track = byId.get(edit.trackId);
      if (!track) throw new Error(`Animation track not found: ${edit.trackId}`);
      draft = { track, keys: new Map(track.keyframes.map(key => [key.frame, key])) };
      staged.set(edit.trackId, draft);
    }
    const { keys } = draft;
    if (edit.op === "insert") {
      if (keys.has(edit.keyframe.frame)) throw new Error(`Frame ${edit.keyframe.frame} already has a key in ${edit.trackId}`);
      keys.set(edit.keyframe.frame, edit.keyframe);
      continue;
    }
    const key = keys.get(edit.frame);
    if (!key) throw new Error(`Keyframe ${edit.frame} not found in ${edit.trackId}`);
    keys.delete(edit.frame);
    if (edit.op === "update") {
      const { easing, ...changes } = edit.changes;
      const updated = { ...key, ...changes };
      if (keys.has(updated.frame)) throw new Error(`Frame ${updated.frame} already has a key in ${edit.trackId}`);
      if (easing === null) delete updated.easing;
      else if (easing !== undefined) updated.easing = easing;
      keys.set(updated.frame, updated);
    }
  }
  return [...staged.values()].map(({ track, keys }) => ({
    op: "put-animation-track", track: { ...track, keyframes: [...keys.values()].sort((a, b) => a.frame - b.frame) },
  }));
}
