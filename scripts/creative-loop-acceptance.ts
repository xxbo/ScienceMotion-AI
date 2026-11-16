import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolManifest, ToolResult } from "../src/contracts/agent-tool";
import type { CreativeHost, CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { ProjectPatchDocument } from "../src/contracts/project-patch";
import type { SnapshotInspectionReport } from "../src/contracts/inspection";
import type { SnapshotLayoutInspectionReport } from "../src/contracts/layout-inspection";
import { openCreativeHost } from "../src/platform/creative-host";
import { canonicalProjectJson, hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { approvedBriefPlugin } from "./fixtures/approved-brief-plugin";
import { creativeLoopTopics, type CreativeLoopTopic } from "./fixtures/creative-loop-topics";

const width=960,height=540,fps=30,durationFrames=360;
const previewFrames=[0,90,359], mediaFrames=[0,90,179,180,270,359];
const modelFrames=[0,45,90,135,179,180,225,270,315,359];
const root=await mkdtemp(join(tmpdir(),"sciencemotion-creative-loop-"));
const output="out/creative-loop";
let host:CreativeHost|undefined, callId=0;
const tools=["project.create","project.scene.create","graphics.2d.text.create","graphics.2d.shape.create","graphics.2d.path.create",
  "animation.keyframes.set","project.patch.apply","project.inspect","project.snapshot.save","project.snapshot.inspect","project.snapshot.restore",
  "inspect.snapshot","inspect.layout","render.preview","render.video","execution.list","acceptance.brief.attach"];
const traces:unknown[]=[];
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
function session(projectId:string){
  return host!.createSession({projectId,toolIds:tools,allowDestructive:true,
    permissions:["project.read","project.write","artifact.read","artifact.write","snapshot.read","snapshot.write","snapshot.restore","execution.read"]});
}
async function call(s:CreativeSession,toolId:string,input:unknown={},idempotencyKey?:string,expectSuccess=true){
  const started=performance.now();
  const manifest=await s.manifest(toolId);assert.ok(manifest,`${toolId} was not discoverable`);
  const invocation={toolId,toolVersion:manifest.version,input,runId:`loop-${s.projectId}`,callId:`loop-${++callId}`,
    ...(idempotencyKey?{idempotencyKey}:{})};
  const result=await s.invoke(invocation);
  traces.push({projectId:s.projectId,invocation,result,elapsedMs:performance.now()-started});
  assert.equal(result.ok,expectSuccess,JSON.stringify(result.diagnostics));return result;
}
async function project(s:CreativeSession){return (await call(s,"project.inspect")).output as ProjectDocument;}
function contentHash(p:ProjectDocument){return sha(canonicalProjectJson({...p,project:{...p.project,updatedAt:"audit-time-omitted"},revisions:[]}));}
async function save(s:CreativeSession,id:string){
  const p=await project(s);
  const receipt=(await call(s,"project.snapshot.save",{snapshotId:id,revisionId:p.revisions.at(-1)!.id})).output as {contentHash:string};
  const saved=(await call(s,"project.snapshot.inspect",{snapshotId:id})).output as ProjectSnapshot;
  assert.equal(receipt.contentHash,hashProject(p));assert.equal(saved.contentHash,receipt.contentHash);
  assert.deepEqual(saved.document,p);return saved;
}
async function inspect(s:CreativeSession,id:string){
  const started=performance.now();
  const model=(await call(s,"inspect.snapshot",{snapshotId:id,frames:modelFrames})).output as SnapshotInspectionReport;
  const modelCallMs=performance.now()-started,layoutStarted=performance.now();
  const layout=(await call(s,"inspect.layout",{snapshotId:id,frames:mediaFrames})).output as SnapshotLayoutInspectionReport;
  assert.equal(model.snapshotHash,layout.snapshotHash);
  return {model,layout,cost:{modelCallMs,layoutCallMs:performance.now()-layoutStarted,
    encodedImageFrames:0,visualModelCalls:0,scope:"Public call wall time, including gateway validation and persistence"}};
}
function clean(report:Awaited<ReturnType<typeof inspect>>){
  assert.equal(report.model.outcome,"no-issues-detected",JSON.stringify(report.model.issues));
  assert.equal(report.layout.outcome,"no-issues-detected",JSON.stringify(report.layout.issues));
}
async function artifactBytes(result:ToolResult){
  const ref=result.artifacts?.[0];assert.ok(ref);
  assert.match(ref.id,/^sha256:[a-f0-9]{64}$/);
  const hash=ref.id.slice(7),bytes=await readFile(join(root,"artifacts","blobs",hash.slice(0,2),hash));
  assert.equal(sha(bytes),hash);assert.equal(ref.contentHash,hash);return bytes;
}
function decode(path:string,frames:number[]){
  const filter="select="+frames.map(f=>`eq(n\\,${f})`).join("+");
  const result=spawnSync("ffmpeg",["-v","error","-i",path,"-vf",filter,"-fps_mode","passthrough","-frames:v",String(frames.length),"-f","rawvideo","-pix_fmt","rgb24","pipe:1"],
    {maxBuffer:width*height*3*frames.length+1024*1024});
  assert.equal(result.status,0,result.stderr.toString());assert.equal(result.stdout.length,width*height*3*frames.length);
  return frames.map((_,i)=>result.stdout.subarray(i*width*height*3,(i+1)*width*height*3));
}
function regionDifference(a:Buffer,b:Buffer,x:number,y:number,w:number,h:number){
  let changed=0;
  for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++){
    const i=(py*width+px)*3;if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])changed++;
  }
  return changed;
}
function cyanCenter(pixels:Buffer){
  let x=0,y=0,count=0;
  for(let py=0;py<height;py++)for(let px=0;px<width;px++){
    const i=(py*width+px)*3;
    if([85,214,232].every((c,k)=>Math.abs(c-pixels[i+k])<8)){x+=px;y+=py;count++;}
  }
  assert.ok(count>100,"The moving cyan marker must be visibly rendered");return [x/count,y/count];
}
function compareFrames(before:Buffer[],after:Buffer[],maxAllowed:number,meanAllowed:number){
  assert.equal(before.length,after.length);
  return before.map((a,index)=>{
    const b=after[index];assert.equal(a.length,b.length);let max=0,total=0;
    for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);total+=d;}
    const mean=total/a.length;assert.ok(max<=maxAllowed&&mean<=meanAllowed,`Restored pixels differ: max ${max}, mean ${mean}`);
    return {maxChannelDifference:max,meanChannelDifference:mean};
  });
}
async function render(s:CreativeSession,saved:ProjectSnapshot,prefix:string){
  const previews:unknown[]=[];const decoded:Buffer[]=[];
  for(const frame of previewFrames){
    const result=await call(s,"render.preview",{snapshotId:saved.id,frame});
    const file=join(output,`${prefix}-${frame}.png`);await writeFile(file,await artifactBytes(result));
    const meta=(result.output as {metadata:Record<string,unknown>}).metadata;
    assert.equal(meta.snapshotHash,saved.contentHash);assert.equal(meta.revisionId,saved.document.revisions.at(-1)!.id);
    assert.equal(meta.frame,frame);previews.push(result.output);decoded.push(decode(file,[0])[0]);
  }
  const result=await call(s,"render.video",{snapshotId:saved.id,startFrame:0,durationFrames});
  const file=join(output,`${prefix}.mp4`);await writeFile(file,await artifactBytes(result));
  const meta=(result.output as {metadata:Record<string,unknown>}).metadata;
  assert.equal(meta.snapshotHash,saved.contentHash);assert.equal(meta.revisionId,saved.document.revisions.at(-1)!.id);
  assert.equal(meta.durationFrames,durationFrames);
  const probe=spawnSync("ffprobe",["-v","error","-count_frames","-show_streams","-show_format","-of","json",file],{encoding:"utf8"});
  assert.equal(probe.status,0,probe.stderr);const metadata=JSON.parse(probe.stdout);
  const video=metadata.streams.find((v:{codec_type:string})=>v.codec_type==="video");
  assert.ok(video&&video.codec_name==="h264"&&video.width===width&&video.height===height&&video.r_frame_rate==="30/1"&&Number(video.nb_read_frames)===durationFrames);
  assert.ok(Math.abs(Number(metadata.format.duration)-durationFrames/fps)<0.05);
  assert.equal(metadata.streams.filter((v:{codec_type:string})=>v.codec_type==="audio").length,0,"These technical fixtures are explicitly silent");
  const decodedVideo=spawnSync("ffmpeg",["-hide_banner","-xerror","-i",file,"-vf","blackdetect=d=0.1:pic_th=0.98:pix_th=0.03","-f","null","-"],{encoding:"utf8"});
  assert.equal(decodedVideo.status,0,decodedVideo.stderr);assert.ok(!decodedVideo.stderr.includes("black_start:"));
  await writeFile(join(output,`${prefix}.props.json`),JSON.stringify({project:saved.document},null,2)+"\n");
  return {evidence:{previews,video:result.output,media:{frames:durationFrames,width,height,fps,seconds:durationFrames/fps,audio:"intentionally-absent",fullDecode:true}},
    decoded,videoFrames:decode(file,mediaFrames)};
}
async function checkAsset(p:ProjectDocument,brief:string){
  const asset=p.assets.find(a=>a.id==="approved-brief");assert.ok(asset?.contentHash);
  const hash=asset.contentHash,bytes=await readFile(join(root,"artifacts","blobs",hash.slice(0,2),hash));
  assert.equal(sha(bytes),hash);assert.deepEqual(JSON.parse(bytes.toString()),{episodeId:p.editorial.episodeId,brief});return hash;
}
function track(topic:CreativeLoopTopic,revised=false){return {id:"moving-position",targetNodeId:"moving",targetProperty:"transform.position",
  keyframes:(revised?topic.revisedMotion:topic.initialMotion).map(([frame,value])=>({frame,value}))};}
const states:Array<{topic:CreativeLoopTopic;baseline:ProjectSnapshot;edited:ProjectSnapshot;bad:ProjectSnapshot;
  initial:Awaited<ReturnType<typeof render>>;editPatch:ProjectPatchDocument;baselineInspection:Awaited<ReturnType<typeof inspect>>;evidence:Record<string,unknown>}>=[];
try {
  await mkdir(output,{recursive:true});host=await openCreativeHost({directory:root,plugins:[approvedBriefPlugin]});
  const catalogueOnly=(await readdir("tools/manifests")).filter(p=>p.endsWith(".json")).length;
  const inventory={builtInExecutableTools:host.status().tools-1,acceptanceExtensionTools:1,catalogueOnlyManifests:catalogueOnly,syntheticScaleEntries:0};
  assert.equal(inventory.builtInExecutableTools,19);
  for(const topic of creativeLoopTopics){
    const s=session(topic.id),catalogue=await s.discover({limit:100});
    assert.ok(tools.every(id=>catalogue.tools.some(t=>t.id===id)));
    await writeFile(join(output,`${topic.id}-manifests.json`),JSON.stringify(catalogue.tools,null,2)+"\n");
    await call(s,"project.create",{name:topic.name,episodeId:topic.id,width,height,fps,durationFrames});
    await call(s,"acceptance.brief.attach",{text:topic.brief});
    for(const operation of topic.calls)await call(s,operation.toolId,operation.input);
    const motion=track(topic);
    await call(s,"animation.keyframes.set",{trackId:motion.id,targetNodeId:motion.targetNodeId,targetProperty:motion.targetProperty,keyframes:motion.keyframes});
    const baseline=await save(s,`${topic.id}-baseline`),baselineInspection=await inspect(s,baseline.id);clean(baselineInspection);
    assert.equal(baseline.document.nodes.find(n=>n.id==="detail")!.components[0].data.text,topic.initialText);
    const initial=await render(s,baseline,`${topic.id}-baseline`);
    const baselineAsset=await checkAsset(baseline.document,topic.brief);

    const badNode=structuredClone(baseline.document.nodes.find(n=>n.id==="detail")!);
    Object.assign(badNode.components[0].data,{width:140,height:12});
    const badMotion=track(topic);badMotion.keyframes[1].value=[1100,600,0];
    await call(s,"project.patch.apply",{schemaVersion:"1.3.0",projectId:topic.id,baseRevisionId:baseline.document.revisions.at(-1)!.id,
      patches:[{op:"update-node",nodeId:"detail",changes:{components:badNode.components}},{op:"put-animation-track",track:badMotion}]});
    const bad=await save(s,`${topic.id}-seeded-defects`),defects=await inspect(s,bad.id);
    assert.ok(defects.model.issues.some(i=>i.code==="INSPECT_NODE_OUTSIDE_FRAME"&&i.nodeId==="moving"&&i.frames.includes(90)));
    assert.ok(defects.layout.issues.some(i=>i.code==="LAYOUT_TEXT_OVERFLOW"&&i.nodeId==="detail"));

    const changed=structuredClone(baseline.document.nodes.find(n=>n.id==="detail")!);
    changed.components[0].data.text=topic.revisedText;changed.transform.position=[70,440,0];
    const editPatch:ProjectPatchDocument={schemaVersion:"1.3.0",projectId:topic.id,baseRevisionId:bad.document.revisions.at(-1)!.id,
      patches:[{op:"update-node",nodeId:"detail",changes:{components:changed.components,transform:changed.transform}},
        {op:"put-animation-track",track:track(topic,true)}]};
    const failed=await call(s,"project.patch.apply",{...editPatch,baseRevisionId:baseline.document.revisions.at(-1)!.id},undefined,false);
    assert.match(failed.diagnostics.map(d=>d.message).join(" "),/revision conflict/i);
    assert.deepEqual(await project(s),bad.document,"Rejected stale edits must not mutate the project");
    const repaired=await call(s,"project.patch.apply",editPatch,`${topic.id}-approved-edit`);
    const once=await project(s),replay=await call(s,"project.patch.apply",editPatch,`${topic.id}-approved-edit`);
    assert.deepEqual(replay.output,repaired.output);assert.deepEqual(await project(s),once,"Idempotent replay must not append a revision");
    await call(s,"acceptance.brief.attach",{text:topic.revisedBrief});
    const edited=await save(s,`${topic.id}-edited`),editedInspection=await inspect(s,edited.id);clean(editedInspection);
    assert.deepEqual(edited.document.nodes.filter(n=>n.id!=="detail"),baseline.document.nodes.filter(n=>n.id!=="detail"));
    assert.deepEqual(edited.document.animationTracks.filter(t=>t.id!=="moving-position"),baseline.document.animationTracks.filter(t=>t.id!=="moving-position"));
    assert.deepEqual(edited.document.scenes,baseline.document.scenes);assert.deepEqual(edited.document.shots,baseline.document.shots);
    assert.equal(edited.document.nodes.find(n=>n.id==="detail")!.components[0].data.text,topic.revisedText);
    const revised=await render(s,edited,`${topic.id}-edited`),editedAsset=await checkAsset(edited.document,topic.revisedBrief);
    assert.notEqual(editedAsset,baselineAsset);await checkAsset(baseline.document,topic.brief);
    const oldCenter=cyanCenter(initial.decoded[1]),newCenter=cyanCenter(revised.decoded[1]);
    for(const [center,expected] of [[oldCenter,topic.initialMotion[1][1]],[newCenter,topic.revisedMotion[1][1]]] as const)
      assert.ok(Math.abs(center[0]-(expected[0]+11.5))<1&&Math.abs(center[1]-(expected[1]+11.5))<1,"The production marker must reach the requested frame-90 position");
    assert.ok(Math.hypot(oldCenter[0]-newCenter[0],oldCenter[1]-newCenter[1])>30);
    const textPixelsChanged=regionDifference(initial.decoded[1],revised.decoded[1],0,430,width,110);assert.ok(textPixelsChanged>100);
    assert.equal(regionDifference(initial.decoded[1],revised.decoded[1],0,0,width,180),0,"Unrelated heading pixels must remain unchanged");
    const old=(await call(s,"project.snapshot.inspect",{snapshotId:baseline.id})).output as ProjectSnapshot;assert.deepEqual(old,baseline);
    const history=(await call(s,"execution.list")).output as Array<{toolId:string;status:string}>;
    assert.ok(history.some(e=>e.toolId==="project.create"&&e.status==="succeeded"));
    states.push({topic,baseline,edited,bad,initial,editPatch,baselineInspection,evidence:{topic:topic.id,brief:topic.brief,revisedBrief:topic.revisedBrief,
      baselineSnapshot:{id:baseline.id,hash:baseline.contentHash},editedSnapshot:{id:edited.id,hash:edited.contentHash},
      initialInspection:baselineInspection,seededInspection:defects,editedInspection,
      seededDefects:{count:2,detected:2,missed:0,domains:["marker viewport exit","text allocation overflow"],scope:"These two seeded defects only; not general defect recall"},
      baseline:initial.evidence,edited:revised.evidence,failedMutation:failed.diagnostics,idempotentReplayBeforeRestart:true,
      assetHashes:{baseline:baselineAsset,edited:editedAsset},targetedPixels:{oldCenter,newCenter,textPixelsChanged,unrelatedHeadingPixelsChanged:0},
      unrelatedNodesAndTracksUnchanged:true,manifests:catalogue.tools.map((m:AgentToolManifest)=>({id:m.id,version:m.version,pluginId:m.pluginId})),historyBeforeRestart:history.length}});
    console.log(`PASS ${topic.id}: public creation, both inspectors, seeded repair, isolated text/motion pixels, 12s MP4 and idempotent retry`);
  }

  await host.close();host=await openCreativeHost({directory:root,plugins:[approvedBriefPlugin]});
  for(const state of states){
    const {topic,baseline,edited}=state,s=session(topic.id);
    assert.deepEqual(await project(s),edited.document);
    const history=(await call(s,"execution.list")).output as Array<{toolId:string;status:string}>;
    assert.ok(history.length>=Number(state.evidence.historyBeforeRestart));
    assert.ok(history.some(e=>e.toolId==="project.create"&&e.status==="succeeded"));
    await call(s,"project.patch.apply",state.editPatch,`${topic.id}-approved-edit`);
    assert.deepEqual(await project(s),edited.document,"Replay after reopening must not mutate the project");
    const old=(await call(s,"project.snapshot.inspect",{snapshotId:baseline.id})).output as ProjectSnapshot;assert.deepEqual(old,baseline);
    const restored=(await call(s,"project.snapshot.restore",{snapshotId:baseline.id,baseRevisionId:edited.document.revisions.at(-1)!.id,message:"Restore original approved creative content"})).output as ProjectDocument;
    assert.equal(contentHash(restored),contentHash(baseline.document));assert.notEqual(hashProject(restored),baseline.contentHash);
    assert.equal(restored.revisions.length,edited.document.revisions.length+1);
    assert.equal(restored.revisions.at(-1)!.parentRevisionId,edited.document.revisions.at(-1)!.id);
    assert.equal(restored.revisions.at(-1)!.snapshotHash,baseline.contentHash);
    const restoredAsset=await checkAsset(restored,topic.brief);
    const saved=await save(s,`${topic.id}-restored`),inspection=await inspect(s,saved.id);clean(inspection);
    assert.deepEqual(inspection.model.frames,state.baselineInspection.model.frames);
    assert.deepEqual(inspection.layout.frames,state.baselineInspection.layout.frames);
    const rendered=await render(s,saved,`${topic.id}-restored`);
    const pngComparison=compareFrames(state.initial.decoded,rendered.decoded,0,0);
    const videoComparison=compareFrames(state.initial.videoFrames,rendered.videoFrames,8,0.5);
    Object.assign(state.evidence,{restoredSnapshot:{id:saved.id,hash:saved.contentHash},restored:rendered.evidence,restoredInspection:inspection,
      restore:{canonicalCreativeContentEqual:true,auditRevisionAppended:true,originalAssetHash:restoredAsset,originalAssetBytesVerified:true,
        pngFrames:previewFrames,pngTolerance:{max:0,mean:0},pngComparison,videoFrames:mediaFrames,videoTolerance:{max:8,mean:0.5},videoComparison},
      executionHistorySurvivedRestart:true,idempotentReplayAfterRestart:true});
    await writeFile(join(output,`${topic.id}-executions.json`),JSON.stringify((await call(s,"execution.list")).output,null,2)+"\n");
    console.log(`PASS ${topic.id}: host restart, original dependency restore, appended audit revision, PNG/video frame comparisons`);
  }
  await writeFile(join(output,"evidence.json"),JSON.stringify({sourceCommit:process.env.GITHUB_SHA??null,
    scenario:"Two-topic public creative loop on one unchanged host/renderer",inventory,fixtures:states.map(s=>s.evidence),
    limitations:{narration:"These technical fixtures are silent",humanReview:"pending by user request",realAITrial:false,
      pluginVersionSwitch:"Not integrated into this host workflow yet",syntheticCatalogueScale:"Not exercised here",restoration:"Decoded-frame tolerances within this CI environment, not cross-platform MP4 byte identity"}},null,2)+"\n");
} finally {
  await mkdir(output,{recursive:true});await writeFile(join(output,"tool-calls.json"),JSON.stringify(traces,null,2)+"\n");
  await host?.close();await rm(root,{recursive:true,force:true});
}
