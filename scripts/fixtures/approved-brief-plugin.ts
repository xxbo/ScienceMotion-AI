import type { CreativePermission, CreativePluginFactory } from "../../src/contracts/creative-host";

/** Acceptance-only extension: attach/replace a brief as a real content-addressed data dependency. */
export const approvedBriefPlugin: CreativePluginFactory = {
  id: "acceptance.brief", version: "1.0.0",
  create(services) {
    const permissions: CreativePermission[] = ["project.read", "project.write", "artifact.read", "artifact.write"];
    const toolId = "acceptance.brief.attach";
    return {
      manifest: { id: "acceptance.brief", version: "1.0.0", name: "Acceptance brief dependency",
        description: "An executable test extension using only public CreativeServices; not a production media importer.",
        toolIds: [toolId], projectSchemaVersions: ["1.1.0"], permissions },
      tools: [{ manifest: { id: toolId, version: "1.0.0", namespace: "acceptance.brief", pluginId: "acceptance.brief",
        name: "Attach approved brief", description: "Store approved text as a data Artifact and attach or replace its project asset.",
        category: "acceptance", projectSchemaVersions: ["1.1.0"], lifecycle: "beta",
        inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 4000 } } },
        outputSchema: { type: "object", additionalProperties: false, required: ["assetId", "artifactId", "revisionId"],
          properties: { assetId: { type: "string" }, artifactId: { type: "string" }, revisionId: { type: "string" } } },
        execution: { deterministic: false, stateful: true, destructive: false, cost: "low", permissions,
          supportsCancellation: true, idempotent: true, timeoutMs: 30000 } },
        async execute(input) {
          const project = await services.project.read(); if (!project) throw new Error("Create a project first");
          const content = JSON.stringify({ episodeId: project.editorial.episodeId, brief: (input as { text: string }).text });
          const artifact = await services.artifacts.put({ bytes: new TextEncoder().encode(content), kind: "data",
            mediaType: "application/json", extension: "json" });
          const asset = { id: "approved-brief", kind: "data" as const, uri: artifact.uri, contentHash: artifact.contentHash };
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: project.project.id,
            baseRevisionId: project.revisions.at(-1)!.id, patches: project.assets.some(a => a.id === asset.id)
              ? [{ op: "replace-asset", assetId: asset.id, asset }] : [{ op: "add-asset", asset }] }, "Attach approved brief dependency");
          return { ok: true, output: { assetId: asset.id, artifactId: artifact.id, revisionId: result.revisionId }, diagnostics: [],
            artifacts: [{ id: artifact.id, uri: artifact.uri, mediaType: artifact.mediaType, contentHash: artifact.contentHash }] };
        } }],
    };
  },
};
