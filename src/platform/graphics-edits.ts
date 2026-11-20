import type { SceneNode } from "../contracts/project";
import type { ProjectPatchOperation } from "../contracts/project-patch";
import { isChartData, isSafeSvgPathData, isSupportedPaint, MAX_PATH_DATA_LENGTH, type ChartPoint } from "./graphic-values";

interface PaintChanges { width?: number; height?: number; fill?: string; stroke?: string; strokeWidth?: number }
export type GraphicsEdit = { nodeId: string } & (
  | { kind: "shape"; changes: PaintChanges & { primitive?: "rect" | "circle" | "ellipse" | "line"; radius?: number } }
  | { kind: "path"; changes: PaintChanges & { pathData?: string; fillRule?: "nonzero" | "evenodd" } }
  | { kind: "chart"; changes: PaintChanges & { chartType?: "bar" | "line"; data?: ChartPoint[]; labelColor?: string; fontSize?: number } }
);

const identity = { type: "string", minLength: 1, maxLength: 256 };
const paint = { type: "string", minLength: 1 };
const dimension = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const style = { width: dimension(1, 10_000), height: dimension(1, 10_000), fill: paint, stroke: paint, strokeWidth: dimension(0, 100) };
const editSchema = (kind: GraphicsEdit["kind"], properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: ["kind", "nodeId", "changes"],
  properties: { kind: { const: kind }, nodeId: identity,
    changes: { type: "object", minProperties: 1, additionalProperties: false, properties } },
});
export const graphicsEditInput = {
  type: "object", additionalProperties: false, required: ["baseRevisionId", "edits"],
  properties: {
    baseRevisionId: identity,
    edits: { type: "array", minItems: 1, items: { oneOf: [
      editSchema("shape", { ...style, primitive: { enum: ["rect", "circle", "ellipse", "line"] }, radius: dimension(0, 1000) }),
      editSchema("path", { ...style, pathData: { type: "string", minLength: 1, maxLength: MAX_PATH_DATA_LENGTH },
        fillRule: { enum: ["nonzero", "evenodd"] } }),
      editSchema("chart", { ...style, width: dimension(240, 4000), height: dimension(160, 3000), strokeWidth: dimension(2, 100),
        chartType: { enum: ["bar", "line"] }, labelColor: paint, fontSize: dimension(8, 48),
        data: { type: "array", minItems: 2, maxItems: 24, items: {
          type: "object", additionalProperties: false, required: ["label", "value"],
          properties: { label: { type: "string", minLength: 1, maxLength: 48 }, value: { type: "number" } },
        } },
      }),
    ] } },
  },
};

/** Build a revisioned patch from validated edit inputs while preserving components and node identity. */
export function graphicsEditPatches(nodes: readonly SceneNode[], edits: readonly GraphicsEdit[]): ProjectPatchOperation[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return edits.map(edit => {
    const node = byId.get(edit.nodeId);
    if (!node) throw new Error(`Graphics node not found: ${edit.nodeId}`);
    const components = [...node.components];
    const index = components.findIndex(component => component.kind === "geometry");
    const geometry = components[index] ?? { kind: "geometry" as const, data: {} };
    const kind = node.type === "shape" && geometry.data.primitive === "chart" ? "chart" : node.type;
    if (kind !== edit.kind) throw new Error(`Node ${edit.nodeId} has kind ${kind}, expected ${edit.kind}`);
    const { fill, stroke } = edit.changes;
    const labelColor = edit.kind === "chart" ? edit.changes.labelColor : undefined;
    for (const [field, color] of Object.entries({ fill, stroke, labelColor })) {
      if (color !== undefined && !isSupportedPaint(color)) throw new Error(`Unsupported ${field} color for node ${edit.nodeId}`);
    }
    let updated: Record<string, unknown>;
    if (edit.kind === "chart") {
      const { data, ...changes } = edit.changes;
      updated = { ...geometry.data, ...changes, ...(data === undefined ? {} : { chartData: data }) };
      if ((updated.chartType !== "bar" && updated.chartType !== "line") || !isChartData(updated.chartData))
        throw new Error(`Chart ${edit.nodeId} requires a supported type and 2–24 labelled finite data points`);
    } else {
      updated = { ...geometry.data, ...edit.changes };
      if (edit.kind === "path" && !isSafeSvgPathData(updated.pathData)) throw new Error(`Invalid SVG path data for node ${edit.nodeId}`);
    }
    components[index < 0 ? components.length : index] = { ...geometry, data: updated };
    byId.set(node.id, { ...node, components });
    return { op: "update-node", nodeId: node.id, changes: { components } };
  });
}
