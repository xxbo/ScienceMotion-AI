import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { openCreativeHost } from "../src/platform/creative-host";
import type { ProjectDocument } from "../src/contracts/project";
import type { ToolResult } from "../src/contracts/agent-tool";

// A content authoring script using unchanged main's discoverable public tools.
// No new component, renderer, or topic-specific TSX is used.
const output = resolve("out/cache-showcase");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "workspace-"));
const host = await openCreativeHost({ directory: root });
const tools = ["project.create", "project.scene.create", "graphics.2d.text.create", "graphics.2d.shape.create",
  "graphics.2d.path.create", "graphics.2d.chart.create", "animation.keyframes.set", "project.inspect",
  "project.snapshot.save", "inspect.snapshot", "render.preview", "render.video"];
const session = host.createSession({ projectId: "cpu-cache-showcase", toolIds: tools,
  permissions: ["project.read", "project.write", "artifact.read", "artifact.write", "snapshot.read", "snapshot.write"] });
const calls: unknown[] = [];
let serial = 0;
async function invoke(toolId: string, input: unknown): Promise<ToolResult> {
  const manifest = await session.manifest(toolId);
  assert.ok(manifest, `Missing public tool ${toolId}`);
  const started = performance.now();
  const result = await session.invoke({ toolId, toolVersion: manifest.version, input,
    runId: "cpu-cache-showcase", callId: `showcase-${++serial}` });
  calls.push({ toolId, toolVersion: manifest.version, input, elapsedMs: Math.round(performance.now() - started),
    ok: result.ok, diagnostics: result.diagnostics });
  assert.ok(result.ok, `${toolId}: ${JSON.stringify(result.diagnostics)}`);
  return result;
}
const C = { ink: "#f3f7fc", muted: "#95a9be", cyan: "#6de4d6", orange: "#ffbf69", purple: "#b5b1ff",
  panel: "#101f32", line: "#30485e", dark: "#07111f" };
const shots = [
  { id: "why", start: 0, frames: 180, title: "CPU 很快，数据却要等", sub: "缓存：让常用的数据更靠近计算", caption: "缓存，把常用数据放得更近。", narration: "CPU 算得快，却常常要等数据。缓存，把常用数据放得更近。" },
  { id: "routes", start: 180, frames: 240, title: "命中走近路，未命中继续找", sub: "同一次读取，可以有两条不同的路径", caption: "命中直接返回；未命中则继续向下查找。", narration: "数据在缓存里，就是命中，沿近路返回。找不到，就要继续向下查找，必要时访问内存。" },
  { id: "locality", start: 420, frames: 240, title: "为什么缓存常常能帮上忙？", sub: "程序通常具有两种局部性", caption: "刚用过的、附近的，往往还会用到。", narration: "缓存有效，靠的是局部性：刚用过的数据可能再用，相邻的数据也常被连续访问。" },
  { id: "average", start: 660, frames: 240, title: "命中越多，平均等待越少", sub: "用一个简化模型，看命中率的作用", caption: "把数据放近一点，让计算少等一点。", narration: "在这个简化模型里，命中率从零升到百分之九十，平均延迟就从十一降到二。" },
];
let scene = shots[0];
const id = (name: string) => `${scene.id}-${name}`;
async function text(name: string, content: string, x: number, y: number, fontSize = 26,
  width = 1100, color = C.ink, weight = 500, align: "left" | "center" | "right" = "left") {
  await invoke("graphics.2d.text.create", { sceneId: scene.id, nodeId: id(name), text: content, x, y,
    fontSize, width, height: Math.ceil(fontSize * 1.3), color, fontWeight: weight,
    fontFamily: "Noto Sans CJK SC, sans-serif", textAlign: align });
  return id(name);
}
async function rect(name: string, x: number, y: number, width: number, height: number,
  fill = C.panel, stroke = "transparent", radius = 16, strokeWidth = 1) {
  await invoke("graphics.2d.shape.create", { sceneId: scene.id, nodeId: id(name), primitive: "rect",
    x, y, width, height, fill, stroke, strokeWidth, radius });
  return id(name);
}
async function dot(name: string, x: number, y: number, color = C.cyan, diameter = 16) {
  await invoke("graphics.2d.shape.create", { sceneId: scene.id, nodeId: id(name), primitive: "circle",
    x, y, width: diameter, height: diameter, fill: color });
  return id(name);
}
async function path(name: string, x: number, y: number, width: number, height: number, pathData: string,
  stroke = C.line, strokeWidth = 3) {
  await invoke("graphics.2d.path.create", { sceneId: scene.id, nodeId: id(name), x, y, width, height,
    pathData, stroke, strokeWidth, fill: "transparent" });
  return id(name);
}
async function keys(node: string, property: string, values: Array<[number, unknown]>, ease = false) {
  await invoke("animation.keyframes.set", { trackId: `${node}-${property.replaceAll(".", "-")}`,
    targetNodeId: node, targetProperty: property,
    keyframes: values.map(([frame, value]) => ({ frame, value, interpolation: ease ? "bezier" : "linear",
      ...(ease ? { easing: "ease-in-out" } : {}) })) });
}
async function reveal(node: string, from = 0, length = 14) {
  await keys(node, "opacity", [[0, 0], ...(from ? [[from, 0] as [number, unknown]] : []), [from + length, 1]]);
}
async function move(node: string, coords: Array<[number, number, number]>, ease = false) {
  await keys(node, "transform.position", coords.map(([f,x,y]) => [f,[x,y,0]]), ease);
}
async function labelBox(name: string, label: string, x: number, y: number, w: number, h: number,
  color = C.cyan, font = 30) {
  await rect(name, x,y,w,h,C.panel,color,14,2);
  await text(`${name}-label`, label,x,y+(h-font*1.25)/2,font,w,color,650,"center");
}
async function frame(index: number) {
  scene = shots[index];
  await invoke("project.scene.create", { sceneId: scene.id, name: scene.title,
    startFrame: scene.start, durationFrames: scene.frames });
  await text("series", "SCIENCEMOTION  /  30 秒看懂",72,38,16,600,C.cyan,600);
  await text("page", `${String(index + 1).padStart(2,"0")} / 04`,1080,38,16,128,C.muted,500,"right");
  const title = await text("title", scene.title,72,91,52,1136,C.ink,750);
  await reveal(title,0,12);
  await move(title,[[0,72,103],[16,72,91]],true);
  await reveal(await text("subtitle",scene.sub,74,167,24,1130,C.muted),6,15);
  await rect("caption-box",60,620,1160,64,"#0e1d2e","transparent",12,0);
  await text("caption",scene.caption,78,635,27,1124,C.ink,500,"center");
  await rect("progress-base",72,704,1136,3,C.line,"transparent",0,0);
  const progress = await rect("progress",72,704,1136,3,C.cyan,"transparent",0,0);
  await keys(progress,"transform.scale",[[0,[Math.max(0.002,scene.start/900),1,1]],
    [scene.frames-1,[(scene.start+scene.frames)/900,1,1]]]);
}

try {
  await invoke("project.create", {name:"CPU 为什么需要缓存？",episodeId:"cache-in-30-seconds",
    durationFrames:900,fps:30,width:1280,height:720});
  await frame(0);
  await path("bus",292,369,668,2,"M 0 0 L 668 0",C.line,4);
  await labelBox("cpu","CPU",96,278,196,180,C.cyan,48);
  for (let pin=0; pin<5;pin++) {
    await rect(`cpu-pin-top-${pin}`,123+pin*30,266,12,12,C.cyan,"transparent",1,0);
    await rect(`cpu-pin-bottom-${pin}`,123+pin*30,458,12,12,C.cyan,"transparent",1,0);
  }
  await labelBox("cache","缓存",468,300,200,136,C.cyan,36);
  await rect("memory",960,254,224,234,C.panel,C.purple,16,2);
  await text("memory-label","内存",960,278,34,224,C.purple,600,"center");
  for(let row=0;row<2;row++)for(let col=0;col<4;col++) {
    await rect(`data-${row}-${col}`,983+col*46,340+row*49,36,36,"#282c4e",C.purple,5,1);
  }
  await text("near","近",345,321,20,65,C.cyan,500,"center");
  await text("far","远",775,321,20,70,C.muted,500,"center");
  await text("cpu-note","负责计算",96,495,22,196,C.muted,500,"center");
  await text("cache-note","容量较小 · 通常更快",422,471,22,292,C.muted,500,"center");
  await text("memory-note","容量更大",960,514,22,224,C.muted,500,"center");
  const packet = await dot("packet",940,361,C.orange);
  await move(packet,[[0,940,361],[24,940,361],[91,674,361],[112,674,361],[154,292,361]],true);
  await reveal(packet,15,9);
  const glow = await rect("cpu-glow",96,278,196,180,"transparent",C.cyan,14,4);
  await keys(glow,"opacity",[[0,0],[140,0],[154,1],[169,0.2],[179,0.7]]);
  console.log("Authored scene 1/4");

  await frame(1);
  for (const [row,y,color,tag,note] of [["hit",222,C.cyan,"HIT / 命中","缓存里有数据"],
    ["miss",408,C.orange,"MISS / 未命中","继续向下查找"]] as const) {
    await rect(`${row}-panel`,72,y,1136,158,C.panel,"transparent",18,0);
    await text(`${row}-tag`,tag,100,y+28,26,245,color,700);
    await text(`${row}-note`,note,100,y+74,21,245,C.muted);
    await path(`${row}-bus`,490,y+78,490,2,"M 0 0 L 490 0",C.line,3);
    await labelBox(`${row}-cpu`,"CPU",360,y+36,130,84,color,29);
    await labelBox(`${row}-cache`,"缓存",640,y+36,145,84,color,29);
    await labelBox(`${row}-ram`,"内存",980,y+36,145,84,row==="hit"?C.line:C.purple,29);
    await text(`${row}-route`,row==="hit"?"短路径返回":"必要时访问主存",794,y+123,18,180,C.muted,500,"center");
  }
  for(let i=0;i<3;i++) {
    const p=await dot(`hit-packet-${i}`,628,292,C.cyan,16);
    const start=27+i*48;
    await move(p,[[0,628,292],[start,628,292],[start+20,490,292]],true);
    await keys(p,"opacity",[[0,0],[start-1,0],[start,1],[start+20,1],[start+26,0]]);
  }
  const miss=await dot("miss-packet",490,478,C.orange,16);
  await move(miss,[[0,490,478],[40,490,478],[66,628,478],[90,628,478],
    [132,966,478],[153,966,478],[217,490,478]],true);
  await keys(miss,"opacity",[[0,0],[39,0],[40,1],[219,1],[235,0]]);
  const missOutline=await rect("miss-flash",640,444,145,84,"transparent",C.orange,14,4);
  await keys(missOutline,"opacity",[[0,0],[65,0],[73,1],[82,0.1],[90,1],[103,0]]);
  console.log("Authored scene 2/4");

  await frame(2);
  await rect("temporal-panel",72,222,552,363,C.panel,"transparent",18,0);
  await rect("spatial-panel",648,222,560,363,C.panel,"transparent",18,0);
  await text("temporal-heading","时间局部性",100,248,32,490,C.cyan,650);
  await text("temporal-sub","刚用过，很可能还会再用",100,299,23,490,C.muted);
  await path("reuse-loop",130,340,420,150,"M 104 48 C 130 4 246 4 274 48 M 274 92 C 246 136 130 136 104 92",C.cyan,2);
  await labelBox("cached-a","A",122,373,112,96,C.cyan,46);
  await labelBox("reuse-cpu","CPU",404,373,150,96,C.cyan,32);
  await text("reuse-note","同一份数据，多次读取",100,524,23,490,C.muted,500,"center");
  for(let cycle=0;cycle<3;cycle++) {
    const p=await dot(`reuse-${cycle}`,228,380,C.cyan,12);
    const start=18+cycle*66;
    await move(p,[[0,228,380],[start,228,380],[start+14,307,347],[start+28,398,380],
      [start+34,398,426],[start+47,307,462],[start+59,228,426]]);
    await keys(p,"opacity",[[0,0],[start-1,0],[start,1],[start+57,1],[start+63,0]]);
  }
  await text("spatial-heading","空间局部性",680,248,32,496,C.purple,650);
  await text("spatial-sub","相邻的数据，也常被连续访问",680,299,23,496,C.muted);
  await rect("cache-line-region",741,355,242,95,"#242c48",C.purple,12,1);
  for(let n=0;n<8;n++) {
    const x=688+n*61;
    await rect(`cell-${n}`,x,369,49,66,n>=1&&n<=4?"#3d3d65":"#192b40","transparent",7,0);
    await text(`cell-label-${n}`,String(n),x,387,24,49,n>=1&&n<=4?C.ink:C.muted,600,"center");
  }
  const cursor=await rect("read-cursor",749,369,49,66,"transparent",C.cyan,7,3);
  await keys(cursor,"transform.position",[[0,[749,369,0]],[98,[749,369,0]],[122,[810,369,0]],
    [151,[871,369,0]],[181,[932,369,0]]],true);
  await reveal(cursor,81,10);
  await path("bracket",750,462,224,18,"M 0 0 L 0 14 L 224 14 L 224 0",C.purple,2);
  await text("spatial-note","例如：顺序遍历数组",680,524,23,496,C.muted,500,"center");
  await text("block-note","相邻数据一起取入缓存",705,483,21,430,C.purple,500,"center");
  console.log("Authored scene 3/4");

  await frame(3);
  await text("axis-title","平均访问延迟 / 相对时间单位",94,225,21,675,C.muted);
  await invoke("graphics.2d.chart.create", {sceneId:scene.id,nodeId:id("latency-chart"),chartType:"bar",
    x:72,y:262,width:684,height:286,fill:C.cyan,labelColor:C.ink,fontSize:20,
    data:[{label:"0%",value:11},{label:"50%",value:6},{label:"90%",value:2},{label:"99%",value:1.1}]});
  await reveal(id("latency-chart"),7,23);
  await move(id("latency-chart"),[[0,72,280],[30,72,262]],true);
  await text("x-axis","缓存命中率",500,557,18,230,C.muted,500,"right");
  await rect("takeaway-card",820,238,388,328,C.panel,C.line,18,1);
  await text("hit-rate","命中率 90%",850,264,26,328,C.cyan,600);
  await text("cost","2",850,309,108,135,C.ink,750);
  await text("cost-units","时间单位",984,389,25,195,C.muted);
  await text("comparison","相比 0% 命中时的 11",850,453,22,328,C.muted);
  await text("takeaway","更近 · 复用 · 少等待",850,512,26,328,C.cyan,650);
  await text("model-note","示意模型：查缓存耗时 1，未命中额外耗时 10。平均延迟 = 1 + (1 − 命中率) × 10；非硬件实测。",72,590,16,1136,C.muted);
  console.log("Authored scene 4/4");

  const project = (await invoke("project.inspect",{})).output as ProjectDocument;
  const snapshot = await invoke("project.snapshot.save",{snapshotId:"cache-showcase-v1",revisionId:project.revisions.at(-1)!.id});
  await writeFile(join(output,"project.props.json"),JSON.stringify({project},null,2)+"\n");
  await writeFile(join(output,"narration.json"),JSON.stringify({voice:"zh-CN-YunxiNeural",rate:"+15%",fps:30,shots},null,2)+"\n");
  const reports:unknown[]=[];
  // Individual requests stay within the inspector's declared work budget for a rich project.
  for(const shot of shots) for(const local of [0,Math.round(shot.frames/4),Math.round(shot.frames/2),shot.frames-1]) {
    const r=await invoke("inspect.snapshot",{snapshotId:"cache-showcase-v1",frames:[shot.start+local]});
    reports.push(r.output);
  }
  await writeFile(join(output,"inspection.json"),JSON.stringify(reports,null,2)+"\n");
  console.log(`Saved ${project.nodes.length} nodes, ${project.animationTracks.length} animation tracks; model inspected 16 frames`);
  const save=async(result:ToolResult,file:string)=>{
    const hash=result.artifacts?.[0]?.id.replace(/^sha256:/,"");
    assert.ok(hash&&/^[a-f0-9]{64}$/.test(hash));
    await writeFile(join(output,file),await readFile(join(root,"artifacts","blobs",hash.slice(0,2),hash)));
  };
  for(const shot of shots) {
    await save(await invoke("render.preview",{snapshotId:"cache-showcase-v1",frame:shot.start+Math.floor(shot.frames*0.62)}),`${shot.id}.png`);
    console.log(`Rendered poster ${shot.id}`);
  }
  // Bounded per-shot exports respect the current public tool's 30-second call timeout.
  for(const shot of shots) {
    await save(await invoke("render.video",{snapshotId:"cache-showcase-v1",startFrame:shot.start,durationFrames:shot.frames}),`${shot.id}.mp4`);
    console.log(`Rendered ${shot.id}.mp4`);
  }
  await writeFile(join(output,"receipt.json"),JSON.stringify({baseCommit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
    snapshot:snapshot.output,nodes:project.nodes.length,animationTracks:project.animationTracks.length,
    toolCalls:calls.length,visualPath:"Unmodified public tools -> snapshot -> ProjectGraph Remotion renderer",
    narrationPath:"External Edge TTS + FFmpeg finishing, not a generic Project Graph audio track"},null,2)+"\n");
} finally {
  await writeFile(join(output,"tool-calls.json"),JSON.stringify(calls,null,2)+"\n");
  await host.close();
}
