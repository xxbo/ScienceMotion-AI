import type { LayoutFrameMeasurement, LayoutNodeMeasurement, LayoutRect } from "../../contracts/layout-inspection";
import type { ProjectRenderModel } from "./project-render-model";

/** Runs in the production composition's browser, after fonts and layout have settled. */
export function measureProjectLayout(model: ProjectRenderModel, frame: number): LayoutFrameMeasurement {
  const roots = document.querySelectorAll<HTMLElement>("[data-project-graph-root]");
  if (roots.length !== 1) throw new Error("Expected exactly one production Project Graph surface");
  const root = roots[0], viewport = root.getBoundingClientRect();
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const rect = (r: DOMRect): LayoutRect => ({ x: round(r.x - viewport.x), y: round(r.y - viewport.y),
    width: round(r.width), height: round(r.height) });
  const elements = new Map(Array.from(root.querySelectorAll<HTMLElement | SVGElement>("[data-node-id]"))
    .filter(element => !element.closest("[data-project-transition-outgoing]"))
    .map((element) => [element.getAttribute("data-node-id")!, element]));
  if (elements.size !== model.elements.length) throw new Error("Production DOM and render model have different node counts");
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
  const fontCache = new Map<string, Pick<NonNullable<LayoutNodeMeasurement["text"]>, "firstFamilyStatus" | "fontProbeWidths">>();
  const nodes = model.elements.map((node): LayoutNodeMeasurement => {
    const element = elements.get(node.id);
    if (!element) throw new Error(`Missing production DOM node: ${node.id}`);
    const bounds = rect(element.getBoundingClientRect());
    let contentBounds = bounds;
    let text: LayoutNodeMeasurement["text"];
    if (node.type === "text") {
      const style = getComputedStyle(element);
      const range = document.createRange(); range.selectNodeContents(element);
      const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map(rect);
      range.detach();
      if (lines.length) {
        const x = Math.min(...lines.map((r) => r.x)), y = Math.min(...lines.map((r) => r.y));
        contentBounds = { x, y, width: round(Math.max(...lines.map((r) => r.x + r.width)) - x),
          height: round(Math.max(...lines.map((r) => r.y + r.height)) - y) };
      } else contentBounds = { x: bounds.x, y: bounds.y, width: 0, height: 0 };
      const first = node.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      const key = JSON.stringify([first, style.fontSize, style.fontWeight]);
      let probe = fontCache.get(key);
      if (!probe) {
        const generic = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-serif|ui-sans-serif|ui-monospace)$/i.test(first);
        const widths: number[] = [];
        if (context && !generic && /^[\p{L}\p{N} _-]+$/u.test(first)) {
          // CSS computed font-family is only a requested stack. Width comparison is a heuristic,
          // not proof of the exact installed font or per-glyph fallback.
          for (const fallback of ["monospace", "serif", "sans-serif"]) {
            context.font = `${style.fontWeight} ${style.fontSize} ${fallback}`;
            widths.push(round(context.measureText("mmmmWWWW012345 汉字科普").width));
            context.font = `${style.fontWeight} ${style.fontSize} "${first}", ${fallback}`;
            widths.push(round(context.measureText("mmmmWWWW012345 汉字科普").width));
          }
        }
        probe = { firstFamilyStatus: generic ? "generic" : widths.length !== 6 ? "unverified" :
          [0,2,4].every((i) => Math.abs(widths[i] - widths[i+1]) < 0.01) ? "fallback-likely" : "available-likely",
          fontProbeWidths: widths };
        fontCache.set(key, probe);
      }
      text = { lineCount: lines.length, lineBoxes: lines.slice(0, 32), lineBoxesTruncated: lines.length > 32,
        layoutWidth: element.scrollWidth, layoutHeight: element.scrollHeight,
        overflowX: round(Math.max(0, element.scrollWidth - node.width)),
        overflowY: round(Math.max(0, element.scrollHeight - node.height)),
        requestedFontFamily: node.fontFamily, computedFontFamily: style.fontFamily,
        fontSize: Number.parseFloat(style.fontSize), fontWeight: style.fontWeight, ...probe };
    }
    return { nodeId: node.id, type: node.type, opacity: node.opacity,
      declared: { width: node.width, height: node.height }, elementBounds: bounds, contentBounds,
      boundsKind: node.type === "text" ? "text-line-boxes" : "element-box",
      viewportOverflow: { left: round(Math.max(0, -contentBounds.x)), top: round(Math.max(0, -contentBounds.y)),
        right: round(Math.max(0, contentBounds.x + contentBounds.width - viewport.width)),
        bottom: round(Math.max(0, contentBounds.y + contentBounds.height - viewport.height)) },
      ...(text ? { text } : {}) };
  });
  return { frame, projectId: model.projectId, ...(model.sceneId ? { sceneId: model.sceneId } : {}),
    viewport: { x: 0, y: 0, width: round(viewport.width), height: round(viewport.height) },
    environment: { userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio, fontsStatus: document.fonts.status }, nodes };
}
