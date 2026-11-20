import type { Clip, ProjectDocument, Sequence, Shot } from "../contracts/project";
import type { ProjectPatchOperation, TimelinePatchOperation } from "../contracts/project-patch";
import { narrationAsset, pngArtifactForAsset } from "./project-assets";

type FrameInterval = { id: string; startFrame: number; durationFrames: number };

export function firstSequenceShots(project: ProjectDocument): Shot[] {
  const ids = new Set(project.sequences[0]?.shotIds);
  // The declaration order still determines precedence in older snapshots with overlapping shots.
  return (project.shots ?? []).filter(shot => ids.has(shot.id));
}

function firstSequenceClips(project: ProjectDocument, kind: "video" | "audio") {
  const ids = project.sequences[0]?.trackIds;
  if (!ids?.length) return [];
  const tracks = new Map(project.tracks?.map(track => [track.id, track]));
  const clips = new Map(project.clips?.map(clip => [clip.id, clip]));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  return ids.flatMap(id => {
    const track = tracks.get(id);
    if (track?.kind !== kind) return [];
    return track.clipIds.flatMap(clipId => {
      const clip = clips.get(clipId);
      return clip ? [{ clip, asset: assets.get(clip.assetId) }] : [];
    });
  });
}

/** Return image layers in their sequence track order. */
export function firstSequencePngClips(project: ProjectDocument) {
  return firstSequenceClips(project, "video").flatMap(({ clip, asset }) => {
    const artifactId = pngArtifactForAsset(asset);
    return artifactId ? [{ clip, artifactId }] : [];
  });
}

export function firstSequenceAudioClips(project: ProjectDocument) {
  return firstSequenceClips(project, "audio").flatMap(({ clip, asset }) => {
    const source = narrationAsset(asset);
    return source ? [{ clip, source }] : [];
  });
}

export const isTimelineOperation = (operation: ProjectPatchOperation): operation is TimelinePatchOperation =>
  operation.op === "move-shot" || operation.op === "trim-shot" || operation.op === "reorder-shots" ||
  operation.op === "place-clip" || operation.op === "set-caption" || operation.op === "set-transition";

function placeClip(project: ProjectDocument, sequence: Sequence, edit: Extract<TimelinePatchOperation, { op: "place-clip" }>) {
  const { id, assetId, startFrame, durationFrames, inFrame, gain } = edit.clip;
  const kind = project.assets.find(asset => asset.id === assetId)?.kind === "audio" ? "audio" : "video";
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
    if (target.kind !== kind) throw new Error(kind === "audio" ? "WAV placement requires an audio track" : "PNG placement requires a video track");
    if (!trackIds.includes(target.id)) {
      if (target.clipIds.length || project.sequences.some(seq => seq.trackIds?.includes(edit.trackId)))
        throw new Error(`Track is outside the first sequence timeline: ${target.id}`);
      trackIds.push(target.id);
    }
  } else {
    target = { id: edit.trackId, name: edit.trackId, kind, clipIds: [] };
    tracks.push(target);
    trackIds.push(target.id);
  }
  const clip = { id, assetId, startFrame, durationFrames, ...(inFrame === undefined ? {} : { inFrame }), ...(gain === undefined ? {} : { gain }) };
  if (previous < 0) clips.push(clip);
  else clips[previous] = clip;
  if (owner !== target) {
    if (owner) owner.clipIds = owner.clipIds.filter(clipId => clipId !== id);
    target.clipIds.push(id);
  }
}

/** Apply one edit to the private working copy of a revisioned patch. */
export function applyTimelineOperation(project: ProjectDocument, edit: TimelinePatchOperation, changed: { shots: Set<string>; clips: Set<string>; captions: Set<string> }) {
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
    case "set-caption": {
      const { captionId: id, caption } = edit;
      if (!id.trim() || id.includes("\0") || id.length > 256) throw new Error("Invalid caption ID");
      const cues = (sequence.captions ?? []).filter(cue => cue.id !== id);
      if (caption !== null) cues.push({ id, text: caption.text, startFrame: caption.startFrame, durationFrames: caption.durationFrames });
      if (cues.length) sequence.captions = cues;
      else delete sequence.captions;
      changed.captions.add(id);
      break;
    }
    case "set-transition": {
      const { fromShotId, toShotId, transition } = edit;
      if (fromShotId === toShotId || !sequence.shotIds.includes(fromShotId) || !sequence.shotIds.includes(toShotId))
        throw new Error("A transition requires two distinct shots in the first sequence");
      const transitions = (sequence.transitions ?? []).filter(item => item.fromShotId !== fromShotId || item.toShotId !== toShotId);
      if (transition !== null) transitions.push({ fromShotId, toShotId, type: transition.type, durationFrames: transition.durationFrames });
      if (transitions.length) sequence.transitions = transitions;
      else delete sequence.transitions;
      changed.shots.add(fromShotId);
      changed.shots.add(toShotId);
      break;
    }
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

export function assertSequenceCaptions(sequence: Sequence): void {
  if (sequence.captions === undefined) return;
  if (!Array.isArray(sequence.captions)) throw new Error("Invalid sequence captions");
  const ids = new Set<string>();
  for (const cue of sequence.captions) {
    if (!cue || typeof cue.id !== "string" || !cue.id.trim() || cue.id.includes("\0") || cue.id.length > 256 || ids.has(cue.id))
      throw new Error("Invalid or duplicate caption ID");
    if (typeof cue.text !== "string" || !cue.text.trim() || cue.text.includes("\0") || Array.from(cue.text).length > 256)
      throw new Error(`Invalid caption text: ${cue.id}`);
    ids.add(cue.id);
  }
  orderedIntervals(sequence.captions, sequence.durationFrames, "Caption");
}

export function assertSequenceTransitions(sequence: Sequence, shots: ReadonlyMap<string, Shot>): void {
  if (sequence.transitions === undefined) return;
  if (!Array.isArray(sequence.transitions)) throw new Error("Invalid sequence transitions");
  if (!sequence.transitions.length) return;
  const ordered = orderedIntervals(sequence.shotIds.map(id => shots.get(id)!), sequence.durationFrames, "Shot");
  const positions = new Map(ordered.map((shot, index) => [shot.id, index]));
  const targets = new Set<string>();
  for (const transition of sequence.transitions) {
    if (transition?.type !== "crossfade") throw new Error("Invalid sequence transition type");
    const { fromShotId, toShotId, durationFrames } = transition;
    const index = positions.get(toShotId) ?? -1, from = ordered[index - 1], to = ordered[index];
    if (!from || from.id !== fromShotId || from.startFrame + from.durationFrames !== to.startFrame)
      throw new Error(`A crossfade requires adjacent shots with a shared cut: ${fromShotId} to ${toShotId}`);
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 2 || durationFrames > to.durationFrames)
      throw new Error(`Crossfade duration exceeds the allowed incoming shot range: ${toShotId}`);
    if (targets.has(toShotId)) throw new Error(`Duplicate crossfade for shot: ${toShotId}`);
    targets.add(toShotId);
  }
}

/** Sequence-owned tracks opt into rendering and its bounded placement rules. */
export function assertTimelineTracks(project: ProjectDocument): void {
  if (!project.sequences.some(sequence => sequence.trackIds !== undefined)) return;
  const tracks = new Map(project.tracks?.map(track => [track.id, track]));
  const clips = new Map(project.clips?.map(clip => [clip.id, clip]));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const assignedTracks = new Set<string>(), assignedClips = new Set<string>();
  for (const sequence of project.sequences) {
    const narration: Clip[] = [];
    if (sequence.trackIds !== undefined && !Array.isArray(sequence.trackIds)) throw new Error("Invalid sequence track list");
    for (const id of sequence.trackIds ?? []) {
      const track = tracks.get(id);
      if (!track || (track.kind !== "video" && track.kind !== "audio") || assignedTracks.has(id)) throw new Error(`Invalid media track membership: ${id}`);
      assignedTracks.add(id);
      if (!Array.isArray(track.clipIds)) throw new Error(`Invalid clip list in track: ${id}`);
      const placements = track.clipIds.map(clipId => {
        const clip = clips.get(clipId);
        if (!clip || assignedClips.has(clipId)) throw new Error(`Invalid clip membership: ${clipId}`);
        const asset = assets.get(clip.assetId);
        if (track.kind === "audio") {
          const source = narrationAsset(asset), inFrame = clip.inFrame ?? 0;
          if (!source) throw new Error(`Narration clips require a retained PCM WAV asset: ${clipId}`);
          const sourceFrames = Math.floor(source.sampleCount * sequence.fps / source.sampleRate);
          if (!Number.isSafeInteger(inFrame) || inFrame < 0 || clip.durationFrames > sourceFrames - inFrame)
            throw new Error(`Narration clip exceeds the WAV source duration: ${clipId}`);
          if (clip.gain !== undefined && (!Number.isFinite(clip.gain) || clip.gain < 0 || clip.gain > 2))
            throw new Error(`Invalid narration gain: ${clipId}`);
          narration.push(clip);
        } else if (!pngArtifactForAsset(asset) || (clip.inFrame ?? 0) !== 0 || clip.gain !== undefined) {
          throw new Error(`Video timeline clips require a still PNG asset: ${clipId}`);
        }
        assignedClips.add(clipId);
        return clip;
      });
      if (track.kind === "video") orderedIntervals(placements, sequence.durationFrames, "Clip");
    }
    orderedIntervals(narration, sequence.durationFrames, "Narration clip");
  }
  for (const track of tracks.values()) {
    if (!assignedTracks.has(track.id) && track.clipIds.some(id => assignedClips.has(id)))
      throw new Error(`Timeline clip also belongs to an unassigned track: ${track.id}`);
  }
}
