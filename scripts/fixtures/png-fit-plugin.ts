import patchSchema from "../../schemas/project-patch.schema.json";
import type { ToolResult } from "../../src/contracts/agent-tool";
import type { CreativePermission, CreativePluginFactory } from "../../src/contracts/creative-host";
import type { ProjectPatchDocument } from "../../src/contracts/project-patch";
import { validateStaticPng } from "../../src/platform/png-input";
import { pngArtifactForAsset } from "../../src/platform/project-assets";

export const fitPngToolId = "composition.image.fit";
const pluginId = "composition.image";
const version = "1.0.0";
const stringId = { type: "string", minLength: 1, maxLength: 128 };
const dimension = { type: "number", minimum: 1, maximum: 10000 };
const outputSchema = structuredClone(patchSchema) as Record<string, unknown>;
delete outputSchema.$id;

export interface FitPngInput {
  assetId: string;
  artifactId: string;
  baseRevisionId: string;
  sceneId: string;
  nodeId: string;
  box: { x: number; y: number; width: number; height: number };
}

function reject(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return { ok: false, diagnostics: [{ level: "error", code, message, ...(details && { details }) }] };
}

/** An opt-in read-only tool. The normal project patch tool owns revisioned publication. */
export const pngFitPlugin: CreativePluginFactory = {
  id: pluginId,
  version,
  create(services) {
    const permissions: CreativePermission[] = ["project.read", "artifact.read"];
    return {
      manifest: { id: pluginId, version, name: "PNG fitting", description: "Fit a retained PNG into a scene box.",
        toolIds: [fitPngToolId], projectSchemaVersions: ["1.1.0"], permissions },
      tools: [{
        manifest: { id: fitPngToolId, version, namespace: pluginId, pluginId, name: "Fit PNG", category: "composition",
          description: "Verify the observed PNG binding and revision, and return a patch that centers the image without stretching it.",
          projectSchemaVersions: ["1.1.0"], lifecycle: "beta",
          inputSchema: { type: "object", additionalProperties: false,
            required: ["assetId", "artifactId", "baseRevisionId", "sceneId", "nodeId", "box"],
            properties: { assetId: stringId, artifactId: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
              baseRevisionId: stringId, sceneId: stringId, nodeId: stringId,
              box: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
                x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, width: dimension, height: dimension,
              } } } },
          outputSchema,
          execution: { deterministic: true, stateful: false, destructive: false, cost: "low", permissions, timeoutMs: 10_000 } },
        async execute(input) {
          const request = input as FitPngInput;
          const { assetId, artifactId, baseRevisionId, sceneId, nodeId, box } = request;
          const project = await services.project.read();
          if (!project || project.revisions.at(-1)?.id !== baseRevisionId)
            return reject("COMPOSITION_REVISION_MISMATCH", "Use the current revision of this project.");
          const expectedArtifactId = pngArtifactForAsset(project.assets.find(asset => asset.id === assetId));
          if (expectedArtifactId !== artifactId)
            return reject("COMPOSITION_ARTIFACT_MISMATCH", "The supplied PNG does not match the asset binding in this revision.",
              { assetId, suppliedArtifactId: artifactId, expectedArtifactId: expectedArtifactId ?? null });
          const sequence = project.sequences[0];
          if (!project.scenes.some(scene => scene.id === sceneId) || !sequence ||
              box.x + box.width > sequence.width || box.y + box.height > sequence.height)
            return reject("COMPOSITION_BOX_INVALID", "Choose an existing scene and a box inside the target viewport.");

          const { record, bytes } = await services.artifacts.read(artifactId);
          if (record.mediaType !== "image/png")
            return reject("COMPOSITION_MEDIA_TYPE", "The retained artifact must be a static PNG.");
          const dimensions = await validateStaticPng(Buffer.from(bytes));
          const scale = Math.min(box.width / dimensions.width, box.height / dimensions.height);
          const width = dimensions.width * scale, height = dimensions.height * scale;
          const x = box.x + (box.width - width) / 2, y = box.y + (box.height - height) / 2;
          const patch: ProjectPatchDocument = { schemaVersion: "1.3.0", projectId: project.project.id, baseRevisionId,
            patches: [{ op: "add-node", sceneId, node: { id: nodeId, name: nodeId, type: "image",
              transform: { position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              components: [{ kind: "image", data: { assetId, width, height } }],
            } }] };
          return { ok: true, output: patch, diagnostics: [] };
        },
      }],
    };
  },
};
