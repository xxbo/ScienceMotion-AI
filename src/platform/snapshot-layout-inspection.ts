import type { LayoutFrameMeasurement, LayoutInspectionIssue, SnapshotLayoutInspectionReport } from "../contracts/layout-inspection";
import { buildProjectRenderModel } from "../renderers/remotion/project-render-model";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { chooseInspectionFrames, SnapshotInspectionError } from "./snapshot-inspection";

export const MAX_LAYOUT_FRAMES = 12;
const reject = (code: string, message: string): never => { throw new SnapshotInspectionError(code, message); };
export function prepareLayoutInspection(saved: ProjectSnapshot, requested?: readonly number[]) {
  const p = saved.document, sequence = p.sequences[0];
  if (saved.contentHash !== hashProject(p)) reject("INSPECT_SNAPSHOT_CORRUPT", "Snapshot content hash does not match its document");
  if (saved.projectId !== p.project.id || !p.revisions.at(-1)?.id)
    reject("INSPECT_SNAPSHOT_INVALID", "Snapshot project/revision identity is inconsistent");
  const selection = chooseInspectionFrames(p, requested, MAX_LAYOUT_FRAMES);
  const work = selection.frames.length * Math.max(1, p.nodes.length) *
    (1 + p.animationTracks.reduce((sum, t) => sum + 1 + t.keyframes.length, 0));
  if (work > 1_000_000 || sequence.width > 4096 || sequence.height > 4096)
    reject("LAYOUT_WORK_LIMIT", "Browser layout exceeds its viewport/model budget; request fewer frames or a smaller project");
  const models = selection.frames.map((frame) => buildProjectRenderModel(p, frame));
  const drawn = models.map(model => model.crossfade ? [...model.elements, ...model.crossfade.outgoingElements] : model.elements);
  if (drawn.some(elements => elements.length > 200 || elements.reduce((sum, element) => sum + (element.text?.length ?? 0), 0) > 20000) ||
    drawn.reduce((sum, elements) => sum + elements.length, 0) > 1200)
    reject("LAYOUT_WORK_LIMIT", "Browser layout is limited to 200 nodes and 20,000 text characters per frame, and 1,200 node-frames");
  return { ...selection, models, explicit: requested !== undefined };
}

export function finishLayoutInspection(saved: ProjectSnapshot, prepared: ReturnType<typeof prepareLayoutInspection>,
  measured: LayoutFrameMeasurement[], elapsedMs: number): SnapshotLayoutInspectionReport {
  if (measured.length !== prepared.frames.length) reject("LAYOUT_SURFACE_MISMATCH", "Browser did not measure every requested frame exactly once");
  const p = saved.document, seq = p.sequences[0];
  const report: SnapshotLayoutInspectionReport = { schemaVersion: "1.0.0", inspector: { id: "remotion.browser-layout", version: "1.0.0" },
    snapshotId: saved.id, snapshotHash: saved.contentHash, projectId: saved.projectId, revisionId: p.revisions.at(-1)!.id,
    sequenceId: seq.id, outcome: "no-issues-detected",
    coverage: { selection: prepared.explicit ? "explicit" : "automatic",
      mode: prepared.frames.length === seq.durationFrames ? "all-frames" : "sampled-frames",
      totalFrames: seq.durationFrames, checkedFrames: prepared.frames, omittedCandidateFrames: prepared.omitted,
      checks: ["snapshot-integrity", "scene-selection", "render-model-diagnostics", "browser-element-bounds", "text-wrap-and-declared-box", "viewport-overflow", "font-fallback-heuristic"],
      notChecked: ["glyph-ink-bounds", "exact-glyph-font-resolution", "svg-path-extents", "chart-internal-text", "occlusion", "final-pixels", "audio", "scientific-accuracy", "presentation-quality",
        ...(prepared.frames.length < seq.durationFrames ? ["unsampled-frames"] : [])] },
    frames: measured, issues: [], issuesTruncated: false, omittedIssueOccurrences: 0,
    cost: { elapsedMs: Math.round(elapsedMs), browserFrames: measured.length, encodedImageFrames: 0, visualModelCalls: 0 } };
  const add = (issue: LayoutInspectionIssue) => {
    if (report.issues.length < 200) report.issues.push(issue);
    else { report.issuesTruncated = true; report.omittedIssueOccurrences++; }
  };
  for (const [index, frame] of prepared.frames.entries()) {
    const model = prepared.models[index], actual = measured[index];
    if (actual.frame !== frame || actual.projectId !== p.project.id || actual.sceneId !== model.sceneId ||
      actual.viewport.width !== seq.width || actual.viewport.height !== seq.height || actual.environment.fontsStatus !== "loaded" ||
      actual.nodes.length !== model.elements.length || new Set(actual.nodes.map((n) => n.nodeId)).size !== actual.nodes.length ||
      actual.nodes.some((n, i) => n.nodeId !== model.elements[i].id || n.type !== model.elements[i].type ||
        n.declared.width !== model.elements[i].width || n.declared.height !== model.elements[i].height ||
        n.opacity !== model.elements[i].opacity))
      reject("LAYOUT_SURFACE_MISMATCH", "Browser project, scene, viewport, nodes, fonts or frame differ from the production render model");
    const location = { frame, ...(model.sceneId ? { sceneId: model.sceneId } : {}) };
    for (const d of model.diagnostics) add({ ...location, level: d.level, code: d.code, message: d.message,
      ...(d.nodeId ? { nodeId: d.nodeId } : {}) });
    if (p.sequences.length > 1) add({ ...location, level: "warning", code: "LAYOUT_MULTIPLE_SEQUENCES", message: "Only the first sequence is measured" });
    if (model.sceneId && !actual.nodes.some((n) => n.opacity > 0 && n.contentBounds.width > 0 && n.contentBounds.height > 0))
      add({ ...location, level: "warning", code: "LAYOUT_NO_VISIBLE_CANDIDATES", message: "No positive-opacity, positive-size candidates were measured" });
    for (const node of actual.nodes) {
      if (node.opacity <= 0 || node.contentBounds.width <= 0 || node.contentBounds.height <= 0) continue;
      const base = { ...location, nodeId: node.nodeId, level: "warning" as const };
      if (Object.values(node.viewportOverflow).some((value) => value > 1)) add({ ...base, code: "LAYOUT_VIEWPORT_OVERFLOW",
        message: "Measured content boxes cross the viewport edge; check whether the exit or bleed is intentional" });
      if (node.text && (node.text.overflowX > 1 || node.text.overflowY > 1)) add({ ...base, code: "LAYOUT_TEXT_OVERFLOW",
        message: "Actual text layout exceeds its declared width/height; the renderer allows text to grow vertically" });
      if (node.text?.firstFamilyStatus === "fallback-likely") add({ ...base, code: "LAYOUT_FONT_FALLBACK_LIKELY",
        message: "The first font family matches all generic fallback probes; availability is heuristic, not exact per-glyph font identity" });
    }
  }
  if (report.issues.length || report.issuesTruncated) report.outcome = "issues-found";
  return report;
}
