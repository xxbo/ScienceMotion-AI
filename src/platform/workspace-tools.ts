import type { AgentTool, AgentToolManifest, ToolResult } from "../contracts/agent-tool";
import type { CreativePermission, CreativePluginFactory, CreativeServices } from "../contracts/creative-host";
import type { TimelineInspectionOptions } from "../contracts/inspection";
import type { ProjectAsset } from "../contracts/project";
import type { ProjectPatchDocument, TimelinePatchOperation } from "../contracts/project-patch";
import { createEmptyProject } from "./empty-project";
import patchSchema from "../../schemas/project-patch.schema.json";
import timelinePatchSchema from "../../schemas/project-timeline-patch.schema.json";
import { isChartData, isSafeSvgPathData } from "./graphic-values";
import { graphicsEditInput, graphicsEditPatches, type GraphicsEdit } from "./graphics-edits";
import { keyframeEditInput, keyframeEditPatches, type KeyframeEdit } from "./keyframe-edits";
import { MAX_INSPECTION_FRAMES } from "./snapshot-inspection";
import inspectionSchema from "../../schemas/snapshot-inspection.schema.json";
import layoutInspectionSchema from "../../schemas/snapshot-layout-inspection.schema.json";
import timelineInspectionSchema from "../../schemas/timeline-inspection.schema.json";
import { MAX_LAYOUT_FRAMES } from "./snapshot-layout-inspection";
import { pngArtifactForAsset } from "./project-assets";

const strings = (names: string[]) => Object.fromEntries(names.map((name) => [name, { type: "string", minLength: 1 }]));
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties, required });
const patchInput = structuredClone(patchSchema) as Record<string, unknown>;
delete patchInput.$id; // Local #/definitions references remain standalone in the Gateway's Ajv instance.

/** Built-in project, creative, rendering and inspection tools behind scoped host services. */
export const workspacePlugin: CreativePluginFactory = {
  id: "builtin.workspace", version: "1.0.0",
  create(services: CreativeServices) {
    const tool = (id: string, description: string, rights: CreativePermission[], inputSchema: Record<string, unknown>,
      execute: AgentTool["execute"], destructive = false, outputSchema: Record<string, unknown> = { type: "object" }): AgentTool => {
      const manifest: AgentToolManifest = { id, version: "1.0.0", namespace: id.slice(0, id.lastIndexOf(".")),
        name: id, description, category: "workspace", inputSchema, outputSchema, pluginId: "builtin.workspace", lifecycle: "beta",
        projectSchemaVersions: ["1.1.0"], execution: { deterministic: false, stateful: true, destructive,
          cost: id === "inspect.layout" ? "medium" : "low", idempotent: true, supportsCancellation: true, permissions: rights, maxConcurrency: 2, timeoutMs: 30_000 } };
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
      tool("timeline.edit", "Atomically edit shots, crossfades, PNG clips, PCM WAV narration and timed captions on the first sequence. Times are zero-based frame intervals.",
        ["project.read", "project.write"],
        { ...object({ baseRevisionId: timelinePatchSchema.properties.baseRevisionId, edits: timelinePatchSchema.properties.patches }),
          definitions: timelinePatchSchema.definitions },
        async (input, context) => {
          const args = input as { baseRevisionId: string; edits: TimelinePatchOperation[] };
          const result = await services.project.applyPatch({ schemaVersion: "1.4.0", projectId: context.projectId,
            baseRevisionId: args.baseRevisionId, patches: args.edits }, "Edit first sequence timeline");
          const sequence = result.project.sequences[0];
          return ok({ revisionId: result.revisionId, sequenceId: sequence.id, durationFrames: sequence.durationFrames,
            shotIds: sequence.shotIds, trackIds: sequence.trackIds ?? [],
            ...(sequence.transitions ? { transitions: sequence.transitions } : {}),
            ...(result.changedCaptionIds ? { changedCaptionIds: result.changedCaptionIds } : {}),
            changedShotIds: result.changedShotIds ?? [], changedClipIds: result.changedClipIds ?? [] });
        }),
      tool("project.snapshot.save", "Retain the exact current revision and its local artifact dependencies.", ["project.read", "snapshot.write"],
        object(strings(["revisionId", "snapshotId"])), async (input) => { const args = input as { revisionId: string; snapshotId: string }; return ok(await services.snapshots.save(args.revisionId, args.snapshotId)); }),
      tool("project.snapshot.inspect", "Read a retained snapshot from this project; dependencies are pinned for the tool run.", ["snapshot.read"],
        object(strings(["snapshotId"])), async (input) => ok(await services.snapshots.read((input as { snapshotId: string }).snapshotId))),
      tool("project.snapshot.restore", "Restore a same-project snapshot as a new revision. Requires explicit destructive authorization.", ["project.write", "snapshot.restore"],
        object(strings(["snapshotId", "baseRevisionId", "message"])), async (input) => { const args = input as { snapshotId: string; baseRevisionId: string; message: string }; return ok(await services.snapshots.restore(args.snapshotId, args.baseRevisionId, args.message)); }, true),
      tool("inspect.snapshot", "Inspect an immutable snapshot without encoding video. Returns model diagnostics, shape/chart bounds and exact sampled-frame coverage; browser text layout, final pixels, audio and content quality are not checked.", ["snapshot.read"],
        object({ snapshotId: { type: "string", minLength: 1, maxLength: 256 },
          frames: { type: "array", minItems: 1, maxItems: MAX_INSPECTION_FRAMES, uniqueItems: true, items: { type: "integer", minimum: 0 } } }, ["snapshotId"]),
        async (input) => {
          const args = input as { snapshotId: string; frames?: number[] };
          const report = await services.inspect.snapshot(args.snapshotId, args.frames);
          return { ok: true, output: report, diagnostics: report.issues.map((issue) => ({ level: issue.level, code: issue.code,
            message: issue.message, details: { source: issue.source, frames: issue.frames,
              ...(issue.nodeId ? { nodeId: issue.nodeId } : {}), ...(issue.trackId ? { trackId: issue.trackId } : {}),
              ...(issue.sceneId ? { sceneId: issue.sceneId } : {}) } })) };
        }, false, inspectionSchema),
      tool("inspect.layout", "Measure production browser text and element boxes after fonts load, without encoding screenshots or video. Reports text overflow, viewport crop and heuristic font fallback with node/frame identities. Occlusion, final pixels, exact glyph fonts and artistic quality are not checked.", ["snapshot.read"],
        object({ snapshotId: { type: "string", minLength: 1, maxLength: 256 },
          frames: { type: "array", minItems: 1, maxItems: MAX_LAYOUT_FRAMES, uniqueItems: true, items: { type: "integer", minimum: 0 } } }, ["snapshotId"]),
        async (input) => {
          const args = input as { snapshotId: string; frames?: number[] };
          const report = await services.inspect.layout(args.snapshotId, args.frames);
          return { ok: true, output: report, diagnostics: report.issues.map((issue) => ({ level: issue.level, code: issue.code,
            message: issue.message, details: { frame: issue.frame, ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
              ...(issue.sceneId ? { sceneId: issue.sceneId } : {}) } })) };
        }, false, layoutInspectionSchema),
      tool("inspect.timeline", "Inspect exact first-sequence shot, crossfade, PNG, narration and caption intervals. Optionally report caption spans outside declared positive-gain narration.", ["snapshot.read"],
        object({ snapshotId: { type: "string", minLength: 1, maxLength: 256 },
          range: object({ startFrame: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            durationFrames: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }),
          requireNarrationForCaptions: { type: "boolean" } }, ["snapshotId"]),
        async (input) => {
          const { snapshotId, ...options } = input as TimelineInspectionOptions & { snapshotId: string };
          const report = await services.inspect.timeline(snapshotId, options);
          return { ok: true, output: report, diagnostics: report.issues.map(issue => ({ level: issue.level, code: issue.code,
            message: issue.message, details: { captionId: issue.captionId, uncovered: issue.uncovered } })) };
        }, false, timelineInspectionSchema),
      tool("render.preview", "Render one frame from a project-owned immutable snapshot and return a retained PNG Artifact.", ["snapshot.read", "artifact.write"],
        object({ snapshotId: { type: "string", minLength: 1 }, frame: { type: "integer", minimum: 0 }, sceneId: { type: "string", minLength: 1 } }, ["snapshotId", "frame"]),
        async (input) => {
          const a = input as { snapshotId: string; frame: number; sceneId?: string };
          const artifact = await services.render.preview(a.snapshotId, a.frame, a.sceneId);
          return { ok: true, output: { artifactId: artifact.id, uri: artifact.uri, mediaType: artifact.mediaType, contentHash: artifact.contentHash, metadata: artifact.metadata },
            artifacts: [{ id: artifact.id, uri: artifact.uri, mediaType: artifact.mediaType, contentHash: artifact.contentHash }], diagnostics: [] };
        }, false, { type: "object" }),
      tool("render.video", "Render a bounded frame range from an immutable snapshot and return a retained MP4 Artifact.", ["snapshot.read", "artifact.write"],
        object({ snapshotId: { type: "string", minLength: 1 }, startFrame: { type: "integer", minimum: 0 },
          durationFrames: { type: "integer", minimum: 1, maximum: 900 }, sceneId: { type: "string", minLength: 1 } }, ["snapshotId", "startFrame", "durationFrames"]),
        async (input) => {
          const a = input as { snapshotId: string; startFrame: number; durationFrames: number; sceneId?: string };
          const artifact = await services.render.video(a.snapshotId, a.startFrame, a.durationFrames, a.sceneId);
          return { ok: true, output: { artifactId: artifact.id, uri: artifact.uri, mediaType: artifact.mediaType, contentHash: artifact.contentHash, metadata: artifact.metadata },
            artifacts: [{ id: artifact.id, uri: artifact.uri, mediaType: artifact.mediaType, contentHash: artifact.contentHash }], diagnostics: [] };
        }, false, { type: "object" }),
      tool("execution.list", "Read persisted execution evidence for the bound project only.", ["execution.read"], object({}), async () => ok(await services.executions.list()), false, { type: "array", items: { type: "object" } }),

      tool("assets.import", "Import a host-approved PNG or PCM WAV source. Use replace to update an existing asset of the same kind.",
        ["project.read", "project.write", "artifact.write"],
        object({ sourceId: { type: "string", minLength: 1, maxLength: 256 }, assetId: { type: "string", minLength: 1, maxLength: 256 },
          mediaType: { enum: ["image/png", "audio/wav"] }, replace: { type: "boolean" } }, ["sourceId", "assetId"]),
        async (input) => {
          const a = input as { sourceId: string; assetId: string; mediaType?: "image/png" | "audio/wav"; replace?: boolean };
          if (!a.assetId.trim() || a.assetId.includes("\0")) throw new Error("A bounded asset ID is required");
          const current = await services.project.read();
          if (!current) throw new Error("Create the project before importing assets");
          const previous = current.assets.find(asset => asset.id === a.assetId);
          const mediaType = a.mediaType ?? "image/png", kind = mediaType === "audio/wav" ? "audio" : "image";
          if (a.replace ? previous?.kind !== kind : previous !== undefined)
            return { ok: false, diagnostics: [{ level: "error", code: "ASSET_IMPORT_CONFLICT",
              message: "Import requires an unused asset ID or explicit replacement of an existing asset of the same kind" }] };
          const imported = kind === "audio" ? await services.artifacts.importWav(a.sourceId) : await services.artifacts.importPng(a.sourceId);
          const { record, license, attribution, ...media } = imported;
          const asset: ProjectAsset = { id: a.assetId, kind, uri: record.uri, contentHash: record.contentHash,
            metadata: { sourceId: a.sourceId, mediaType, ...media },
            ...(license === undefined ? {} : { license }), ...(attribution === undefined ? {} : { attribution }) };
          const applied = await services.project.applyPatch({ schemaVersion: "1.2.0", projectId: current.project.id,
            baseRevisionId: current.revisions.at(-1)!.id,
            patches: [a.replace ? { op: "replace-asset", assetId: a.assetId, asset } : { op: "add-asset", asset }] },
          (a.replace ? "Replace imported " : "Import ") + (kind === "audio" ? "WAV" : "PNG"));
          const ref = { id: record.id, uri: record.uri, mediaType: record.mediaType, contentHash: record.contentHash };
          return { ok: true, output: { asset, artifactId: record.id, revisionId: applied.revisionId }, artifacts: [ref], diagnostics: [] };
        }),
      tool("graphics.2d.image.create", "Place an imported PNG asset in a scene at the specified position and size.", ["project.read", "project.write"],
        object({ ...strings(["sceneId", "nodeId", "assetId"]), x: { type: "number" }, y: { type: "number" },
          width: { type: "number", minimum: 1, maximum: 10000 }, height: { type: "number", minimum: 1, maximum: 10000 } }),
        async (input) => {
          const a = input as { sceneId: string; nodeId: string; assetId: string; x: number; y: number; width: number; height: number };
          const current = await services.project.read();
          if (!current) throw new Error("Project not found");
          if (!pngArtifactForAsset(current.assets.find(asset => asset.id === a.assetId)))
            return { ok: false, diagnostics: [{ level: "error", code: "IMAGE_ASSET_UNAVAILABLE",
              message: "Select an imported PNG asset in this project" }] };
          const applied = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id,
            baseRevisionId: current.revisions.at(-1)!.id, patches: [{ op: "add-node", sceneId: a.sceneId,
              node: { id: a.nodeId, name: a.nodeId, type: "image",
                transform: { position: [a.x, a.y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                components: [{ kind: "image", data: { assetId: a.assetId, width: a.width, height: a.height } }] } }] },
          "Place PNG image");
          return ok({ nodeId: a.nodeId, revisionId: applied.revisionId });
        }),
      tool("project.scene.create", "Create a scene and place it on a sequence through one revisioned Patch.", ["project.read", "project.write"],
        object({ ...strings(["sceneId", "name"]), durationFrames: { type: "integer", minimum: 1 }, sequenceId: { type: "string", minLength: 1 }, startFrame: { type: "integer", minimum: 0 } }, ["sceneId", "name", "durationFrames"]),
        async (input) => {
          const args = input as { sceneId: string; name: string; durationFrames: number; sequenceId?: string; startFrame?: number };
          const current = await services.project.read();
          if (!current) return { ok: false, diagnostics: [{ level: "error", code: "PROJECT_NOT_FOUND", message: "Create the project first" }] };
          const sequence = current.sequences.find((item) => item.id === (args.sequenceId ?? current.sequences[0]?.id));
          if (!sequence) throw new Error("Sequence not found");
          const startFrame = args.startFrame ?? 0;
          if (startFrame + args.durationFrames > sequence.durationFrames) throw new Error("Scene shot exceeds sequence duration");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id,
            baseRevisionId: current.revisions.at(-1)!.id, patches: [
              { op: "add-scene", scene: { id: args.sceneId, name: args.name, durationFrames: args.durationFrames, rootNodeIds: [] } },
              { op: "add-shot", sequenceId: sequence.id, shot: { id: "shot-" + args.sceneId, name: args.name, sceneId: args.sceneId, startFrame, durationFrames: args.durationFrames } },
            ] }, "Create scene " + args.name);
          return ok({ sceneId: args.sceneId, revisionId: result.revisionId });
        }),
      tool("graphics.2d.text.create", "Create renderer-neutral text in a scene. Text content is project data, not generated TSX.", ["project.read", "project.write"],
        object({ ...strings(["sceneId", "nodeId", "text"]), x: { type: "number" }, y: { type: "number" },
          fontSize: { type: "number", minimum: 8, maximum: 240 }, fontWeight: { type: "number", minimum: 100, maximum: 900 },
          color: { type: "string" }, fontFamily: { type: "string" }, width: { type: "number", minimum: 1, maximum: 10000 },
          height: { type: "number", minimum: 1, maximum: 5000 }, textAlign: { enum: ["left", "center", "right"] } },
          ["sceneId", "nodeId", "text", "x", "y"]),
        async (input) => {
          const a = input as { sceneId: string; nodeId: string; text: string; x: number; y: number; fontSize?: number; fontWeight?: number; color?: string; fontFamily?: string; width?: number; height?: number; textAlign?: "left" | "center" | "right" };
          const current = await services.project.read(); if (!current) throw new Error("Project not found");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId: current.revisions.at(-1)!.id,
            patches: [{ op: "add-node", sceneId: a.sceneId, node: { id: a.nodeId, name: a.nodeId, type: "text",
              transform: { position: [a.x, a.y, 0], rotation: [0,0,0], scale: [1,1,1] },
              components: [{ kind: "text", data: { text: a.text, fontSize: a.fontSize ?? 48, fontWeight: a.fontWeight ?? 600,
                color: a.color ?? "#f4f7fb", fontFamily: a.fontFamily ?? "sans-serif", width: a.width ?? 700, height: a.height ?? 120, textAlign: a.textAlign ?? "left" } }] } }] },
            "Create text " + a.nodeId);
          return ok({ nodeId: a.nodeId, revisionId: result.revisionId });
        }),
      tool("graphics.2d.shape.create", "Create a renderer-neutral 2D primitive in a scene.", ["project.read", "project.write"],
        object({ ...strings(["sceneId", "nodeId"]), primitive: { enum: ["rect", "circle", "ellipse", "line"] },
          x: { type: "number" }, y: { type: "number" }, width: { type: "number", minimum: 1, maximum: 10000 },
          height: { type: "number", minimum: 1, maximum: 10000 }, fill: { type: "string" }, stroke: { type: "string" },
          strokeWidth: { type: "number", minimum: 0, maximum: 100 }, radius: { type: "number", minimum: 0, maximum: 1000 } },
          ["sceneId", "nodeId", "primitive", "x", "y", "width", "height"]),
        async (input) => {
          const a = input as { sceneId: string; nodeId: string; primitive: "rect" | "circle" | "ellipse" | "line"; x: number; y: number; width: number; height: number; fill?: string; stroke?: string; strokeWidth?: number; radius?: number };
          const current = await services.project.read(); if (!current) throw new Error("Project not found");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId: current.revisions.at(-1)!.id,
            patches: [{ op: "add-node", sceneId: a.sceneId, node: { id: a.nodeId, name: a.nodeId, type: "shape",
              transform: { position: [a.x, a.y, 0], rotation: [0,0,0], scale: [1,1,1] },
              components: [{ kind: "geometry", data: { primitive: a.primitive, width: a.width, height: a.height,
                fill: a.fill ?? "#55d6e8", stroke: a.stroke ?? "transparent", strokeWidth: a.strokeWidth ?? 0, radius: a.radius ?? 0 } }] } }] },
            "Create shape " + a.nodeId);
          return ok({ nodeId: a.nodeId, revisionId: result.revisionId });
        }),
      tool("graphics.2d.path.create", "Create a safe structured SVG path node; raw SVG markup is not accepted.", ["project.read", "project.write"],
        object({ ...strings(["sceneId", "nodeId", "pathData"]), x: { type: "number" }, y: { type: "number" },
          width: { type: "number", minimum: 1, maximum: 10000 }, height: { type: "number", minimum: 1, maximum: 10000 },
          fill: { type: "string" }, stroke: { type: "string" }, strokeWidth: { type: "number", minimum: 0, maximum: 100 },
          fillRule: { enum: ["nonzero", "evenodd"] } }, ["sceneId", "nodeId", "pathData", "x", "y", "width", "height"]),
        async (input) => {
          const a = input as { sceneId: string; nodeId: string; pathData: string; x: number; y: number; width: number; height: number; fill?: string; stroke?: string; strokeWidth?: number; fillRule?: "nonzero" | "evenodd" };
          if (!isSafeSvgPathData(a.pathData)) throw new Error("Invalid SVG path data; raw SVG/XML markup is not accepted");
          const current = await services.project.read(); if (!current) throw new Error("Project not found");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId: current.revisions.at(-1)!.id,
            patches: [{ op: "add-node", sceneId: a.sceneId, node: { id: a.nodeId, name: a.nodeId, type: "path",
              transform: { position: [a.x, a.y, 0], rotation: [0,0,0], scale: [1,1,1] },
              components: [{ kind: "geometry", data: { pathData: a.pathData, width: a.width, height: a.height, fill: a.fill ?? "#55d6e8",
                stroke: a.stroke ?? "transparent", strokeWidth: a.strokeWidth ?? 0, fillRule: a.fillRule ?? "nonzero" } }] } }] },
            "Create SVG path " + a.nodeId);
          return ok({ nodeId: a.nodeId, revisionId: result.revisionId });
        }),
      tool("graphics.2d.chart.create", "Create a data-driven bar or line chart as a renderer-neutral Project Graph node.", ["project.read", "project.write"],
        object({ ...strings(["sceneId", "nodeId"]), chartType: { enum: ["bar", "line"] },
          x: { type: "number" }, y: { type: "number" }, width: { type: "number", minimum: 240, maximum: 4000 },
          height: { type: "number", minimum: 160, maximum: 3000 }, fill: { type: "string" }, labelColor: { type: "string" },
          fontSize: { type: "number", minimum: 8, maximum: 48 },
          data: { type: "array", minItems: 2, maxItems: 24, items: { type: "object", additionalProperties: false,
            required: ["label", "value"], properties: { label: { type: "string", minLength: 1, maxLength: 48 }, value: { type: "number" } } } } },
          ["sceneId", "nodeId", "chartType", "x", "y", "width", "height", "data"]),
        async (input) => {
          const a = input as { sceneId: string; nodeId: string; chartType: "bar" | "line"; x: number; y: number; width: number; height: number;
            fill?: string; labelColor?: string; fontSize?: number; data: Array<{ label: string; value: number }> };
          if (!isChartData(a.data))
            throw new Error("Chart requires 2–24 labelled finite data points");
          const current = await services.project.read(); if (!current) throw new Error("Project not found");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId: current.revisions.at(-1)!.id,
            patches: [{ op: "add-node", sceneId: a.sceneId, node: { id: a.nodeId, name: a.nodeId, type: "shape",
              transform: { position: [a.x, a.y, 0], rotation: [0,0,0], scale: [1,1,1] },
              components: [{ kind: "geometry", data: { primitive: "chart", chartType: a.chartType, chartData: a.data,
                width: a.width, height: a.height, fill: a.fill ?? "#55d6e8", labelColor: a.labelColor ?? "#dbe7f3", fontSize: a.fontSize ?? 16 } }] } }] },
            "Create " + a.chartType + " chart " + a.nodeId);
          return ok({ nodeId: a.nodeId, revisionId: result.revisionId });
        }),
      tool("graphics.2d.edit", "Edit existing shapes, SVG paths and charts through one revisioned batch. Only the supplied geometry fields are updated.",
        ["project.read", "project.write"], graphicsEditInput, async (input) => {
          const { baseRevisionId, edits } = input as { baseRevisionId: string; edits: GraphicsEdit[] };
          const current = await services.project.read();
          if (!current) throw new Error("Project not found");
          if (current.revisions.at(-1)?.id !== baseRevisionId) throw new Error("Revision conflict: project has changed since the graphics edits were created");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId,
            patches: graphicsEditPatches(current.nodes, edits) }, "Edit 2D graphics");
          return ok({ revisionId: result.revisionId, changedNodeIds: result.changedNodeIds });
        }, false, object({ revisionId: { type: "string", minLength: 1 },
          changedNodeIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } } })),
      tool("project.node.transform.set", "Set a node's 2D/3D transform through the canonical revisioned editing boundary.", ["project.read", "project.write"],
        object({ ...strings(["nodeId"]), position: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } },
          rotation: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } },
          scale: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } } }, ["nodeId"]),
        async (input) => {
          const a = input as { nodeId: string; position?: [number,number,number]; rotation?: [number,number,number]; scale?: [number,number,number] };
          if (!a.position && !a.rotation && !a.scale) throw new Error("At least one transform field is required");
          const current = await services.project.read(); if (!current) throw new Error("Project not found");
          const node = current.nodes.find((item) => item.id === a.nodeId); if (!node) throw new Error("Node not found");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId: current.revisions.at(-1)!.id,
            patches: [{ op: "update-node", nodeId: a.nodeId, changes: { transform: { ...node.transform,
              ...(a.position ? { position: a.position } : {}), ...(a.rotation ? { rotation: a.rotation } : {}), ...(a.scale ? { scale: a.scale } : {}) } } }] },
            "Transform node " + a.nodeId);
          return ok({ nodeId: a.nodeId, revisionId: result.revisionId });
        }),
      tool("animation.keyframes.set", "Create or replace a supported animation track on a project node.", ["project.read", "project.write"],
        object({ ...strings(["trackId", "targetNodeId"]), targetProperty: { enum: ["transform.position", "transform.rotation", "transform.scale", "opacity"] },
          keyframes: { type: "array", minItems: 1, items: { type: "object", required: ["frame", "value"], properties: {
            frame: { type: "integer", minimum: 0 }, value: {}, interpolation: { enum: ["linear", "step", "bezier"] }, easing: { type: "string" }
          }, additionalProperties: false } }, loop: { type: "boolean" }, enabled: { type: "boolean" } },
          ["trackId", "targetNodeId", "targetProperty", "keyframes"]),
        async (input) => {
          const a = input as { trackId: string; targetNodeId: string; targetProperty: string; keyframes: Array<{ frame: number; value: unknown; interpolation?: "linear" | "step" | "bezier"; easing?: string }>; loop?: boolean; enabled?: boolean };
          const current = await services.project.read(); if (!current) throw new Error("Project not found");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId: current.revisions.at(-1)!.id,
            patches: [{ op: "put-animation-track", track: { id: a.trackId, targetNodeId: a.targetNodeId, targetProperty: a.targetProperty,
              keyframes: a.keyframes, ...(a.loop !== undefined ? { loop: a.loop } : {}), ...(a.enabled !== undefined ? { enabled: a.enabled } : {}) } }] }, "Set animation " + a.trackId);
          return ok({ trackId: a.trackId, revisionId: result.revisionId });
        }),
      tool("animation.keyframes.edit", "Insert, update, retime or remove individual scene-local keyframes on existing animation tracks in one revisioned batch.",
        ["project.read", "project.write"], keyframeEditInput, async (input) => {
          const { baseRevisionId, edits } = input as { baseRevisionId: string; edits: KeyframeEdit[] };
          const current = await services.project.read();
          if (!current) throw new Error("Project not found");
          if (current.revisions.at(-1)?.id !== baseRevisionId) throw new Error("Revision conflict: project has changed since the keyframe edits were created");
          const result = await services.project.applyPatch({ schemaVersion: "1.3.0", projectId: current.project.id, baseRevisionId,
            patches: keyframeEditPatches(current.animationTracks, edits) }, "Edit animation keyframes");
          return ok({ revisionId: result.revisionId, changedAnimationTrackIds: result.changedAnimationTrackIds ?? [] });
        }),
    ];
    return { manifest: { id: "builtin.workspace", version: "1.0.0", name: "Local workspace tools",
      description: "Revisioned project editing, 2D text/shapes/paths/charts, animation, snapshot-based preview/video rendering and execution inspection behind scoped host services.",
      toolIds: tools.map((entry) => entry.manifest.id), projectSchemaVersions: ["1.1.0"], lifecycle: "beta",
      permissions: ["project.read", "project.write", "project.delete", "artifact.read", "artifact.write", "snapshot.read", "snapshot.write", "snapshot.restore", "execution.read"] }, tools };
  },
};
