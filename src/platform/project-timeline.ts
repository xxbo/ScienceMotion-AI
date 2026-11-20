import type { Clip, ProjectDocument, Sequence, Shot } from "../contracts/project";
import type { ProjectPatchOperation, TimelinePatchOperation } from "../contracts/project-patch";
import { pngArtifactForAsset } from "./project-assets";

type FrameInterval = { id: string; startFrame: number; durationFrames: number };

export function firstSequenceShots(project: ProjectDocument): Shot[] {
  const ids = new Set(project.sequences[0]?.shotIds);
  // The declaration order still determines precedence in older snapshots with overlapping shots.
  return (project.shots ?? []).filter(shot => ids.has(shot.id));
}

/** Return image layers in their sequence track order. */
export function firstSequencePngClips(project: ProjectDocument): { clip: Clip; artifactId: string }[] {
  const ids = project.sequences[0]?.trackIds;
  if (!ids?.length) return [];
  const tracks = new Map(project.tracks?.map(track => [track.id, track]));
  const clips = new Map(project.clips?.map(clip => [clip.id, clip]));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const layers: { clip: Clip; artifactId: string }[] = [];
  for (const id of ids) {
    const track = tracks.get(id);
    if (track?.kind !== "video") continue;
    for (const clipId of track.clipIds) {
      const clip = clips.get(clipId);
      const artifactId = clip && pngArtifactForAsset(assets.get(clip.assetId));
      if (clip && artifactId) layers.push({ clip, artifactId });
    }
  }
  return layers;
}

export const isTimelineOperation = (operation: ProjectPatchOperation): operation is TimelinePatchOperation =>
  operation.op === "move-shot" || operation.op === "trim-shot" || operation.op === "reorder-shots" || operation.op === "place-clip";

function placeClip(project: ProjectDocument, sequence: Sequence, edit: Extract<TimelinePatchOperation, { op: "place-clip" }>) {
  const { id, assetId, startFrame, durationFrames } = edit.clip;
  if (typeof edit.trackId !== "string" || !edit.trackId.trim() || edit.trackId.includes("\0"))
    throw new Error("Invalid timeline track ID");
  const trackIds = sequence.trackIds ??= [];
  const tracks = project.tracks ??= [];
  const clips = project.clips ??= [];
  const previous = clips.findIndex(clip => clip.id === id);
  const owner = tracks.find(track => trackIds.includes(track.id) && track.clipIds.includes(id));
  if (previous >= 0 && !owner) throw new Error(`Clip is outside the first sequence timeline: ${id}`);
  let target = tracks.find(track => track.id === edit.trackId);
  if (target) {
    if (target.kind !== "video") throw new Error("PNG placement requires a video track");
    if (!trackIds.includes(target.id)) {
      if (target.clipIds.length || project.sequences.some(seq => seq.trackIds?.includes(edit.trackId)))
        throw new Error(`Track is outside the first sequence timeline: ${target.id}`);
      trackIds.push(target.id);
    }
  } else {
    target = { id: edit.trackId, name: edit.trackId, kind: "video", clipIds: [] };
    tracks.push(target);
    trackIds.push(target.id);
  }
  const clip = { id, assetId, startFrame, durationFrames };
  if (previous < 0) clips.push(clip);
  else clips[previous] = clip;
  if (owner !== target) {
    if (owner) owner.clipIds = owner.clipIds.filter(clipId => clipId !== id);
    target.clipIds.push(id);
  }
}

/** Apply one edit to the private working copy of a revisioned patch. */
export function applyTimelineOperation(project: ProjectDocument, edit: TimelinePatchOperation, changed: { shots: Set<string>; clips: Set<string> }) {
  const sequence = project.sequences[0];
  if (!sequence) throw new Error("Timeline editing requires a first sequence");
  switch (edit.op) {
    case "move-shot":
    case "trim-shot": {
      const shot = sequence.shotIds.includes(edit.shotId) && project.shots?.find(shot => shot.id === edit.shotId);
      if (!shot) throw new Error(`Shot is outside the first sequence timeline: ${edit.shotId}`);
      if (edit.op === "move-shot") shot.startFrame = edit.startFrame;
      else {
        if (!Number.isSafeInteger(edit.inFrame) || edit.inFrame < 0) throw new Error("Invalid shot source frame");
        shot.inFrame = edit.inFrame;
        shot.durationFrames = edit.durationFrames;
      }
      changed.shots.add(shot.id);
      break;
    }
    case "reorder-shots": {
      const shots = new Map(firstSequenceShots(project).map(shot => [shot.id, shot]));
      if (!Array.isArray(edit.shotIds) || !edit.shotIds.length || edit.shotIds.length !== shots.size ||
          new Set(edit.shotIds).size !== shots.size || edit.shotIds.some(id => !shots.has(id)))
        throw new Error("Shot reorder requires a permutation of every shot in the first sequence");
      let frame = edit.startFrame === undefined ? 0 : edit.startFrame;
      if (!Number.isSafeInteger(frame) || frame < 0) throw new Error("Invalid shot reorder start frame");
      for (const id of edit.shotIds) {
        const shot = shots.get(id)!;
        shot.startFrame = frame;
        frame += shot.durationFrames;
        changed.shots.add(id);
      }
      break;
    }
    case "place-clip":
      placeClip(project, sequence, edit);
      changed.clips.add(edit.clip.id);
      break;
  }
}

function orderedIntervals<T extends FrameInterval>(items: T[], duration: number, label: string): T[] {
  const ordered = [...items].sort((a, b) => a.startFrame - b.startFrame);
  let end = 0;
  for (const { id, startFrame, durationFrames } of ordered) {
    if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(durationFrames) ||
        durationFrames < 1 || durationFrames > duration - startFrame) throw new Error(`${label} exceeds sequence bounds: ${id}`);
    if (startFrame < end) throw new Error(`${label} overlaps a preceding interval: ${id}`);
    end = startFrame + durationFrames;
  }
  return ordered;
}

export function orderEditedShots(project: ProjectDocument) {
  const sequence = project.sequences[0];
  sequence.shotIds = orderedIntervals(firstSequenceShots(project), sequence.durationFrames, "Shot").map(shot => shot.id);
}

/** Sequence-owned tracks opt into rendering and its bounded placement rules. */
export function assertTimelineTracks(project: ProjectDocument): void {
  if (!project.sequences.some(sequence => sequence.trackIds !== undefined)) return;
  const tracks = new Map(project.tracks?.map(track => [track.id, track]));
  const clips = new Map(project.clips?.map(clip => [clip.id, clip]));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const assignedTracks = new Set<string>(), assignedClips = new Set<string>();
  for (const sequence of project.sequences) {
    if (sequence.trackIds !== undefined && !Array.isArray(sequence.trackIds)) throw new Error("Invalid sequence track list");
    for (const id of sequence.trackIds ?? []) {
      const track = tracks.get(id);
      if (!track || track.kind !== "video" || assignedTracks.has(id)) throw new Error(`Invalid video track membership: ${id}`);
      assignedTracks.add(id);
      if (!Array.isArray(track.clipIds)) throw new Error(`Invalid clip list in track: ${id}`);
      const placements = track.clipIds.map(clipId => {
        const clip = clips.get(clipId);
        if (!clip || assignedClips.has(clipId)) throw new Error(`Invalid clip membership: ${clipId}`);
        if (!pngArtifactForAsset(assets.get(clip.assetId)) || (clip.inFrame ?? 0) !== 0 || clip.gain !== undefined)
          throw new Error(`Video timeline clips require a still PNG asset: ${clipId}`);
        assignedClips.add(clipId);
        return clip;
      });
      orderedIntervals(placements, sequence.durationFrames, "Clip");
    }
  }
  for (const track of tracks.values()) {
    if (!assignedTracks.has(track.id) && track.clipIds.some(id => assignedClips.has(id)))
      throw new Error(`Timeline clip also belongs to an unassigned track: ${track.id}`);
  }
}
