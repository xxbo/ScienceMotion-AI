import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectGraphFrame } from "../compositions/ProjectGraphComposition";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";
import type { ProjectDocument } from "../contracts/project";
import demo from "../../examples/project-graph-demo.props.json";

function renderChart(chartType: "bar" | "line", values: number[], options: Record<string, unknown> = {}) {
  const project = structuredClone(demo.project) as unknown as ProjectDocument;
  project.animationTracks = [];
  project.nodes = [{ id: "chart", name: "Chart", type: "shape",
    transform: { position: [100, 200, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ kind: "geometry", data: { primitive: "chart", chartType, width: 640, height: 360,
      chartData: values.map((value, i) => ({ label: `Category ${i + 1}`, value })), ...options } }] }];
  project.scenes[0].rootNodeIds = ["chart"];
  return renderToStaticMarkup(createElement(ProjectGraphFrame, { model: buildProjectRenderModel(project, 0) }));
}

function tags(markup: string, name: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`<${name}\\b[^>]*${attribute}="[^"]*"[^>]*>`, "g"))].map(([tag]) => tag);
}
function numberAttribute(tag: string, name: string): number {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`));
  assert.ok(match, `Missing ${name}: ${tag}`);
  const value = Number(match[1]);
  assert.ok(Number.isFinite(value), `${name} must be finite`);
  return value;
}

test("final Project Graph frame draws signed bars around the zero axis, not a shape placeholder", () => {
  const markup = renderChart("bar", [12, -6, 0]);
  assert.match(markup, /<svg[^>]*data-node-id="chart"/);
  assert.match(markup, /transform:matrix\(1,0,0,1,100,200\)/);
  const bars = tags(markup, "rect", "data-chart-bar");
  assert.equal(bars.length, 3);
  const zero = numberAttribute(tags(markup, "line", "data-chart-zero-axis")[0], "y1");
  assert.ok(Math.abs(numberAttribute(bars[0], "y") + numberAttribute(bars[0], "height") - zero) < 1e-8);
  assert.equal(numberAttribute(bars[1], "y"), zero);
  assert.ok(numberAttribute(bars[1], "height") > 0);
  assert.equal(numberAttribute(bars[2], "height"), 0);
  assert.match(markup, />Category 1<\/text>/);
  assert.match(markup, />-6<\/text>/);
});

test("final Project Graph frame draws a data-ordered line and one marker per value", () => {
  const markup = renderChart("line", [-2, 0, 4]);
  const lines = tags(markup, "polyline", "data-chart-series");
  assert.equal(lines.length, 1);
  const points = lines[0].match(/points="([^"]+)"/)![1].split(" ").map((p) => p.split(",").map(Number));
  assert.equal(points.length, 3);
  assert.ok(points.every((point) => point.every(Number.isFinite)));
  assert.ok(points[0][0] < points[1][0] && points[1][0] < points[2][0]);
  assert.ok(points[0][1] > points[1][1] && points[1][1] > points[2][1]);
  assert.equal(tags(markup, "circle", "data-chart-point").length, 3);
  assert.equal(tags(markup, "rect", "data-chart-bar").length, 0);
});

test("all-zero, negative-only and extreme finite series retain finite SVG geometry", () => {
  for (const values of [[0, 0], [-4, -8], [1e-300, 2e-300], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
    for (const type of ["bar", "line"] as const) {
      const markup = renderChart(type, values);
      assert.doesNotMatch(markup, /(?:NaN|Infinity)/);
      assert.match(markup, /data-chart-zero-axis/);
      if (values.every((v) => v === 0)) {
        for (const bar of tags(markup, "rect", "data-chart-bar")) assert.equal(numberAttribute(bar, "height"), 0);
      }
      for (const match of markup.matchAll(/\b(?:x|y|cx|cy|x1|y1|x2|y2|width|height)="([^"]+)"/g)) {
        assert.ok(Number.isFinite(Number(match[1])));
      }
    }
  }
});

test("dense small charts keep every datum and escape full labels while thinning visible labels", () => {
  const values = Array.from({ length: 24 }, (_, i) => i - 12);
  const label = '<script>alert("x")</script> / Long category';
  const markup = renderChart("bar", values, { width: 240, height: 160, fontSize: 48,
    chartData: values.map((value) => ({ label, value })) });
  assert.equal(tags(markup, "rect", "data-chart-bar").length, 24);
  assert.ok(tags(markup, "text", "data-chart-category").length < 24);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;script&gt;/);
});
