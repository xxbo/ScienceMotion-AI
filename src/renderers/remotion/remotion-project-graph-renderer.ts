import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectGraphPreviewRequest, ProjectGraphSnapshotRenderer, ProjectGraphRenderOutput, ProjectGraphVideoRequest } from "../../contracts/renderer";
export class RemotionProjectGraphRenderer implements ProjectGraphSnapshotRenderer {
 readonly id="remotion.project-graph";readonly version="1.0.0";private serveUrlPromise?:Promise<string>;
 constructor(private readonly entryPoint=resolve("src/index.ts")){}
 private serveUrl():Promise<string>{if(!this.serveUrlPromise)this.serveUrlPromise=bundle({entryPoint:this.entryPoint}).catch(e=>{this.serveUrlPromise=undefined;throw e;});return this.serveUrlPromise;}
 async renderPreview(request:ProjectGraphPreviewRequest):Promise<ProjectGraphRenderOutput>{
  const serveUrl=await this.serveUrl();const inputProps={project:structuredClone(request.project),sceneId:request.sceneId};
  const composition=await selectComposition({serveUrl,id:"ProjectGraph",inputProps});const dir=await mkdtemp(join(tmpdir(),"sciencemotion-preview-"));const output=join(dir,"preview.png");
  try{await renderStill({composition,serveUrl,output,frame:request.frame,inputProps});return{bytes:new Uint8Array(await readFile(output)),mediaType:"image/png",extension:"png",rendererId:this.id,rendererVersion:this.version};}
  finally{await rm(dir,{recursive:true,force:true});}
 }
 async renderVideo(request:ProjectGraphVideoRequest):Promise<ProjectGraphRenderOutput>{
  const serveUrl=await this.serveUrl();const inputProps={project:structuredClone(request.project),sceneId:request.sceneId};
  const composition=await selectComposition({serveUrl,id:"ProjectGraph",inputProps});const dir=await mkdtemp(join(tmpdir(),"sciencemotion-video-"));const output=join(dir,"render.mp4");
  try{await renderMedia({composition,serveUrl,codec:"h264",outputLocation:output,inputProps,frameRange:[request.startFrame,request.startFrame+request.durationFrames-1],pixelFormat:"yuv420p"});
   return{bytes:new Uint8Array(await readFile(output)),mediaType:"video/mp4",extension:"mp4",rendererId:this.id,rendererVersion:this.version};}
  finally{await rm(dir,{recursive:true,force:true});}
 }
}
