import type { AgentTool, AgentToolManifest, ToolResult } from "../contracts/agent-tool";
import type { CreativePermission, CreativePluginFactory, CreativeServices } from "../contracts/creative-host";
import type { ProjectPatchDocument } from "../contracts/project-patch";
import { createEmptyProject } from "./empty-project";
import patchSchema from "../../schemas/project-patch.schema.json";

const strings = (names: string[]) => Object.fromEntries(names.map((name) => [name, { type: "string", minLength: 1 }]));
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties, required });
const patchInput = structuredClone(patchSchema) as Record<string, unknown>;
delete patchInput.$id; // Local #/definitions references remain standalone in the Gateway's Ajv instance.

/** Workspace primitives for F host validation. These are not the G visual/tool suite. */
export const workspacePlugin: CreativePluginFactory = {
  id: "builtin.workspace", version: "1.0.0",
  create(services: CreativeServices) {
    const tool = (id: string, description: string, rights: CreativePermission[], inputSchema: Record<string, unknown>,
      execute: AgentTool["execute"], destructive = false, outputSchema: Record<string, unknown> = { type: "object" }): AgentTool => {
      const manifest: AgentToolManifest = { id, version: "1.0.0", namespace: id.slice(0, id.lastIndexOf(".")),
        name: id, description, category: "workspace", inputSchema, outputSchema, pluginId: "builtin.workspace", lifecycle: "beta",
        projectSchemaVersions: ["1.1.0"], execution: { deterministic: false, stateful: true, destructive,
          cost: "low", idempotent: true, supportsCancellation: true, permissions: rights, maxConcurrency: 2, timeoutMs: 30_000 } };
      return { manifest, execute };
    };
    const ok = (output: unknown): ToolResult => ({ ok: true, output, diagnostics: [] });
    const tools: AgentTool[] = [
      tool("project.create", "Create an empty canonical project bound to the current session; editorial content remains independent.", ["project.write"],
        object({ ...strings(["name", "episodeId"]), durationFrames: { type: "integer", minimum: 1 }, fps: { type: "integer", minimum: 1, maximum: 240 },
          width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }, ["name", "episodeId"]),
        async (input, context) => {
          const project = createEmptyProject({ ...(input as Parameters<typeof createEmptyProject>[0]), id: context.projectId });
          await services.project.create(project); return ok({ projectId: project.project.id, revisionId: project.revisions.at(-1)!.id });
        }),
      tool("project.inspect", "Read the session's project; no cross-project projectId argument is accepted.", ["project.read"], object({}), async () => {
        const project = await services.project.read();
        return project ? ok(project) : { ok: false, diagnostics: [{ level: "error", code: "PROJECT_NOT_FOUND", message: "Create this project first" }] };
      }),
      tool("project.patch.apply", "Apply a revisioned non-removal Patch 1.1/1.2/1.3 batch. Removal requires the separately approved remove tool.",
        ["project.read", "project.write", "artifact.read"], patchInput, async (input) => ok(await services.project.applyPatch(input as ProjectPatchDocument, "Agent creative edit"))),
      tool("project.patch.remove", "Explicit destructive edit batch. In-use assets/scenes remain protected; no implicit cascade.",
        ["project.read", "project.write", "project.delete", "artifact.read"], patchInput, async (input) => ok(await services.project.applyPatch(input as ProjectPatchDocument, "Agent approved removal")), true),
      tool("project.snapshot.save", "Retain the exact current revision and its local artifact dependencies.", ["project.read", "snapshot.write"],
        object(strings(["revisionId", "snapshotId"])), async (input) => { const args = input as { revisionId: string; snapshotId: string }; return ok(await services.snapshots.save(args.revisionId, args.snapshotId)); }),
      tool("project.snapshot.inspect", "Read a retained snapshot from this project; dependencies are pinned for the tool run.", ["snapshot.read"],
        object(strings(["snapshotId"])), async (input) => ok(await services.snapshots.read((input as { snapshotId: string }).snapshotId))),
      tool("project.snapshot.restore", "Restore a same-project snapshot as a new revision. Requires explicit destructive authorization.", ["project.write", "snapshot.restore"],
        object(strings(["snapshotId", "baseRevisionId", "message"])), async (input) => { const args = input as { snapshotId: string; baseRevisionId: string; message: string }; return ok(await services.snapshots.restore(args.snapshotId, args.baseRevisionId, args.message)); }, true),
      tool("execution.list", "Read persisted execution evidence for the bound project only.", ["execution.read"], object({}), async () => ok(await services.executions.list()), false, { type: "array", items: { type: "object" } }),
    ];
    return { manifest: { id: "builtin.workspace", version: "1.0.0", name: "Local workspace tools",
      description: "Revisioned project operations, retained snapshots and execution inspection behind scoped host services.",
      toolIds: tools.map((entry) => entry.manifest.id), projectSchemaVersions: ["1.1.0"], lifecycle: "beta",
      permissions: ["project.read", "project.write", "project.delete", "artifact.read", "snapshot.read", "snapshot.write", "snapshot.restore", "execution.read"] }, tools };
  },
};
