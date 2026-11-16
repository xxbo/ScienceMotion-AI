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
