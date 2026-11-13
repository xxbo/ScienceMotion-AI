import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  Audio,
  staticFile,
} from "remotion";
import episode from "../../episodes/cpu-cache/episode.json";
import type { EpisodePackage } from "../contracts/episode";

const C = {
  bg: "#07111f",
  panel: "#102238",
  panel2: "#142c45",
  text: "#f4f7fb",
  muted: "#a9bbcf",
  faint: "#68819c",
  cyan: "#55d6e8",
  blue: "#7296ff",
  orange: "#ffb45e",
  green: "#78dfad",
  red: "#ff7c85",
};

const FONT = '"Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif';

const fade = (frame: number, start = 0, end = 22) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const Slide: React.FC<{
  frame: number;
  section: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}> = ({ frame, section, title, subtitle, children }) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.bg,
      color: C.text,
      fontFamily: FONT,
      opacity: fade(frame),
      overflow: "hidden",
    }}
  >
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 75% 48%, rgba(34,91,128,.22), transparent 52%), radial-gradient(ellipse at 12% 92%, rgba(43,67,115,.18), transparent 42%)",
      }}
    />
    <div style={{ position: "absolute", top: 68, left: 112, color: C.cyan, fontSize: 22, fontWeight: 800, letterSpacing: 5 }}>
      SCIENCEMOTION  /  {section}
    </div>
    <div style={{ position: "absolute", top: 122, left: 112, right: 112 }}>
      <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: -1 }}>{title}</div>
      <div style={{ color: C.muted, fontSize: 27, marginTop: 15 }}>{subtitle}</div>
    </div>
    {children}
    <div
      style={{
        position: "absolute",
        left: 112,
        right: 112,
        bottom: 118,
        height: 3,
        background: "#263b51",
        borderRadius: 4,
      }}
    >
      <div style={{ width: `${((frame + 1) / 1800) * 100}%`, height: "100%", background: C.cyan }} />
    </div>
    <div style={{ position: "absolute", left: 112, bottom: 62, color: C.faint, fontSize: 18, letterSpacing: 2 }}>
      SCIENCEMOTION AI · CPU CACHE EXPLAINER
    </div>
  </AbsoluteFill>
);

const Node: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  detail: string;
  color: string;
  active?: boolean;
}> = ({ x, y, w, h, title, detail, color, active = false }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      boxSizing: "border-box",
      border: `2px solid ${color}`,
      borderRadius: 22,
      background: active ? `${color}20` : C.panel,
      boxShadow: active ? `0 0 48px ${color}35` : "none",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 12,
    }}
  >
    <div style={{ color, fontSize: 32, fontWeight: 800 }}>{title}</div>
    <div style={{ color: C.muted, fontSize: 21 }}>{detail}</div>
  </div>
);

const Packet: React.FC<{ x: number; y: number; color?: string; size?: number }> = ({
  x,
  y,
  color = C.cyan,
  size = 18,
}) => (
  <div
    style={{
      position: "absolute",
      left: x - size / 2,
      top: y - size / 2,
      width: size,
      height: size,
      borderRadius: "50%",
      background: color,
      boxShadow: `0 0 26px ${color}`,
    }}
  />
);

const Intro: React.FC<{ frame: number }> = ({ frame }) => {
  const pulse = 1 + Math.sin(frame / 12) * 0.045;
  return (
    <Slide frame={frame} section="01 / THE PROBLEM" title="CPU 很快，内存为什么跟不上？" subtitle="处理器需要数据，等待数据却可能浪费大量计算时间。">
      <div style={{ position: "absolute", left: 170, top: 420, width: 500, height: 280, borderRadius: 28, background: C.panel, border: `2px solid ${C.cyan}`, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", transform: `scale(${pulse})`, boxShadow: `0 0 65px ${C.cyan}20` }}>
        <div style={{ color: C.cyan, fontSize: 34, fontWeight: 800 }}>CPU</div>
        <div style={{ color: C.text, fontSize: 26, marginTop: 18 }}>持续请求下一份数据</div>
        <div style={{ color: C.muted, fontSize: 20, marginTop: 12 }}>计算单元可能因此停下来等待</div>
      </div>
      <div style={{ position: "absolute", left: 930, top: 480, width: 760, height: 150, borderRadius: 24, border: `2px solid ${C.blue}`, background: C.panel, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <div style={{ color: C.blue, fontSize: 34, fontWeight: 800 }}>主存（DRAM）</div>
        <div style={{ color: C.muted, fontSize: 22, marginTop: 14 }}>容量大，但距离处理器更远</div>
      </div>
      <div style={{ position: "absolute", left: 700, top: 548, width: 210, height: 4, background: C.faint }} />
      <Packet x={700 + ((frame * 8) % 210)} y={550} color={C.orange} size={20} />
      <div style={{ position: "absolute", left: 750, top: 590, color: C.orange, fontSize: 20 }}>数据传输与等待</div>
    </Slide>
  );
};

const WaitScene: React.FC<{ frame: number }> = ({ frame }) => {
  const bar = (i: number) => 20 + ((frame * 3 + i * 23) % 90);
  return (
    <Slide frame={frame} section="02 / THE BOTTLENECK" title="等待，会让计算单元空转" subtitle="当数据供应跟不上执行速度，处理器就无法持续工作。">
      <div style={{ position: "absolute", left: 150, top: 420, width: 720, height: 310, padding: 34, boxSizing: "border-box", borderRadius: 24, background: C.panel }}>
        <div style={{ fontSize: 25, fontWeight: 700, marginBottom: 28 }}>处理器执行节奏（示意）</div>
        <div style={{ display: "flex", gap: 9, alignItems: "end", height: 175 }}>
          {Array.from({ length: 18 }, (_, i) => (
            <div key={i} style={{ flex: 1, height: `${bar(i)}%`, borderRadius: 7, background: i % 5 === 4 ? C.red : C.cyan, opacity: i % 5 === 4 ? 0.45 : 0.9 }} />
          ))}
        </div>
        <div style={{ color: C.muted, fontSize: 19, marginTop: 20 }}>绿色/青色：执行　红色：等待数据的空档</div>
      </div>
      <div style={{ position: "absolute", left: 970, top: 450, width: 760, color: C.text }}>
        <div style={{ fontSize: 30, color: C.orange, fontWeight: 800 }}>问题的核心</div>
        <div style={{ fontSize: 39, lineHeight: 1.5, fontWeight: 700, marginTop: 22 }}>算得再快，<br/>也要等数据送到。</div>
        <div style={{ fontSize: 24, color: C.muted, lineHeight: 1.7, marginTop: 20 }}>缓存的目标，就是让处理器更可能在需要时，直接拿到近期用过或相邻的数据。</div>
      </div>
    </Slide>
  );
};

const Hierarchy: React.FC<{ frame: number }> = ({ frame }) => {
  const rows = [
    { name: "L1 Cache", desc: "最靠近核心 · 通常最小、最快", color: C.cyan, width: 350 },
    { name: "L2 Cache", desc: "更大一些 · 延迟通常更高", color: C.green, width: 520 },
    { name: "L3 Cache", desc: "容量更大 · 常由多个核心共享", color: C.orange, width: 700 },
    { name: "主存 DRAM", desc: "容量最大 · 访问路径更远", color: C.blue, width: 900 },
  ];
  return (
    <Slide frame={frame} section="03 / MEMORY HIERARCHY" title="于是，CPU 有了一座缓存金字塔" subtitle="越靠近核心，通常越快、容量越小；越往下，容量越大。">
      <div style={{ position: "absolute", left: 510, top: 390, width: 900, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        {rows.map((row, i) => {
          const shown = fade(frame, 8 + i * 13, 28 + i * 13);
          return (
            <div key={row.name} style={{ width: row.width, height: 82, borderRadius: 16, border: `2px solid ${row.color}`, background: `${row.color}16`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 26px", boxSizing: "border-box", opacity: shown, transform: `translateY(${(1 - shown) * 20}px)` }}>
              <div style={{ color: row.color, fontSize: 27, fontWeight: 800 }}>{row.name}</div>
              <div style={{ color: C.muted, fontSize: 18 }}>{row.desc}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", right: 130, top: 470, color: C.faint, fontSize: 18, width: 250, lineHeight: 1.7 }}>层级关系为概念示意。实际容量、延迟和共享方式因处理器设计而异。</div>
    </Slide>
  );
};

const HitScene: React.FC<{ frame: number }> = ({ frame }) => {
  const t = interpolate(frame, [18, 112], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const x = 360 + t * 550;
  return (
    <Slide frame={frame} section="04 / CACHE HIT" title="如果数据就在缓存里：命中" subtitle="CPU 发起访问，缓存找到所需数据，就能沿较短路径返回。">
      <Node x={150} y={480} w={360} h={180} title="CPU Core" detail="发起数据请求" color={C.cyan} active />
      <Node x={780} y={480} w={390} h={180} title="L1 / L2 / L3" detail="找到目标数据" color={C.green} active />
      <Node x={1450} y={480} w={330} h={180} title="结果返回" detail="继续执行指令" color={C.blue} />
      <div style={{ position: "absolute", left: 510, top: 566, width: 270, height: 4, background: C.green }} />
      <div style={{ position: "absolute", left: 1170, top: 566, width: 280, height: 4, background: C.green }} />
      <Packet x={x} y={568} color={C.green} size={24} />
      <div style={{ position: "absolute", left: 850, top: 700, color: C.green, fontSize: 29, fontWeight: 800 }}>CACHE HIT · 缓存命中</div>
    </Slide>
  );
};

const MissScene: React.FC<{ frame: number }> = ({ frame }) => {
  const t = interpolate(frame, [10, 125], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const stages = [
    { x: 190, title: "CPU", sub: "请求数据", color: C.cyan },
    { x: 600, title: "L1 / L2", sub: "未找到", color: C.orange },
    { x: 1010, title: "L3", sub: "仍未找到", color: C.orange },
    { x: 1420, title: "DRAM", sub: "取回数据", color: C.blue },
  ];
  const packetX = 300 + t * 1250;
  return (
    <Slide frame={frame} section="05 / CACHE MISS" title="如果缓存里没有：未命中" subtitle="处理器需要继续向更低层级查找，必要时访问主存，再把数据带回来。">
      {stages.map((s, i) => (
        <React.Fragment key={s.title}>
          <Node x={s.x} y={475} w={300} h={175} title={s.title} detail={s.sub} color={s.color} active={i === 3 && t > 0.78} />
          {i < 3 && <div style={{ position: "absolute", left: s.x + 300, top: 560, width: 110, height: 4, background: C.faint }} />}
        </React.Fragment>
      ))}
      <Packet x={packetX} y={562} color={C.orange} size={22} />
      <div style={{ position: "absolute", left: 450, top: 700, color: C.orange, fontSize: 27, fontWeight: 800 }}>CACHE MISS · 缓存未命中</div>
      <div style={{ position: "absolute", left: 1000, top: 760, color: C.muted, fontSize: 20 }}>数据返回后，可能被放入缓存，供后续访问使用。</div>
    </Slide>
  );
};

const LocalityScene: React.FC<{ frame: number }> = ({ frame }) => {
  const active = Math.floor(frame / 16) % 8;
  return (
    <Slide frame={frame} section="06 / LOCALITY" title="缓存为什么有效？因为程序有局部性" subtitle="程序经常会重复访问近期用过的数据，也常访问相邻位置的数据。">
      <div style={{ position: "absolute", left: 170, top: 420, width: 720, height: 280, borderRadius: 24, background: C.panel, padding: 30, boxSizing: "border-box" }}>
        <div style={{ fontSize: 25, fontWeight: 700 }}>数组内存：连续排列的数据</div>
        <div style={{ display: "flex", gap: 10, marginTop: 65 }}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} style={{ flex: 1, height: 92, borderRadius: 12, border: `2px solid ${i === active ? C.green : C.faint}`, background: i === active ? `${C.green}30` : "#0b1a2b", display: "flex", alignItems: "center", justifyContent: "center", color: i === active ? C.green : C.muted, fontSize: 25, fontWeight: 700 }}>
              {i}
            </div>
          ))}
        </div>
        <div style={{ color: C.muted, fontSize: 20, marginTop: 28 }}>顺序遍历时，相邻元素很可能一起被取入缓存。</div>
      </div>
      <div style={{ position: "absolute", left: 1030, top: 445, width: 660 }}>
        <div style={{ color: C.green, fontSize: 29, fontWeight: 800 }}>空间局部性</div>
        <div style={{ color: C.text, fontSize: 25, marginTop: 12 }}>访问一个地址后，附近地址也可能很快被访问。</div>
        <div style={{ color: C.cyan, fontSize: 29, fontWeight: 800, marginTop: 42 }}>时间局部性</div>
        <div style={{ color: C.text, fontSize: 25, marginTop: 12 }}>刚刚访问过的数据，之后可能再次被访问。</div>
      </div>
    </Slide>
  );
};

const Outro: React.FC<{ frame: number }> = ({ frame }) => (
  <Slide frame={frame} section="07 / TAKEAWAY" title="缓存，让数据离计算更近" subtitle="用更小、更快的存储层，减少处理器等待数据的时间。">
    <div style={{ position: "absolute", left: 260, top: 430, width: 1400, display: "flex", justifyContent: "center", gap: 30 }}>
      {[
        ["更近", "降低访问延迟", C.cyan],
        ["分层", "平衡速度与容量", C.orange],
        ["局部性", "利用程序访问规律", C.green],
      ].map(([title, desc, color]) => (
        <div key={title} style={{ width: 400, height: 210, border: `2px solid ${color}`, borderRadius: 24, background: C.panel, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ color, fontSize: 43, fontWeight: 800 }}>{title}</div>
          <div style={{ color: C.muted, fontSize: 23, marginTop: 18 }}>{desc}</div>
        </div>
      ))}
    </div>
    <div style={{ position: "absolute", left: 0, right: 0, top: 720, textAlign: "center", color: C.text, fontSize: 25 }}>这就是 CPU 缓存存在的意义。</div>
  </Slide>
);

const episodeData = episode as unknown as EpisodePackage;

const sceneRegistry: Record<string, React.FC<{ frame: number }>> = {
  "cpu-memory-gap": Intro,
  "execution-stall": WaitScene,
  "cache-hierarchy": Hierarchy,
  "cache-hit": HitScene,
  "cache-miss": MissScene,
  "memory-locality": LocalityScene,
  takeaway: Outro,
};

let frameCursor = 0;
const shots = episodeData.shots.map((shot) => {
  const Component = sceneRegistry[shot.sceneType];
  if (!Component) {
    throw new Error(`Unsupported scene type in Remotion adapter: ${shot.sceneType}`);
  }
  const startFrame = frameCursor;
  frameCursor += shot.durationFrames;
  return { ...shot, Component, startFrame };
});

const subtitles = episodeData.captions;


export const ScienceMotionDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const shot = shots.find((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames) ?? shots[shots.length - 1];
  const Scene = shot.Component;
  const subtitle = subtitles.find((item) => frame >= (item.startFrame ?? 0) && frame < (item.endFrame ?? episodeData.episode.durationFrames))?.text ?? "";

  return (
    <AbsoluteFill>
      <Scene frame={frame - shot.startFrame} />
      {episodeData.audioCues.filter((cue) => cue.type === "narration").map((cue) => {
        const asset = episodeData.assets.find((item) => item.id === cue.assetId);
        return asset ? <Audio key={cue.id} src={staticFile(asset.uri)} startFrom={0} volume={cue.gain} /> : null;
      })}
      <div style={{ position: "absolute", left: 210, right: 210, bottom: 145, minHeight: 56, padding: "12px 26px", boxSizing: "border-box", borderRadius: 14, background: "rgba(4, 12, 23, .88)", border: "1px solid #29445c", color: "#f4f7fb", fontFamily: FONT, fontSize: 23, lineHeight: 1.5, textAlign: "center" }}>
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};
