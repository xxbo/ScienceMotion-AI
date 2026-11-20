import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CreativeSession } from "../contracts/creative-host";
import type { ProjectDocument, SceneNode } from "../contracts/project";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";
import { openCreativeHost } from "./creative-host";
import { isSafeSvgPathData, MAX_PATH_DATA_LENGTH } from "./graphic-values";

test("complete SVG path commands accept compact arcs and reject incomplete groups and nonfinite coordinates", () => {
  for (const path of ["M0 0 L10-20 30 40Z", "m.3.7,1e-3-2E+1z", "M0 0a10 20 0 0116 30",
    "M 0 0 C 10 10 20 20 30 0 S 40 10 50 0 Q 60 20 70 0 T 90 0 H10 V20 Z m5 5"]) {
    assert.ok(isSafeSvgPathData(path), path);
  }
  for (const path of ["", "M", "L0 0", "M0 0L10", "M,0 0", "M0,,0", "M0 0,", "M0 0Z 1 2",
    "M0 0A10 20 0 2 1 16 30", "M0 0 A10 20 0 1 1 16", "M0 1e999", "M0 0 <svg/>",
    "M0 0" + " ".repeat(MAX_PATH_DATA_LENGTH)]) {
    assert.equal(isSafeSvgPathData(path), false, path.slice(0, 40));
  }
});

test("graphics edits preserve legacy node data and use the same project revision guard under concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "graphics-edits-"));
  const host = await openCreativeHost({ directory });
  try {
    const projectId = "legacy-graphics";
    const session = host.createSession({ projectId, permissions: ["project.read", "project.write", "artifact.read"],
      toolIds: ["project.create", "project.inspect", "project.scene.create", "project.patch.apply", "graphics.2d.edit"] });
    let callId = 0;
    const call = (toolId: string, input: unknown, actor: CreativeSession = session) =>
      actor.invoke({ toolId, toolVersion: "1.0.0", runId: "graphics-edits", callId: String(++callId), input });
    const invoke = async <T>(toolId: string, input: unknown) => {
      const result = await call(toolId, input);
      assert.ok(result.ok, JSON.stringify(result.diagnostics));
      return result.output as T;
    };
    await invoke("project.create", { name: "Graphics", episodeId: "graphics" });
    const scene = await invoke<{ revisionId: string }>("project.scene.create", { sceneId: "s", name: "Scene", durationFrames: 120 });
    const legacy: SceneNode = {
      id: "legacy-rect", type: "shape", name: "Original",
      transform: { position: [4, 20, 0], rotation: [0, 0, 12], scale: [1, 2, 1] },
      metadata: { caption: "Keep" },
      components: [{ kind: "geometry", data: { primitive: "rectangle", width: 42, height: 34, customDetail: "keep" } },
        { kind: "custom", data: { label: "Keep as well" } }],
    };
    const chart: SceneNode = { id: "legacy-chart", name: "Chart", type: "shape", transform: legacy.transform,
      components: [{ kind: "geometry", data: { primitive: "chart", chartType: "bar", chartData: [{ label: "A", value: 1 }, { label: "B", value: 2 }] } }] };
    const before = await invoke<{ revisionId: string }>("project.patch.apply", { schemaVersion: "1.3.0", projectId,
      baseRevisionId: scene.revisionId, patches: [legacy, chart].map(node => ({ op: "add-node", sceneId: "s", node })) });
    const data = [{ label: "B", value: -2 }, { label: "A", value: 7 }];
    const edited = await invoke<{ revisionId: string; changedNodeIds: string[] }>("graphics.2d.edit", { baseRevisionId: before.revisionId, edits: [
      { kind: "shape", nodeId: legacy.id, changes: { fill: "#1234", radius: 8 } },
      { kind: "chart", nodeId: chart.id, changes: { chartType: "line", data, strokeWidth: 5 } },
      { kind: "shape", nodeId: legacy.id, changes: { width: 55 } },
    ] });
    assert.deepEqual(edited.changedNodeIds, [legacy.id, chart.id]);
    const current = await invoke<ProjectDocument>("project.inspect", {});
    assert.deepEqual(current.nodes[0], { ...legacy, components: [
      { kind: "geometry", data: { ...legacy.components[0].data, fill: "#1234", radius: 8, width: 55 } }, legacy.components[1],
    ] });
    const [shape, projectedChart] = buildProjectRenderModel(current, 0).elements;
    assert.equal(shape.primitive, "rect");
    assert.equal(projectedChart.chartType, "line");
    assert.deepEqual(projectedChart.chartData, data);
    assert.equal(projectedChart.strokeWidth, 5);

    const change = (fill: string) => ({ baseRevisionId: edited.revisionId, edits: [{ kind: "shape", nodeId: legacy.id, changes: { fill } }] });
    const reader = host.createSession({ projectId, permissions: ["project.read"], toolIds: ["graphics.2d.edit"] });
    assert.equal((await call("graphics.2d.edit", change("red"), reader)).diagnostics[0].code, "HOST_TOOL_DENIED");
    const replies = await Promise.all([call("graphics.2d.edit", change("red")), call("graphics.2d.edit", change("green"))]);
    assert.equal(replies.filter(reply => reply.ok).length, 1);
    assert.match(JSON.stringify(replies.find(reply => !reply.ok)?.diagnostics), /Revision conflict/);
    const updated = await invoke<ProjectDocument>("project.inspect", {});
    assert.equal(updated.revisions.length, current.revisions.length + 1);
    assert.deepEqual(updated.nodes[1], current.nodes[1]);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
