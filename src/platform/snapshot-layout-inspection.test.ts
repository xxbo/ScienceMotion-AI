import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyProject } from "./empty-project";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { finishLayoutInspection, prepareLayoutInspection } from "./snapshot-layout-inspection";
import type { LayoutFrameMeasurement } from "../contracts/layout-inspection";

function saved(): ProjectSnapshot {
  const p = createEmptyProject({ id: "p", name: "Layout", episodeId: "approved", width: 640, height: 360, durationFrames: 90 });
  p.scenes = [{ id: "scene", name: "Scene", durationFrames: 90, rootNodeIds: ["text"] }];
  p.nodes = [{ id: "text", name: "Text", type: "text", transform: { position: [20,20,0], rotation: [0,0,0], scale: [1,1,1] },
    components: [{ kind: "text", data: { text: "Measured", width: 200, height: 40, fontSize: 24 } }] }];
  return { id: "saved", projectId: "p", schemaVersion: "1.1.0", createdAt: p.project.createdAt, contentHash: hashProject(p), document: p };
}
const measurement = (frame = 0): LayoutFrameMeasurement => ({ frame, sceneId: "scene", projectId: "p",
  viewport: { x:0,y:0,width:640,height:360 }, environment: { userAgent: "test-browser", devicePixelRatio:1,fontsStatus:"loaded" },
  nodes: [{ nodeId: "text", type: "text", opacity:1, declared:{width:200,height:40},
    elementBounds:{x:20,y:20,width:200,height:70},contentBounds:{x:20,y:20,width:190,height:65},boundsKind:"text-line-boxes",
    viewportOverflow:{left:0,top:0,right:0,bottom:0},text:{lineCount:2,lineBoxes:[],lineBoxesTruncated:false,
      layoutWidth:200,layoutHeight:70,overflowX:0,overflowY:30,requestedFontFamily:"Missing",computedFontFamily:"Missing",
      fontSize:24,fontWeight:"600",firstFamilyStatus:"fallback-likely",fontProbeWidths:[100,100,110,110,120,120]} }] });

test("layout rejects corrupt snapshots, invalid frames and oversized work before browser execution", () => {
  const s=saved();
  for(const frames of [[],[0,0],[-1],[90],Array.from({length:13},(_,i)=>i)]) assert.throws(()=>prepareLayoutInspection(s,frames));
  assert.ok(prepareLayoutInspection(s).frames.length<=12);
  s.document.nodes[0].components[0].data.text="changed";
  assert.throws(()=>prepareLayoutInspection(s),/hash/);
  s.contentHash=hashProject(s.document);s.document.sequences[0].width=5000;s.contentHash=hashProject(s.document);
  assert.throws(()=>prepareLayoutInspection(s,[0]),/budget/);
  s.document.sequences[0].width=640;s.document.nodes[0].components[0].data.text="x".repeat(20001);s.contentHash=hashProject(s.document);
  assert.throws(()=>prepareLayoutInspection(s,[0]),/20,000/);
});

test("layout refuses wrong scene, viewport, frame, project, missing nodes and unsettled fonts", () => {
  const s=saved(), selected=prepareLayoutInspection(s,[0]);
  const mutations: Array<(m:LayoutFrameMeasurement)=>void>=[m=>m.sceneId="demo-default",m=>m.viewport.width=1920,
    m=>m.frame=1,m=>m.projectId="other",m=>m.nodes=[],m=>m.nodes[0].nodeId="other-node",m=>m.environment.fontsStatus="loading"];
  for(const change of mutations){const m=measurement();change(m);assert.throws(()=>finishLayoutInspection(s,selected,[m],1),/differ/);}
  assert.throws(()=>finishLayoutInspection(s,selected,[],1),/every requested frame/);
});

test("layout keeps heuristic/font and sampled-frame limits explicit; intentional exits are warnings", () => {
  const s=saved(), selected=prepareLayoutInspection(s,[0,30]), m=measurement(30);
  m.nodes[0].viewportOverflow.right=50;
  const report=finishLayoutInspection(s,selected,[measurement(),m],12);
  assert.equal(report.outcome,"issues-found");
  assert.ok(report.issues.some(i=>i.code==="LAYOUT_TEXT_OVERFLOW"&&i.nodeId==="text"));
  assert.ok(report.issues.some(i=>i.code==="LAYOUT_FONT_FALLBACK_LIKELY"));
  assert.ok(report.issues.some(i=>i.code==="LAYOUT_VIEWPORT_OVERFLOW"&&i.frame===30&&i.level==="warning"));
  assert.ok(report.coverage.notChecked.includes("exact-glyph-font-resolution"));
  assert.ok(report.coverage.notChecked.includes("unsampled-frames"));
  assert.equal(report.cost.encodedImageFrames,0);
  const hidden=measurement();hidden.nodes[0].opacity=0;
  s.document.animationTracks=[{id:"hide",targetNodeId:"text",targetProperty:"opacity",keyframes:[{frame:0,value:0}]}];
  s.contentHash=hashProject(s.document);
  assert.ok(!finishLayoutInspection(s,prepareLayoutInspection(s,[0]),[hidden],1).issues.some(i=>i.code==="LAYOUT_TEXT_OVERFLOW"));
});
