import type { ProjectDocument } from "../contracts/project";
import type { ProjectPatchDocument, ProjectPatchResult } from "../contracts/project-patch";
import { applyProjectPatch } from "./project-patches";

export interface ProjectRepository {
  get(projectId: string): Promise<ProjectDocument | undefined>;
  create(project: ProjectDocument): Promise<void>;
  applyPatch(
    projectId: string,
    patch: ProjectPatchDocument,
    metadata: { newRevisionId: string; createdAt: string; message: string }
  ): Promise<ProjectPatchResult>;
}

/**
 * In-memory reference repository with compare-and-swap revision semantics.
 * The synchronous map replacement after patch calculation is atomic within
 * the JS event loop. Durable multi-process implementations must use a DB
 * transaction or conditional write on the revision/version column.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectDocument>();

  async get(projectId: string): Promise<ProjectDocument | undefined> {
    const project = this.projects.get(projectId);
    return project ? structuredClone(project) : undefined;
  }

  async create(project: ProjectDocument): Promise<void> {
    if (this.projects.has(project.project.id)) {
      throw new Error(`Project already exists: ${project.project.id}`);
    }
    this.projects.set(project.project.id, structuredClone(project));
  }

  async applyPatch(
    projectId: string,
    patch: ProjectPatchDocument,
    metadata: { newRevisionId: string; createdAt: string; message: string }
  ): Promise<ProjectPatchResult> {
    const current = this.projects.get(projectId);
    if (!current) throw new Error(`Project not found: ${projectId}`);
    const currentRevisionId = current.revisions[current.revisions.length - 1]?.id;
    if (!currentRevisionId) throw new Error("Project has no current revision");
    if (patch.baseRevisionId !== currentRevisionId) {
      throw new Error(`Revision conflict: expected ${currentRevisionId}, received ${patch.baseRevisionId}`);
    }
    const result = applyProjectPatch(current, patch, {
      currentRevisionId,
      newRevisionId: metadata.newRevisionId,
      createdAt: metadata.createdAt,
      message: metadata.message,
    });
    // No await between compare and replace: atomic for this in-memory process.
    this.projects.set(projectId, structuredClone(result.project));
    return { ...result, project: structuredClone(result.project) };
  }
}
