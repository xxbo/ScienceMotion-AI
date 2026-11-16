import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCreativeHost } from "../src/platform/creative-host";
import type { CreativeSession } from "../src/contracts/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
const root = await mkdtemp(join(tmpdir(), "sciencemotion-host-render-"));
let host: Awaited<ReturnType<typeof openCreativeHost>> | undefined; let sequence = 0;
const invoke = (session: CreativeSession, toolId: string, input: unknown) => session.invoke({ toolId, toolVersion: "1.0.0", input, runId: "ci-render-smoke", callId: "call-" + (++sequence) });
const artifactPath = (id: string) => { const hash = id.replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact ID"); return join(root, "artifacts", "blobs", hash.slice(0,2), hash); };
try {
  host = await openCreativeHost({ directory: root });
  const session = host.createSession({ projectId: "ci-project", permissions: ["project.read","project.write","snapshot.write","snapshot.read","artifact.write"],
    toolIds: ["project.create","project.scene.create","graphics.2d.text.create","graphics.2d.shape.create","project.inspect","project.snapshot.save","render.preview","render.video"] });
  for (const [id,input] of [
    ["project.create",{name:"Host render smoke",episodeId:"ci-render-smoke",durationFrames:90,fps:30,width:1920,height:1080}],
    ["project.scene.create",{sceneId:"smoke",name:"Render smoke",durationFrames:90}],
    ["graphics.2d.text.create",{sceneId:"smoke",nodeId:"title",text:"Snapshot → Render → Artifact",x:120,y:120,fontSize:58,color:"#ffffff",width:1600}],
    ["graphics.2d.shape.create",{sceneId:"smoke",nodeId:"shape",primitive:"circle",x:800,y:420,width:180,height:180,fill:"#55d6e8"}],
  ] as Array<[string,unknown]>) { const result=await invoke(session,id,input); if(!result.ok) throw new Error(id+": "+JSON.stringify(result)); }
  const inspected=await invoke(session,"project.inspect",{}); if(!inspected.ok) throw new Error(JSON.stringify(inspected));
  const project=inspected.output as ProjectDocument;
  const saved=await invoke(session,"project.snapshot.save",{snapshotId:"ci-render-snapshot",revisionId:project.revisions.at(-1)!.id}); if(!saved.ok) throw new Error(JSON.stringify(saved));
  const preview=await invoke(session,"render.preview",{snapshotId:"ci-render-snapshot",frame:30});
  if(!preview.ok||!preview.artifacts?.[0]) throw new Error("Preview failed: "+JSON.stringify(preview));
  const video=await invoke(session,"render.video",{snapshotId:"ci-render-snapshot",startFrame:0,durationFrames:90});
  if(!video.ok||!video.artifacts?.[0]) throw new Error("Video failed: "+JSON.stringify(video));
  const png=await readFile(artifactPath(preview.artifacts[0].id)); const mp4=await readFile(artifactPath(video.artifacts[0].id));
  if(png.subarray(0,8).toString("hex")!=="89504e470d0a1a0a") throw new Error("Preview Artifact is not PNG");
  if(mp4.length<16||mp4.subarray(4,8).toString("ascii")!=="ftyp") throw new Error("Video Artifact is not MP4");
  await writeFile("out/project-graph-host-preview.png",png); await writeFile("out/project-graph-host-video.mp4",mp4);
  console.log("PASS host preview Artifact "+preview.artifacts[0].id); console.log("PASS host video Artifact "+video.artifacts[0].id);
} finally { await host?.close(); await rm(root,{recursive:true,force:true}); }
