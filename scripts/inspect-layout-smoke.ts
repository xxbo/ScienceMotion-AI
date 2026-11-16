import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCreativeHost } from "../src/platform/creative-host";
import { RemotionProjectGraphRenderer } from "../src/renderers/remotion/remotion-project-graph-renderer";
import type { CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { SnapshotLayoutInspectionReport } from "../src/contracts/layout-inspection";
import type { ToolResult } from "../src/contracts/agent-tool";

const root=await mkdtemp(join(tmpdir(),"sciencemotion-layout-"));
let host:Awaited<ReturnType<typeof openCreativeHost>>|undefined;
let calls=0, previews=0, videos=0;
class MeasuredRenderer extends RemotionProjectGraphRenderer {
  override async renderPreview(request:Parameters<RemotionProjectGraphRenderer["renderPreview"]>[0]){previews++;return super.renderPreview(request);}
  override async renderVideo(request:Parameters<RemotionProjectGraphRenderer["renderVideo"]>[0]){videos++;return super.renderVideo(request);}
}
const renderer=new MeasuredRenderer();
async function invoke(session:CreativeSession,toolId:string,input:unknown={}){
  const manifest=await session.manifest(toolId);assert.ok(manifest);
  const r=await session.invoke({toolId,toolVersion:manifest.version,input,runId:"layout-smoke",callId:`layout-${++calls}`});
  assert.equal(r.ok,true,JSON.stringify(r.diagnostics));return r;
}
const frames=[0,30,59,60,90,119];
async function inspect(session:CreativeSession,snapshotId:string){
  const r=await invoke(session,"inspect.layout",{snapshotId,frames});assert.ok(!r.artifacts?.length);
  return r.output as SnapshotLayoutInspectionReport;
}
async function saveArtifact(result:ToolResult,path:string){
  const hash=result.artifacts![0].id.replace(/^sha256:/,"");
  await writeFile(path,await readFile(join(root,"artifacts","blobs",hash.slice(0,2),hash)));
}
function cyanInk(path:string){
  const decoded=spawnSync("ffmpeg",["-v","error","-i",path,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{maxBuffer:2*1024*1024});
  assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length,640*360*3);
  let x0=640,y0=360,x1=-1,y1=-1,count=0;
  for(let y=0;y<240;y++)for(let x=0;x<640;x++){
    const i=(y*640+x)*3;
    if([85,214,232].every((channel,k)=>Math.abs(channel-decoded.stdout[i+k])<8)){
      x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);count++;
    }
  }
  assert.ok(count>100);return {x:x0,y:y0,width:x1-x0+1,height:y1-y0+1};
}
try {
  host=await openCreativeHost({directory:root,renderer});
  const writer=host.createSession({projectId:"layout-example",permissions:["project.read","project.write","artifact.read","artifact.write","snapshot.read","snapshot.write"],
    toolIds:["project.create","project.scene.create","graphics.2d.text.create","graphics.2d.shape.create","animation.keyframes.set",
      "project.inspect","project.patch.apply","project.snapshot.save","inspect.snapshot","inspect.layout","render.preview"]});
  await invoke(writer,"project.create",{name:"Measured text repair",episodeId:"approved-layout",width:640,height:360,durationFrames:120});
  for(const [sceneId,startFrame] of [["layout-a",0],["layout-b",60]] as const)
    await invoke(writer,"project.scene.create",{sceneId,name:sceneId,startFrame,durationFrames:60});
  await invoke(writer,"graphics.2d.text.create",{sceneId:"layout-a",nodeId:"paragraph",text:"缓存把最近用过的数据放在更快的位置。",x:20,y:30,width:170,height:24,fontSize:30,fontFamily:"sans-serif",color:"#55d6e8"});
  await invoke(writer,"graphics.2d.text.create",{sceneId:"layout-a",nodeId:"moving",text:"读取数据",x:20,y:280,width:160,height:40,fontSize:24,fontFamily:"sans-serif"});
  await invoke(writer,"graphics.2d.text.create",{sceneId:"layout-a",nodeId:"font-case",text:"Font fallback 字体",x:300,y:220,width:320,height:60,fontSize:24,fontFamily:"ScienceMotionDefinitelyMissingFont, sans-serif",color:"#ffb454"});
  await invoke(writer,"graphics.2d.text.create",{sceneId:"layout-b",nodeId:"unrelated",text:"第二幕保持不变",x:20,y:80,width:400,height:70,fontSize:30,fontFamily:"sans-serif"});
  const animate=async(x:number)=>invoke(writer,"animation.keyframes.set",{trackId:"moving-position",targetNodeId:"moving",targetProperty:"transform.position",
    keyframes:[{frame:0,value:[20,280,0]},{frame:30,value:[x,280,0]},{frame:59,value:[20,280,0]}]});
  await animate(620);
  const initial=(await invoke(writer,"project.inspect")).output as ProjectDocument;
  await invoke(writer,"project.snapshot.save",{snapshotId:"layout-before",revisionId:initial.revisions.at(-1)!.id});
  const model=(await invoke(writer,"inspect.snapshot",{snapshotId:"layout-before",frames})).output as {outcome:string};
  assert.equal(model.outcome,"no-issues-detected","Model inspection alone cannot detect these text defects");
  const read=host.createSession({projectId:"layout-example",permissions:["snapshot.read"],toolIds:["inspect.layout"]});
  const before=await inspect(read,"layout-before");
  assert.ok(before.issues.some(i=>i.code==="LAYOUT_TEXT_OVERFLOW"&&i.nodeId==="paragraph"));
  assert.ok(before.issues.some(i=>i.code==="LAYOUT_FONT_FALLBACK_LIKELY"&&i.nodeId==="font-case"));
  assert.ok(before.issues.some(i=>i.code==="LAYOUT_VIEWPORT_OVERFLOW"&&i.nodeId==="moving"&&i.frame===30));
  assert.ok(!before.issues.some(i=>i.code==="LAYOUT_VIEWPORT_OVERFLOW"&&i.nodeId==="moving"&&[0,59].includes(i.frame)));
  assert.equal(before.frames[3].sceneId,"layout-b");
  assert.equal(before.frames[3].nodes[0].nodeId,"unrelated","Must use this snapshot's timeline, not the renderer's demo scene");
  assert.equal(previews,0);assert.equal(videos,0);
  await mkdir("out",{recursive:true});
  await saveArtifact(await invoke(writer,"render.preview",{snapshotId:"layout-before",frame:0}),"out/layout-before.png");
  const patches=["paragraph","font-case"].map(nodeId=>{
    const node=structuredClone(initial.nodes.find(n=>n.id===nodeId)!);
    Object.assign(node.components[0].data,nodeId==="paragraph"?{width:400,height:100}:{fontFamily:"sans-serif"});
    return {op:"update-node",nodeId,changes:{components:node.components}};
  });
  await invoke(writer,"project.patch.apply",{schemaVersion:"1.3.0",projectId:initial.project.id,baseRevisionId:initial.revisions.at(-1)!.id,patches});
  await animate(350);
  const updated=(await invoke(writer,"project.inspect")).output as ProjectDocument;
  assert.deepEqual(updated.nodes.find(n=>n.id==="unrelated"),initial.nodes.find(n=>n.id==="unrelated"));
  await invoke(writer,"project.snapshot.save",{snapshotId:"layout-after",revisionId:updated.revisions.at(-1)!.id});
  const after=await inspect(read,"layout-after");assert.equal(after.outcome,"no-issues-detected",JSON.stringify(after.issues));
  await saveArtifact(await invoke(writer,"render.preview",{snapshotId:"layout-after",frame:0}),"out/layout-after.png");
  const inks=[cyanInk("out/layout-before.png"),cyanInk("out/layout-after.png")];
  for(const [i,report] of [before,after].entries()){
    const box=report.frames[0].nodes.find(n=>n.nodeId==="paragraph")!.contentBounds,ink=inks[i];
    assert.ok(ink.x>=box.x-2&&ink.y>=box.y-2&&ink.x+ink.width<=box.x+box.width+2&&ink.y+ink.height<=box.y+box.height+2,
      "Measured text line boxes must contain production PNG ink (within antialias tolerance)");
  }
  assert.ok(inks[1].height<inks[0].height,"Repair must visibly reduce wrapping in the production PNG");
  const beforeAgain=await inspect(read,"layout-before");assert.deepEqual(beforeAgain.frames,before.frames);assert.deepEqual(beforeAgain.issues,before.issues);
  assert.deepEqual((await invoke(writer,"project.inspect")).output,updated,"Inspection must not revise the project");
  await host.close();host=await openCreativeHost({directory:root,renderer:new MeasuredRenderer()});
  const restarted=host.createSession({projectId:"layout-example",permissions:["snapshot.read"],toolIds:["inspect.layout"]});
  const afterRestart=await inspect(restarted,"layout-after");assert.deepEqual(afterRestart.frames,after.frames);assert.deepEqual(afterRestart.issues,after.issues);
  assert.equal(previews,2);assert.equal(videos,0);
  await writeFile("out/layout-inspection-evidence.json",JSON.stringify({sourceCommit:process.env.GITHUB_SHA??null,
    scenario:"Real browser text overflow, mid-animation viewport exit, missing-font heuristic and second-scene identity; tool repair and restart",
    before,after,afterRestart,inspectionEncodedImageFrames:0,visualModelCalls:0,pixelRegressionPreviews:previews,videoEncodes:videos,
    measuredTextInkBounds:inks,unrelatedNodeUnchanged:true,oldSnapshotUnchanged:true},null,2)+"\n");
  console.log(`PASS layout inspection -> text/font/motion repair -> production pixels -> restart; inspection encodes 0 frames; ${before.cost.elapsedMs}ms / ${after.cost.elapsedMs}ms`);
} finally {await host?.close();await rm(root,{recursive:true,force:true});}
