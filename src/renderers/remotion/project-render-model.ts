import type { ProjectDocument, SceneNode } from "../../contracts/project";
import { sampleAnimationTrack } from "../../platform/animation";

export interface ProjectRenderElement {
  id: string; type: "text" | "shape" | "path"; text?: string; pathData?: string; fillRule?: "nonzero" | "evenodd";
  primitive?: "rect" | "circle" | "ellipse" | "line";
  width: number; height: number; fill: string; stroke: string; strokeWidth: number; radius: number;
  color: string; fontSize: number; fontFamily: string; fontWeight: number;
  textAlign: "left" | "center" | "right"; opacity: number; transform: string;
}
export interface ProjectRenderModel {
  projectId: string; sceneId?: string; sceneFrame: number; width: number; height: number; fps: number;
  elements: ProjectRenderElement[];
  diagnostics: Array<{ level: "warning" | "error"; code: string; message: string }>;
}
type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
  a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
];
const finite = (v: unknown, fallback: number): number => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const color = (v: unknown, fallback: string): string =>
  typeof v === "string" && (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^(transparent|black|white|red|green|blue|orange|yellow|purple|gray|grey|cyan)$/i.test(v))
    ? v : fallback;
/** Accept path commands only; raw SVG/XML, CSS, URLs and scripts are never parsed. */
export function isSafeSvgPathData(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 20000) return false;
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\-\s]+$/.test(value)) return false;
  const tokens = value.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g);
  if (!tokens || !tokens.some((token) => /^[MmLlHhVvCcSsQqTtAaZz]$/.test(token))) return false;
  const stripped = value.replace(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]+/g, "");
  return stripped.length === 0;
}
\nconst component = (node: SceneNode, kind: string) => node.components.find((item) => item.kind === kind)?.data;
const safeDimension = (value: unknown, fallback: number): number => Math.max(0, Math.min(10000, finite(value, fallback)));

function animatedTransform(project: ProjectDocument, node: SceneNode, frame: number, diagnostics: ProjectRenderModel["diagnostics"]) {
  const value = { position: [...node.transform.position] as number[], rotation: [...node.transform.rotation] as number[], scale: [...node.transform.scale] as number[], opacity: 1 };
  for (const track of project.animationTracks.filter((item) => item.targetNodeId === node.id && item.enabled !== false)) {
    try {
      const sample = sampleAnimationTrack(track, frame);
      if (!sample) continue;
      if (track.targetProperty === "transform.position" && Array.isArray(sample.value)) value.position = sample.value as number[];
      else if (track.targetProperty === "transform.rotation" && Array.isArray(sample.value)) value.rotation = sample.value as number[];
      else if (track.targetProperty === "transform.scale" && Array.isArray(sample.value)) value.scale = sample.value as number[];
      else if (track.targetProperty === "opacity" && typeof sample.value === "number") value.opacity = Math.max(0, Math.min(1, sample.value));
      else diagnostics.push({ level: "warning", code: "RENDER_UNSUPPORTED_ANIMATION_PROPERTY", message: "Unsupported animation property: " + track.targetProperty });
    } catch (error) {
      diagnostics.push({ level: "error", code: "RENDER_INVALID_ANIMATION", message: track.id + ": " + (error instanceof Error ? error.message : String(error)) });
    }
  }
  return value;
}
function localMatrix(node: SceneNode, project: ProjectDocument, frame: number, diagnostics: ProjectRenderModel["diagnostics"]) {
  const t = animatedTransform(project, node, frame, diagnostics);
  const angle = finite(t.rotation[2], 0) * Math.PI / 180;
  const sx = finite(t.scale[0], 1), sy = finite(t.scale[1], 1);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { matrix: [cos*sx, sin*sx, -sin*sy, cos*sy, finite(t.position[0], 0), finite(t.position[1], 0)] as Matrix, opacity: t.opacity };
}

/** Deterministic renderer-neutral projection of one Project Graph frame into the initial 2D subset. */
export function buildProjectRenderModel(project: ProjectDocument, frame: number, sceneId?: string): ProjectRenderModel {
  const diagnostics: ProjectRenderModel["diagnostics"] = [];
  const sequence = project.sequences[0];
  const shots = project.shots ?? [];
  const shot = sceneId ? undefined : shots.find((item) => item.startFrame <= frame && frame < item.startFrame + item.durationFrames);
  const selectedSceneId = sceneId ?? (shots.length ? shot?.sceneId : project.scenes[0]?.id);
  const scene = project.scenes.find((item) => item.id === selectedSceneId);
  const sceneFrame = shot && !sceneId ? frame - shot.startFrame : frame;
  const result: ProjectRenderModel = {
    projectId: project.project.id, sceneId: scene?.id, sceneFrame,
    width: sequence?.width ?? 1920, height: sequence?.height ?? 1080,
    fps: sequence?.fps ?? project.project.timebase.fps, elements: [], diagnostics,
  };
  if (!scene) {
    diagnostics.push({ level: "warning", code: "RENDER_SCENE_NOT_FOUND", message: "No scene is active at frame " + frame });
    return result;
  }
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const visit = (id: string, parent: Matrix, parentOpacity: number): void => {
    if (visited.has(id)) { diagnostics.push({ level: "error", code: "RENDER_HIERARCHY_CYCLE", message: "Repeated node in hierarchy: " + id }); return; }
    const node = nodes.get(id);
    if (!node) { diagnostics.push({ level: "error", code: "RENDER_NODE_MISSING", message: "Missing node: " + id }); return; }
    visited.add(id);
    const local = localMatrix(node, project, sceneFrame, diagnostics);
    const matrix = multiply(parent, local.matrix);
    const opacity = parentOpacity * local.opacity;
    if (node.type === "text") {
      const data = component(node, "text") ?? {};
      result.elements.push({
        id: node.id, type: "text", text: typeof data.text === "string" ? data.text : node.name,
        width: safeDimension(data.width, 600), height: safeDimension(data.height, 120),
        fill: "transparent", stroke: "transparent", strokeWidth: 0, radius: 0,
        color: color(data.color, "#f4f7fb"), fontSize: safeDimension(data.fontSize, 48),
        fontFamily: typeof data.fontFamily === "string" ? data.fontFamily : "sans-serif",
        fontWeight: finite(data.fontWeight, 600),
        textAlign: data.textAlign === "center" || data.textAlign === "right" ? data.textAlign : "left",
        opacity, transform: "matrix(" + matrix.join(",") + ")",
      });
    } else if (node.type === "shape") {
      const data = component(node, "geometry") ?? {};
      const primitive = ["rect", "circle", "ellipse", "line"].includes(String(data.primitive)) ? data.primitive as ProjectRenderElement["primitive"] : "rect";
      result.elements.push({
        id: node.id, type: "shape", primitive,
        width: safeDimension(data.width, primitive === "circle" ? 100 : 240),
        height: safeDimension(data.height, primitive === "circle" ? 100 : 140),
        fill: color(data.fill, "#55d6e8"), stroke: color(data.stroke, "transparent"),
        strokeWidth: safeDimension(data.strokeWidth, 0), radius: safeDimension(data.radius, 0),
        color: "#f4f7fb", fontSize: 0, fontFamily: "sans-serif", fontWeight: 400,
        textAlign: "left", opacity, transform: "matrix(" + matrix.join(",") + ")",
      });
    } else if (node.type === "path") {
      const data = component(node, "geometry") ?? {};
      const pathData = typeof data.pathData === "string" ? data.pathData : "";
      if (!isSafeSvgPathData(pathData)) diagnostics.push({ level: "error", code: "RENDER_INVALID_PATH_DATA", message: "Path node " + node.id + " has invalid or unsupported SVG path data" });
      else result.elements.push({
        id: node.id, type: "path", pathData, fillRule: data.fillRule === "evenodd" ? "evenodd" : "nonzero",
        width: safeDimension(data.width, 1000), height: safeDimension(data.height, 1000),
        fill: color(data.fill, "#55d6e8"), stroke: color(data.stroke, "transparent"),
        strokeWidth: safeDimension(data.strokeWidth, 0), radius: 0, color: "#f4f7fb",
        fontSize: 0, fontFamily: "sans-serif", fontWeight: 400, textAlign: "left",
        opacity, transform: "matrix(" + matrix.join(",") + ")",
      });
    } else if (node.type !== "group") {
      diagnostics.push({ level: "warning", code: "RENDER_UNSUPPORTED_NODE_TYPE", message: "Node type is not supported by the 2D adapter: " + node.type });
    }
    for (const childId of node.childIds ?? []) visit(childId, matrix, opacity);
  };
  for (const rootId of scene.rootNodeIds) visit(rootId, identity, 1);
  return result;
}
