import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CreativeSession } from "../contracts/creative-host";
import type { FollowPathParameters, ProjectDocument, SceneNode } from "../contracts/project";
import { openCreativeHost } from "./creative-host";

const projectId = "editable-motion";
const keys = [{ frame: 0, value: 0 }, { frame: 48, value: 1 }];
const baseBinding = { constraintId: "motion", followerNodeId: "dot", guideNodeId: "guide", keyframes: keys, anchor: [5, 5], loop: true };
const revision = (project: ProjectDocument) => project.revisions.at(-1)!.id;
type EditResult = { revisionId: string; changedConstraintIds: string[]; changedNodeIds: string[] };
const node = (id: string, type: SceneNode["type"], data: Record<string, unknown>): SceneNode => ({
  id, type, name: id, transform: { position: [10, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  components: [{ kind: "geometry", data }, { kind: "custom", data: { note: "Preserve this component" } }],
});

async function fixture(t: import("node:test").TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "motion-edit-"));
  const host = await openCreativeHost({ directory });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const session = host.createSession({ projectId, permissions: ["project.read", "project.write", "artifact.read"], toolIds: [
    "project.create", "project.scene.create", "project.patch.apply", "project.inspect", "animation.path.bind", "animation.path.edit",
  ] });
  let count = 0;
  const call = (toolId: string, input: object, actor: CreativeSession = session, callId = String(++count), idempotencyKey?: string) =>
    actor.invoke({ toolId, toolVersion: "1.0.0", runId: "motion-edit", callId, input, idempotencyKey });
  const invoke = async <T>(toolId: string, input: object) => {
    const result = await call(toolId, input);
    assert.ok(result.ok, JSON.stringify(result.diagnostics));
    return result.output as T;
  };
  await invoke("project.create", { name: "Motion", episodeId: "motion", durationFrames: 80 });
  await invoke("project.scene.create", { sceneId: "scene", name: "Scene", durationFrames: 80 });
  const second = await invoke<{ revisionId: string }>("project.scene.create", { sceneId: "other", name: "Other scene", durationFrames: 80 });
  const dot = (id: string) => node(id, "shape", { primitive: "circle", width: 10, height: 10, fill: "#ffbd56" });
  const guide = node("guide", "path", { pathData: "M0 0 H100", stroke: "#647b96", strokeWidth: 2, customDetail: "Keep" });
  await invoke("project.patch.apply", { schemaVersion: "1.3.0", projectId, baseRevisionId: second.revisionId, patches: [
    ...[guide, dot("dot"), dot("other-dot")].map(item => ({ op: "add-node", sceneId: "scene", node: item })),
    { op: "add-node", sceneId: "other", node: dot("foreign-dot") },
  ] });
  const inspect = () => invoke<ProjectDocument>("project.inspect", {});
  return { host, session, call, invoke, inspect, guide };
}

test("motion tools commit one scoped patch and preserve the guide style, anchor, and all unrelated project data", async (t) => {
  const { invoke, inspect, guide } = await fixture(t);
  const initial = await inspect();
  const bind = await invoke<EditResult>("animation.path.bind", { ...baseBinding, baseRevisionId: revision(initial) });
  assert.deepEqual(bind, { revisionId: bind.revisionId, changedConstraintIds: ["motion"], changedNodeIds: [] });
  const before = await inspect();
  assert.deepEqual(before.nodes, initial.nodes);
  assert.equal(before.revisions.at(-1)?.parentRevisionId, revision(initial));
  const pathData = "M0 0 L40 30 H96";
  const keyframes = [{ frame: 0, value: 1 }, { frame: 24, value: 0, interpolation: "bezier", easing: "ease-out" }];
  const edit = await invoke<EditResult>("animation.path.edit", { baseRevisionId: bind.revisionId, constraintId: "motion", changes: { pathData, keyframes, loop: false } });
  assert.deepEqual(edit, { revisionId: edit.revisionId, changedConstraintIds: ["motion"], changedNodeIds: ["guide"] });
  const after = await inspect();
  assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.equal(after.revisions.at(-1)?.parentRevisionId, bind.revisionId);
  assert.deepEqual(after, { ...before, project: { ...before.project, updatedAt: after.project.updatedAt }, revisions: after.revisions,
    nodes: before.nodes.map(item => item.id === guide.id ? { ...guide, components: [
      { ...guide.components[0], data: { ...guide.components[0].data, pathData } }, guide.components[1],
    ] } : item), constraints: [{ ...before.constraints[0], parameters: { pathNodeId: "guide", anchor: [5, 5], progress: { keyframes, loop: false } } }],
  });
});

test("motion diagnostics identify the attempted binding, guide, and bad frames without committing partial changes", async (t) => {
  const { call, invoke, inspect } = await fixture(t);
  const bind = await invoke<EditResult>("animation.path.bind", { ...baseBinding, baseRevisionId: revision(await inspect()) });
  const before = await inspect();
  const edit = (changes: object, constraintId = "motion") => ({ baseRevisionId: bind.revisionId, constraintId, changes });
  const alternate = (changes: object) => ({ ...baseBinding, baseRevisionId: bind.revisionId, constraintId: "next", ...changes });
  const ids = { constraintId: "motion", followerNodeId: "dot", guideNodeId: "guide" };
  const bad: Array<[string, object, string, object, RegExp]> = [
    ["animation.path.bind", alternate({ constraintId: "motion" }), "FOLLOW_PATH_ID_EXISTS", ids, /already exists/],
    ["animation.path.bind", alternate({ followerNodeId: "foreign-dot" }), "FOLLOW_PATH_BINDING_INVALID", { ...ids, constraintId: "next", followerNodeId: "foreign-dot" }, /share one scene/],
    ["animation.path.bind", alternate({}), "FOLLOW_PATH_BINDING_INVALID", { ...ids, constraintId: "next" }, /another enabled position driver/],
    ["animation.path.edit", edit({ loop: false }, "missing"), "FOLLOW_PATH_NOT_EDITABLE", { constraintId: "missing" }, /existing, enabled/],
    ["animation.path.edit", edit({ pathData: "M0 0 C4 17 8 6 20 20" }), "FOLLOW_PATH_GUIDE_INVALID", ids, /supports M, L, H, V/],
    ["animation.path.edit", edit({ pathData: "M0 0 V60", keyframes: [{ frame: 24, value: 1.01 }] }), "FOLLOW_PATH_TIMING_INVALID", { ...ids, frame: 24 }, /numbers in \[0, 1\]/],
    ["animation.path.edit", edit({ keyframes: [{ frame: 81, value: 1 }] }), "FOLLOW_PATH_TIMING_INVALID", { ...ids, frame: 81, durationFrames: 80 }, /scene duration/],
  ];
  for (const [toolId, input, code, details, message] of bad) {
    const result = await call(toolId, input);
    assert.equal(result.ok, false);
    assert.equal(result.metadata?.outcomeUnknown, undefined);
    assert.deepEqual({ ...result.diagnostics[0], message: undefined }, { level: "error", code, details, message: undefined });
    assert.match(result.diagnostics[0].message, message);
    assert.deepEqual(await inspect(), before);
  }
});

test("two followers may share a guide, but a one-binding edit cannot move both of them", async (t) => {
  const { call, invoke, inspect } = await fixture(t);
  const first = await invoke<EditResult>("animation.path.bind", { ...baseBinding, baseRevisionId: revision(await inspect()) });
  const second = await invoke<EditResult>("animation.path.bind", { ...baseBinding, baseRevisionId: first.revisionId, constraintId: "other-motion", followerNodeId: "other-dot" });
  const before = await inspect();
  const edit = (changes: object) => ({ baseRevisionId: second.revisionId, constraintId: "motion", changes });
  const denied = await call("animation.path.edit", edit({ pathData: "M0 0 V60", loop: false }));
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].code, "FOLLOW_PATH_SHARED_GUIDE");
  assert.deepEqual(denied.diagnostics[0].details, { constraintId: "motion", followerNodeId: "dot", guideNodeId: "guide", otherConstraintIds: ["other-motion"] });
  assert.deepEqual(await inspect(), before);
  const timing = await invoke<EditResult>("animation.path.edit", edit({ keyframes: [{ frame: 0, value: 1 }] }));
  assert.deepEqual(timing.changedNodeIds, []);
  const after = await inspect();
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.constraints[1], before.constraints[1]);
  assert.deepEqual((after.constraints[0].parameters as FollowPathParameters).progress, { keyframes: [{ frame: 0, value: 1 }], loop: true });
});

test("motion tools honor grants, compatible patch versions, replay, and the serial base revision check", async (t) => {
  const { host, session, call, invoke, inspect } = await fixture(t);
  const initial = await inspect(), baseRevisionId = revision(initial);
  const reader = host.createSession({ projectId, permissions: ["project.read"], toolIds: ["animation.path.bind"] });
  const bind = { ...baseBinding, baseRevisionId };
  assert.equal((await call("animation.path.bind", bind, reader)).diagnostics[0].code, "HOST_TOOL_DENIED");
  const patch = await call("project.patch.apply", { schemaVersion: "1.2.0", projectId, baseRevisionId,
    patches: [{ op: "bind-follow-path", ...baseBinding }] });
  assert.equal(patch.diagnostics[0].code, "TOOL_INPUT_INVALID");
  assert.deepEqual(await inspect(), initial);

  const added = await invoke<EditResult>("animation.path.bind", bind);
  const edit = (pathData: string) => ({ baseRevisionId: added.revisionId, constraintId: "motion", changes: { pathData } });
  const [left, right] = await Promise.all([
    call("animation.path.edit", edit("M0 0 H40"), session, "left", "edit-left"),
    call("animation.path.edit", edit("M0 0 H60"), session, "right", "edit-right"),
  ]);
  assert.notEqual(left.ok, right.ok);
  const accepted = left.ok ? left : right, rejected = left.ok ? right : left;
  const current = await inspect();
  assert.equal(current.revisions.length, initial.revisions.length + 2);
  assert.equal(rejected.diagnostics[0].code, "PROJECT_REVISION_CONFLICT");
  assert.deepEqual(rejected.diagnostics[0].details, { constraintId: "motion", expectedRevisionId: added.revisionId, currentRevisionId: revision(current) });
  assert.equal(rejected.metadata?.outcomeUnknown, undefined);
  const replay = await call("animation.path.edit", edit(left.ok ? "M0 0 H40" : "M0 0 H60"), session, "replay", left.ok ? "edit-left" : "edit-right");
  assert.ok(replay.ok, JSON.stringify(replay.diagnostics));
  assert.deepEqual(replay.output, accepted.output);
  assert.deepEqual(await inspect(), current);
});
