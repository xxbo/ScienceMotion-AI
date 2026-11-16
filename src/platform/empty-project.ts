import type { ProjectDocument } from "../contracts/project";
import { assertCreativeDocument } from "./project-creative-edits";

export interface EmptyProjectInput {
  id: string; name: string; episodeId: string;
  durationFrames?: number; fps?: number; width?: number; height?: number; createdAt?: string;
}
/** Canonical data factory for the upcoming project.create tool; no renderer or LLM dependency. */
export function createEmptyProject(input: EmptyProjectInput): ProjectDocument {
  for (const value of [input.id, input.name, input.episodeId]) if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Project identity, name and editorial episode ID are required");
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid project creation timestamp");
  const fps = input.fps ?? 30;
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 240) throw new Error("FPS must be an integer in [1, 240]");
  const project: ProjectDocument = {
    schemaVersion: "1.1.0",
    project: { id: input.id, name: input.name, createdAt, updatedAt: createdAt, units: "unitless", coordinateSystem: "screen-y-down", timebase: { fps, ticksPerFrame: 1 }, colorSpace: "srgb" },
    editorial: { episodeId: input.episodeId },
    sequences: [{ id: "sequence-main", name: "Main Sequence", fps, durationFrames: input.durationFrames ?? fps * 10, width: input.width ?? 1920, height: input.height ?? 1080, shotIds: [] }],
    scenes: [], nodes: [], animationTracks: [], shots: [], clips: [], tracks: [], assets: [], prefabs: [], constraints: [], dependencies: [],
    revisions: [{ id: "revision-initial", createdAt, message: "Created empty project", author: "ScienceMotion" }],
  };
  assertCreativeDocument(project); return project;
}
