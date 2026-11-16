import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const png=await readFile("out/project-graph-host-preview.png");
if(png.subarray(0,8).toString("hex")!=="89504e470d0a1a0a") throw new Error("Host preview is not PNG");
const file="out/project-graph-host-video.mp4";
const result=spawnSync("ffprobe",["-v","error","-show_streams","-show_format","-of","json",file],{encoding:"utf8"});
if(result.status!==0){process.stderr.write(result.stderr||"ffprobe failed\n");process.exit(result.status??1);}
const data=JSON.parse(result.stdout);const video=data.streams?.find(s=>s.codec_type==="video");const duration=Number(data.format?.duration);
const checks=[["host-rendered MP4 video stream",Boolean(video)],["1920x1080",video?.width===1920&&video?.height===1080],["30 FPS",video?.r_frame_rate==="30/1"||video?.r_frame_rate==="30/1.0"],["3 second snapshot range",duration>=2.9&&duration<=3.1]];
for(const [label,passed] of checks)console.log((passed?"PASS  ":"FAIL  ")+label);
if(checks.some(([,passed])=>!passed))process.exit(1);
