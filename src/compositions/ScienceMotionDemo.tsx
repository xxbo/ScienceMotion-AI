import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

const colors = {
  background: "#07111f",
  panel: "#102238",
  text: "#f4f7fb",
  muted: "#9db0c7",
  cyan: "#55d6e8",
  blue: "#638cff",
  orange: "#ffb45e",
};

const SceneTitle: React.FC<{ eyebrow: string; title: string; subtitle: string }> = ({
  eyebrow,
  title,
  subtitle,
}) => (
  <div style={{ position: "absolute", left: 112, top: 94, right: 112 }}>
    <div style={{ color: colors.cyan, fontSize: 25, letterSpacing: 5, fontWeight: 700 }}>
      {eyebrow.toUpperCase()}
    </div>
    <div style={{ color: colors.text, fontSize: 66, fontWeight: 750, marginTop: 20 }}>
      {title}
    </div>
    <div style={{ color: colors.muted, fontSize: 29, marginTop: 18 }}>{subtitle}</div>
  </div>
);

const MemoryBlock: React.FC<{ x: number; label: string; color: string; delay: number }> = ({
  x,
  label,
  color,
  delay,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame - delay, [0, 18], [35, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: 470 + y,
        width: 330,
        height: 190,
        borderRadius: 24,
        border: `2px solid ${color}`,
        background: colors.panel,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        opacity,
        boxShadow: `0 0 42px ${color}22`,
      }}
    >
      <div style={{ color, fontSize: 27, fontWeight: 700 }}>{label}</div>
    </div>
  );
};

const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 24], [0, 1], {
    extrapolateRight: "clamp",
  });
  const scale = interpolate(frame, [0, 45], [0.94, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.background, opacity }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 72% 48%, #173b59 0%, transparent 48%), radial-gradient(circle at 20% 80%, #142b48 0%, transparent 40%)",
        }}
      />
      <div style={{ position: "absolute", left: 140, top: 300, transform: `scale(${scale})` }}>
        <div style={{ color: colors.cyan, fontSize: 28, letterSpacing: 7, fontWeight: 700 }}>
          SCIENCEMOTION AI
        </div>
        <div style={{ color: colors.text, fontSize: 92, fontWeight: 800, marginTop: 28 }}>
          Ideas, in motion.
        </div>
        <div style={{ color: colors.muted, fontSize: 34, marginTop: 24 }}>
          A code-driven science explainer video engine
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 220,
          top: 360,
          width: 260,
          height: 260,
          border: `3px solid ${colors.cyan}`,
          borderRadius: "50%",
          transform: `rotate(${(frame / fps) * 24}deg)`,
          boxShadow: `0 0 80px ${colors.cyan}33`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 112,
            top: -18,
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: colors.orange,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const ArchitectureScene: React.FC = () => {
  const frame = useCurrentFrame();
  const pulse = 0.65 + Math.sin(frame / 10) * 0.12;
  return (
    <AbsoluteFill style={{ backgroundColor: colors.background }}>
      <SceneTitle
        eyebrow="The pipeline"
        title="From an idea to a rendered film"
        subtitle="Every frame is described, timed, and reproducible."
      />
      <div style={{ display: "flex", gap: 28, position: "absolute", left: 110, top: 470 }}>
        {[
          ["01", "Research", colors.cyan],
          ["02", "Storyboard", colors.blue],
          ["03", "Animate", colors.orange],
          ["04", "Render", "#8bd6a4"],
        ].map(([number, label, color], index) => (
          <React.Fragment key={number}>
            <div
              style={{
                width: 350,
                height: 205,
                borderRadius: 22,
                background: colors.panel,
                border: `2px solid ${color}`,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                paddingLeft: 34,
                boxSizing: "border-box",
                boxShadow: index === Math.floor(frame / 35) % 4 ? `0 0 45px ${color}44` : "none",
                transform: `translateY(${Math.sin((frame + index * 12) / 12) * 4}px)`,
              }}
            >
              <div style={{ color, fontSize: 25, fontWeight: 700 }}>{number}</div>
              <div style={{ color: colors.text, fontSize: 38, fontWeight: 700, marginTop: 18 }}>
                {label}
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <div style={{ position: "absolute", bottom: 145, left: 115, color: colors.muted, fontSize: 26, opacity: pulse }}>
        Deterministic timing · Reusable scenes · Frame-accurate output
      </div>
    </AbsoluteFill>
  );
};

const CacheScene: React.FC = () => {
  const frame = useCurrentFrame();
  const beam = interpolate(frame, [10, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: colors.background }}>
      <SceneTitle
        eyebrow="First science demo"
        title="Why does a CPU need cache?"
        subtitle="A tiny, fast memory keeps frequently used data close to the processor."
      />
      <MemoryBlock x={180} label="CPU" color={colors.cyan} delay={0} />
      <MemoryBlock x={795} label="Cache · L1 / L2 / L3" color={colors.orange} delay={12} />
      <MemoryBlock x={1410} label="Main memory" color={colors.blue} delay={24} />
      <div
        style={{
          position: "absolute",
          left: 520,
          top: 552,
          width: 250 * beam,
          height: 5,
          background: colors.cyan,
          boxShadow: `0 0 22px ${colors.cyan}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 1135,
          top: 552,
          width: 250 * beam,
          height: 5,
          background: colors.blue,
          boxShadow: `0 0 22px ${colors.blue}`,
        }}
      />
      <div style={{ position: "absolute", left: 180, bottom: 170, color: colors.muted, fontSize: 27 }}>
        Nearer to the CPU = lower latency, smaller capacity
      </div>
    </AbsoluteFill>
  );
};

export const ScienceMotionDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const scene = frame < 90 ? 0 : frame < 195 ? 1 : 2;
  const components = [<IntroScene />, <ArchitectureScene />, <CacheScene />];

  return (
    <AbsoluteFill>
      {components[scene]}
      <div
        style={{
          position: "absolute",
          bottom: 48,
          left: 112,
          right: 112,
          height: 4,
          background: "#294058",
          borderRadius: 4,
        }}
      >
        <div
          style={{
            width: `${((frame + 1) / 300) * 100}%`,
            height: "100%",
            background: colors.cyan,
            borderRadius: 4,
          }}
        />
      </div>
      <div style={{ position: "absolute", right: 112, bottom: 70, color: colors.muted, fontSize: 20 }}>
        SCIENCEMOTION AI · DEMO
      </div>
    </AbsoluteFill>
  );
};
