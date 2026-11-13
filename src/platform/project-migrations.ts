import type { ProjectDocument } from "../contracts/project";

export interface LegacyProjectV1_0_0 extends Omit<ProjectDocument, "schemaVersion" | "prefabs" | "constraints" | "dependencies" | "animationTracks"> {
  schemaVersion: "1.0.0";
}

export type SupportedProjectInput = ProjectDocument | LegacyProjectV1_0_0;

/**
 * Migrations are pure and additive: input documents are never mutated.
 * Breaking project-format changes must add a new explicit migration step.
 */
export function migrateProject(input: SupportedProjectInput): ProjectDocument {
  const project = structuredClone(input) as ProjectDocument;
  if (input.schemaVersion === "1.0.0") {
    project.schemaVersion = "1.1.0";
    project.prefabs = [];
    project.constraints = [];
    project.dependencies = [];
    project.animationTracks = [];
  } else if (input.schemaVersion !== "1.1.0") {
    throw new Error(`Unsupported project schema version: ${(input as { schemaVersion: string }).schemaVersion}`);
  }
  return project;
}
