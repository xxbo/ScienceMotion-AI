import test from "node:test";
import assert from "node:assert/strict";
import demo from "../../examples/project-graph-demo.props.json";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";
import type { ProjectDocument } from "../contracts/project";

const project = demo.project as unknown as ProjectDocument;

test("project renderer selects shot scene and maps text and shape nodes", () => {
  const model = buildProjectRenderModel(project, 40);
  assert.equal(model.sceneId, "scene-water-cycle");
  assert.equal(model.width, 1920);
  assert.ok(model.elements.some((e) => e.id === "title" && e.type === "text" && e.text?.includes("水循环")));
  assert.ok(model.elements.some((e) => e.id === "ocean" && e.type === "shape" && e.primitive === "rect"));
});

test("project renderer evaluates keyframes at scene-local frame", () => {
  const a = buildProjectRenderModel(project, 0).elements.find((e) => e.id === "water-drop")!;
  const b = buildProjectRenderModel(project, 150).elements.find((e) => e.id === "water-drop")!;
  assert.notEqual(a.transform, b.transform);
  assert.ok(b.opacity > a.opacity);
});

test("explicit scene selection bypasses timeline shot selection", () => {
  const model = buildProjectRenderModel(project, 299, "scene-water-cycle");
  assert.equal(model.sceneId, "scene-water-cycle");
  assert.equal(model.sceneFrame, 299);
});

test("unsupported node types produce diagnostics without crashing the whole frame", () => {
  const changed = structuredClone(project);
  changed.nodes.push({ id: "unsupported", name: "3D model", type: "mesh", transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }, components: [] });
  changed.scenes[0].rootNodeIds.push("unsupported");
  const model = buildProjectRenderModel(changed, 0);
  assert.ok(model.diagnostics.some((d) => d.code === "RENDER_UNSUPPORTED_NODE_TYPE"));
});
\n\ntest("project renderer supports structured SVG paths and rejects markup payloads", () => {\n  const changed = structuredClone(project);\n  changed.nodes.push({ id: "orbit-path", name: "Orbit", type: "path", transform: { position: [10,20,0], rotation: [0,0,0], scale: [1,1,1] }, components: [{ kind: "geometry", data: { pathData: "M 0 50 C 20 0 80 0 100 50 S 80 100 50 100 Z", width: 100, height: 100, fill: "#55d6e8", stroke: "#ffffff", strokeWidth: 3 } }] });\n  changed.scenes[0].rootNodeIds.push("orbit-path");\n  const model = buildProjectRenderModel(changed, 0);\n  const path = model.elements.find((element) => element.id === "orbit-path");\n  assert.equal(path?.type, "path");\n  assert.ok(path?.pathData?.startsWith("M 0 50"));\n  const invalid = structuredClone(changed);\n  invalid.nodes.find((node) => node.id === "orbit-path")!.components[0].data.pathData = "<svg onload=alert(1)>";\n  const rejected = buildProjectRenderModel(invalid, 0);\n  assert.ok(rejected.diagnostics.some((entry) => entry.code === "RENDER_INVALID_PATH_DATA"));\n});\n