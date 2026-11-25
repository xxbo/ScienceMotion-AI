import assert from "node:assert/strict";
import type { FollowPathParameters, ProjectDocument } from "../../src/contracts/project";
import { prepareFollowPaths } from "../../src/platform/follow-path";
import { assertCreativeDocument } from "../../src/platform/project-creative-edits";
import { hashProject, InMemorySnapshotStore } from "../../src/platform/project-snapshots";
import { buildProjectRenderModel } from "../../src/renderers/remotion/project-render-model";
import type { PendulumReference } from "./pendulum-reference";

/** Retain A unchanged. Move just the bob from an angular hierarchy to genuine path motion. */
export function derivePendulumPathReference(reference: PendulumReference) {
  const original = reference.snapshot;
  assert.equal(hashProject(original.document), original.contentHash);
  const project = structuredClone(original.document);
  const { amplitudeDegrees, bobRadiusPx } = reference.workload.motion;
  const scene = project.scenes[0];
  const arm = project.nodes.find(node => node.id === "swing-arm")!;
  const bob = project.nodes.find(node => node.id === "pendulum-bob")!;
  const guide = project.nodes.find(node => node.id === "swing-guide")!;
  const guideData = guide.components[0].data;
  const originalGuide = guideData.pathData, children = arm.childIds;
  assert.ok(typeof originalGuide === "string");
  const split = originalGuide.lastIndexOf(" M ");
  assert.ok(split > 0, "The pendulum artwork contains a separate swing arc");
  const route = { ...structuredClone(guide), id: "swing-route", name: "Swing arc" };
  route.components[0].data.pathData = originalGuide.slice(split + 1);
  guideData.pathData = originalGuide.slice(0, split);
  project.nodes.push(route);
  scene.rootNodeIds.splice(scene.rootNodeIds.indexOf(guide.id) + 1, 0, route.id);

  assert.ok(children && children.includes(bob.id) && bob.parentId === arm.id);
  arm.childIds = children.filter(id => id !== bob.id);
  delete bob.parentId;
  const atRest = reference.workload.checkpoints.find(sample => sample.phase === "lowest-rightward")!.center;
  bob.transform.position = [atRest[0] - bobRadiusPx, atRest[1] - bobRadiusPx, 0];
  scene.rootNodeIds.splice(scene.rootNodeIds.indexOf(arm.id) + 1, 0, bob.id);
  const rotation = project.animationTracks.find(track => track.targetNodeId === arm.id && track.targetProperty === "transform.rotation")!;
  const parameters: FollowPathParameters = {
    pathNodeId: route.id,
    anchor: [bobRadiusPx, bobRadiusPx],
    // The rod keeps A's rotation keys. The separate bob samples the arc using the same timing and easing.
    progress: { keyframes: rotation.keyframes.map(({ value, ...key }) => ({
      ...key, value: (amplitudeDegrees - (value as number[])[2]) / (2 * amplitudeDegrees),
    })) },
  };
  const constraintId = "pendulum-bob-follows-arc";
  project.constraints.push({ id: constraintId, type: "follow-path", sourceNodeId: bob.id, targetNodeId: route.id, enabled: true, parameters });
  const createdAt = "2026-11-25T01:00:00.000Z";
  project.project.updatedAt = createdAt;
  project.revisions.push({ id: "revision-path-following", parentRevisionId: original.document.revisions.at(-1)!.id,
    createdAt, message: "Drive the reference bob on the authored swing arc", author: "ScienceMotion" });
  assertCreativeDocument(project);
  const snapshot = new InMemorySnapshotStore().save(project, { id: "pendulum-path-motion-v1", createdAt });

  const from = prepareFollowPaths(original.document), to = prepareFollowPaths(project);
  assert.equal(from.byNode.size, 0);
  assert.equal(to.byNode.get(bob.id)?.constraintId, constraintId);
  const center = (document: ProjectDocument, frame: number, motion: typeof from) => {
    const model = buildProjectRenderModel(document, frame, undefined, motion);
    assert.deepEqual(model.diagnostics, []);
    const element = model.elements.find(node => node.id === bob.id)!;
    const [a, b, c, d, x, y] = element.transform.slice(7, -1).split(",").map(Number);
    return [x + (a + c) * bobRadiusPx, y + (b + d) * bobRadiusPx] as const;
  };
  const { startFrame, durationFrames } = reference.workload.video;
  let maxCenterErrorPx = 0;
  for (let frame = startFrame; frame < startFrame + durationFrames; frame++) {
    const [ax, ay] = center(original.document, frame, from), [bx, by] = center(project, frame, to);
    maxCenterErrorPx = Math.max(maxCenterErrorPx, Math.hypot(ax - bx, ay - by));
  }
  // A paints the arc with SVG coordinates rounded to a thousandth of a pixel.
  assert.ok(maxCenterErrorPx < 0.002, `Path projection drifted from the reference by ${maxCenterErrorPx} px`);
  const disabled = structuredClone(project);
  disabled.constraints.find(item => item.id === constraintId)!.enabled = false;
  const testFrame = reference.workload.motion.releaseFrame;
  const [x, y] = center(disabled, testFrame, prepareFollowPaths(disabled));
  const [actualX, actualY] = center(project, testFrame, to);
  assert.ok(Math.hypot(x - actualX, y - actualY) > 20, "Without its path binding, the independent bob rests at the lowest point");
  assert.equal(hashProject(original.document), original.contentHash);
  return { snapshot, projection: { constraintId, guideNodeId: route.id, checkedFrames: durationFrames, maxCenterErrorPx,
    disabledAt: { frame: testFrame, center: [x, y] } } };
}
