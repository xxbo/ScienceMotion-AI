import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeHost, CreativePluginFactory, CreativeSession } from "../contracts/creative-host";
import type { ProjectDocument } from "../contracts/project";
import type { SnapshotInspectionReport } from "../contracts/inspection";
import { openCreativeHost } from "./creative-host";

let counter = 0;
const call = (session: CreativeSession, toolId: string, input: unknown = {}) => session.invoke({ toolId, toolVersion: "1.0.0", input,
  runId: "inspection-tests", callId: `call-${++counter}` });
async function source(host: CreativeHost) {
  const writer = host.createSession({ projectId: "owner", permissions: ["project.read", "project.write", "snapshot.write"],
    toolIds: ["project.create", "project.scene.create", "graphics.2d.shape.create", "project.inspect", "project.snapshot.save"] });
  for (const [id, input] of [
    ["project.create", { name: "Inspection", episodeId: "approved", durationFrames: 60, width: 640, height: 360 }],
    ["project.scene.create", { sceneId: "s", name: "S", durationFrames: 60 }],
    ["graphics.2d.shape.create", { sceneId: "s", nodeId: "box", primitive: "rect", x: 800, y: 40, width: 80, height: 80 }],
  ] as Array<[string, unknown]>) { const result = await call(writer, id, input); assert.equal(result.ok, true, JSON.stringify(result)); }
  const p = (await call(writer, "project.inspect")).output as ProjectDocument;
  assert.equal((await call(writer, "project.snapshot.save", { snapshotId: "source", revisionId: p.revisions.at(-1)!.id })).ok, true);
  return { writer, project: p };
}
const reader = (host: CreativeHost, projectId = "owner") => host.createSession({ projectId, permissions: ["snapshot.read"], toolIds: ["inspect.snapshot"] });

test("public inspection needs only snapshot.read, returns typed issues and survives restart without rendering", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspection-host-")); let host: CreativeHost | undefined;
  let rendererCalls = 0;
  const renderer = { id: "must-not-render", version: "1", async renderPreview(): Promise<never> { rendererCalls++; throw new Error("Unexpected preview"); },
    async renderVideo(): Promise<never> { rendererCalls++; throw new Error("Unexpected video"); } };
  try {
    host = await openCreativeHost({ directory: root, renderer });
    const { writer, project } = await source(host); const read = reader(host);
    const manifest = await read.manifest("inspect.snapshot");
    assert.deepEqual(manifest?.execution.permissions, ["snapshot.read"]);
    assert.ok((manifest?.outputSchema as { properties?: unknown }).properties);
    const result = await call(read, "inspect.snapshot", { snapshotId: "source", frames: [0, 30] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const report = result.output as SnapshotInspectionReport;
    assert.equal(report.outcome, "issues-found"); assert.equal(report.projectId, "owner");
    assert.equal(report.revisionId, project.revisions.at(-1)!.id);
    assert.ok(result.diagnostics.some((issue) => issue.code === "INSPECT_NODE_OUTSIDE_FRAME" && issue.details?.nodeId === "box"));
    assert.deepEqual((await call(writer, "project.inspect")).output, project);
    await host.close(); host = await openCreativeHost({ directory: root, renderer });
    assert.deepEqual((await call(reader(host), "inspect.snapshot", { snapshotId: "source", frames: [0, 30] })).output, report);
    assert.equal(rendererCalls, 0);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("inspection rejects denied grants, foreign snapshots, invalid input and out-of-range frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspection-grants-")); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root }); await source(host);
    const denied = host.createSession({ projectId: "owner", toolIds: ["inspect.snapshot"] });
    assert.equal((await denied.discover()).total, 0);
    assert.equal((await call(denied, "inspect.snapshot", { snapshotId: "source" })).ok, false);
    assert.equal((await call(reader(host, "other"), "inspect.snapshot", { snapshotId: "source" })).diagnostics[0].code, "HOST_SNAPSHOT_DENIED");
    const read = reader(host);
    for (const input of [{ snapshotId: "source", frames: [] }, { snapshotId: "source", frames: [0, 0] }, { snapshotId: "source", projectId: "other" }])
      assert.equal((await call(read, "inspect.snapshot", input)).diagnostics[0].code, "TOOL_INPUT_INVALID");
    assert.equal((await call(read, "inspect.snapshot", { snapshotId: "source", frames: [60] })).diagnostics[0].code, "INSPECT_FRAMES_INVALID");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("inspection service enforces plugin/tool rights independently of the session grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspection-service-")); let host: CreativeHost | undefined;
  const plugin: CreativePluginFactory = { id: "test.inspector", version: "1.0.0", create: (services) => ({
    manifest: { id: "test.inspector", version: "1.0.0", name: "Test inspector", description: "Exercise service authorization",
      projectSchemaVersions: ["1.1.0"], permissions: [], toolIds: ["test.inspector.bypass"] },
    tools: [{ manifest: { id: "test.inspector.bypass", version: "1.0.0", namespace: "test.inspector", pluginId: "test.inspector",
      name: "Bypass", description: "Missing service grants", category: "test", inputSchema: { type: "object" }, outputSchema: { type: "object" },
      projectSchemaVersions: ["1.1.0"],
      execution: { deterministic: true, stateful: false, destructive: false, cost: "low", idempotent: true, permissions: [] } },
      execute: async (input) => ({ ok: true, output: (input as {mode?:string}).mode === "layout"
        ? await services.inspect.layout("source",[0]) : await services.inspect.snapshot("source"), diagnostics: [] }) }],
  }) };
  try {
    host = await openCreativeHost({ directory: root, plugins: [plugin] }); await source(host);
    const session = host.createSession({ projectId: "owner", permissions: ["snapshot.read"], toolIds: ["test.inspector.bypass"] });
    assert.equal((await call(session, "test.inspector.bypass")).diagnostics[0].code, "HOST_PERMISSION_DENIED");
    assert.equal((await call(session, "test.inspector.bypass", {mode:"layout"})).diagnostics[0].code, "HOST_PERMISSION_DENIED");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("layout permission, ownership and frame checks run before any browser work; old renderers fail explicitly", async () => {
  const root=await mkdtemp(join(tmpdir(),"layout-grants-")); let host:CreativeHost|undefined; let browserCalls=0;
  const renderer={id:"layout-grants",version:"1",async renderPreview():Promise<never>{throw new Error("Unexpected PNG");},
    async renderVideo():Promise<never>{throw new Error("Unexpected MP4");},async measureLayout(){browserCalls++;return [];}};
  try {
    host=await openCreativeHost({directory:root,renderer});await source(host);
    const read=(projectId="owner",permissions:["snapshot.read"]|[]= ["snapshot.read"])=>host!.createSession({projectId,permissions,toolIds:["inspect.layout"]});
    assert.equal((await call(read("owner",[]),"inspect.layout",{snapshotId:"source"})).ok,false);
    assert.equal((await call(read("other"),"inspect.layout",{snapshotId:"source"})).diagnostics[0].code,"HOST_SNAPSHOT_DENIED");
    for(const frames of [[],[0,0],[60],Array.from({length:13},(_,i)=>i)])
      assert.equal((await call(read(),"inspect.layout",{snapshotId:"source",frames})).ok,false);
    assert.equal(browserCalls,0);
    await host.close();
    const {measureLayout:_,...oldRenderer}=renderer;
    host=await openCreativeHost({directory:root,renderer:oldRenderer});
    assert.equal((await call(read(),"inspect.layout",{snapshotId:"source",frames:[0]})).diagnostics[0].code,"HOST_LAYOUT_UNAVAILABLE");
  } finally {await host?.close();await rm(root,{recursive:true,force:true});}
});

test("revoking layout inspection cancels the browser and host close drains its work", async () => {
  const root=await mkdtemp(join(tmpdir(),"layout-cancel-"));let host:CreativeHost|undefined;
  let started!:()=>void;const admitted=new Promise<void>(resolve=>{started=resolve;});let cancelled=false;
  const renderer={id:"layout-cancel",version:"1",async renderPreview():Promise<never>{throw new Error("Unexpected PNG");},
    async renderVideo():Promise<never>{throw new Error("Unexpected MP4");},
    async measureLayout(request:import("../contracts/renderer").ProjectGraphLayoutRequest){
      assert.ok(request.signal);started();
      await new Promise<void>(resolve=>request.signal!.addEventListener("abort",()=>{cancelled=true;resolve();},{once:true}));return [];
    }};
  try {
    host=await openCreativeHost({directory:root,renderer});await source(host);
    const read=host.createSession({projectId:"owner",permissions:["snapshot.read"],toolIds:["inspect.layout"]});
    const result=call(read,"inspect.layout",{snapshotId:"source",frames:[0]});
    await admitted;read.revoke();assert.equal((await result).ok,false);await host.close();assert.equal(cancelled,true);
  } finally {await host?.close();await rm(root,{recursive:true,force:true});}
});
