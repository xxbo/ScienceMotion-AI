export interface CreativeLoopTopic {
  id: string;
  name: string;
  brief: string;
  revisedBrief: string;
  initialText: string;
  revisedText: string;
  initialMotion: Array<[number, [number, number, number]]>;
  revisedMotion: Array<[number, [number, number, number]]>;
  calls: Array<{ toolId: string; input: Record<string, unknown> }>;
}

const text = (sceneId: string, nodeId: string, content: string, x: number, y: number, fontSize = 28,
  width = 860, height = 60, color = "#f4f7fb") => ({ toolId: "graphics.2d.text.create",
  input: { sceneId, nodeId, text: content, x, y, fontSize, width, height, color, fontFamily: "sans-serif" } });
const shape = (sceneId: string, nodeId: string, x: number, y: number, width: number, height: number,
  fill = "#193349", primitive = "rect") => ({ toolId: "graphics.2d.shape.create",
  input: { sceneId, nodeId, primitive, x, y, width, height, fill, radius: 12 } });
const path = (sceneId: string, nodeId: string, x: number, y: number, width: number, height: number, pathData: string) =>
  ({ toolId: "graphics.2d.path.create", input: { sceneId, nodeId, x, y, width, height, pathData,
    fill: "transparent", stroke: "#6b8aa3", strokeWidth: 4 } });
const scene = (sceneId: string, startFrame: number) => ({ toolId: "project.scene.create",
  input: { sceneId, name: sceneId, startFrame, durationFrames: 180 } });

/** Two approved, data-driven 12-second briefs. No topic-specific renderer or TSX component. */
export const creativeLoopTopics: CreativeLoopTopic[] = [
  {
    id: "cache-loop", name: "缓存命中与局部性",
    brief: "用两个镜头说明：命中时从缓存返回数据；程序可能重复访问近期数据。图形为示意，不表示真实硬件尺寸或时延。",
    revisedBrief: "保持两个镜头的知识点不变。把说明改为“命中：从缓存返回数据”，右移说明文字，并让数据更早沿同一路径返回。",
    initialText: "缓存里已有目标数据", revisedText: "命中：从缓存返回数据",
    initialMotion: [[0,[720,270,0]],[90,[500,270,0]],[179,[260,270,0]]],
    revisedMotion: [[0,[720,270,0]],[90,[360,270,0]],[179,[260,270,0]]],
    calls: [
      scene("flow",0), text("flow","title","缓存命中：走近路取数据",50,35,38),
      path("flow","route",250,282,500,1,"M 0 0 L 500 0"),
      shape("flow","cpu-box",80,215,170,130), text("flow","cpu-label","CPU",80,255,36,170,65),
      shape("flow","cache-box",750,215,160,130), text("flow","cache-label","缓存",775,255,32,130,60),
      shape("flow","moving",720,270,24,24,"#55d6e8","circle"),
      text("flow","detail","缓存里已有目标数据",50,445,28,840,65),
      scene("reuse",180), text("reuse","reuse-title","时间局部性：刚用过，还可能再用",50,35,34),
      path("reuse","reuse-route",250,240,450,130,"M 0 0 C 120 -60 330 -60 450 0 M 450 100 C 330 160 120 160 0 100"),
      shape("reuse","data-box",80,220,170,150), text("reuse","data-label","数据 A",90,265,32,150,60),
      shape("reuse","processor",700,220,170,150), text("reuse","processor-label","CPU",715,265,34,140,60),
      shape("reuse","returning",250,240,16,16,"#ffb454","circle"),
      { toolId:"animation.keyframes.set", input:{trackId:"returning-position",targetNodeId:"returning",targetProperty:"transform.position",
        keyframes:[{frame:0,value:[250,240,0]},{frame:90,value:[680,240,0]},{frame:179,value:[250,340,0]}]} },
      text("reuse","conclusion","重复访问，让缓存中的数据再次派上用场。",50,445,26),
    ],
  },
  {
    id: "water-loop", name: "蒸发与降水",
    brief: "用两个镜头说明：水受热可以蒸发成水蒸气；水蒸气冷却凝结，云中的水滴或冰晶增长后可能形成降水。粒子和路径只是示意。",
    revisedBrief: "保持水循环知识点不变。把说明改为“蒸发：液态水变为水蒸气”，右移说明，并让上升示意标记更早到达高处。",
    initialText: "水受热后可以蒸发", revisedText: "蒸发：液态水变为水蒸气",
    initialMotion: [[0,[470,365,0]],[90,[470,290,0]],[179,[470,205,0]]],
    revisedMotion: [[0,[470,365,0]],[90,[470,225,0]],[179,[470,205,0]]],
    calls: [
      scene("evaporation",0), text("evaporation","title","水循环：蒸发让水进入空气",50,35,38),
      shape("evaporation","water",80,390,800,28,"#286888"),
      path("evaporation","rising",482,190,1,190,"M 0 190 L 0 0 M -12 16 L 0 0 L 12 16"),
      shape("evaporation","cloud",390,135,180,65,"#859bad","ellipse"),
      text("evaporation","vapor-label","水蒸气上升（示意）",590,235,24,330,55),
      shape("evaporation","moving",470,365,24,24,"#55d6e8","circle"),
      text("evaporation","detail","水受热后可以蒸发",50,445,28,840,65),
      scene("rain",180), text("rain","rain-title","冷却凝结，形成云中的水滴或冰晶",50,35,34),
      shape("rain","rain-cloud",350,155,260,100,"#859bad","ellipse"),
      path("rain","rain-paths",390,260,180,110,"M 0 0 L -15 100 M 70 0 L 55 100 M 140 0 L 125 100"),
      shape("rain","ground",80,390,800,28,"#286888"),
      shape("rain","returning",382,260,16,16,"#ffb454","circle"),
      { toolId:"animation.keyframes.set", input:{trackId:"returning-position",targetNodeId:"returning",targetProperty:"transform.position",
        keyframes:[{frame:0,value:[382,260,0]},{frame:90,value:[375,310,0]},{frame:179,value:[368,360,0]}]} },
      text("rain","conclusion","水滴或冰晶增长后，可能以降水形式回到地面。",50,445,25),
    ],
  },
];
