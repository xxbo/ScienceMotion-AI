import type { Keyframe, ProjectAnimationTrack } from "../../src/contracts/project";

// This recipe is public tool input, not a seeded ProjectDocument or a solved physical model.
export const projectId = "pendulum-motion-delivery";
export const sceneId = "pendulum-cycle";
export const title = "单摆的一个周期";
export const profile = { width: 640, height: 360, fps: 20 };
export const range = { startFrame: 0, durationFrames: 120 };
export const motion = { constraintId: "bob-follows-arc", followerNodeId: "pendulum-bob", guideNodeId: "swing-arc" };
export const pivot = [216, 127] as const;
export const radius = 130, bobRadius = 13, release = 12;
export const crop = { x: 120, y: 112, width: 192, height: 164 }; // Contains all edited pixels at the sampled frame poses.
export const colors = { bob: [101, 226, 222], rod: [198, 215, 233], pin: [237, 244, 255] } as const;

// Integer endpoints of two circular arcs centered on the same fixed pivot.
export const originalSwing = { dx: 50, dy: 120, quarterFrames: 18 };
export const editedSwing = { dx: 78, dy: 104, quarterFrames: 22 };
export type Swing = typeof originalSwing;
const quadraticIn = "cubic-bezier(0.3333333333333333,0,0.6666666666666666,0.3333333333333333)";
const quadraticOut = "cubic-bezier(0.3333333333333333,0.6666666666666666,0.6666666666666666,1)";
const guideBox = { x: 24, y: 92, width: 386, height: 220 };
const rgb = (color: readonly number[]) => "#" + color.map(channel => channel.toString(16).padStart(2, "0")).join("");

export function motionInputs({ dx, dy, quarterFrames }: Swing) {
  const [x, y] = [pivot[0] - guideBox.x, pivot[1] - guideBox.y + dy];
  const pathData = `M ${x - dx} ${y} A ${radius} ${radius} 0 0 0 ${x + dx} ${y}`;
  const keyframes: Keyframe<number>[] = [{ frame: 0, value: 0 }, { frame: release, value: 0 }];
  for (const [i, value] of [0.5, 1, 0.5, 0].entries()) {
    keyframes.push({ frame: release + (i + 1) * quarterFrames, value, interpolation: "bezier", easing: i % 2 === 0 ? quadraticIn : quadraticOut });
  }
  const extent = Math.atan2(dx, dy) * 180 / Math.PI;
  // In y-down coordinates a positive Z rotation of the downward rod points left.
  const rod: ProjectAnimationTrack = { id: "rod-angle", targetNodeId: "pendulum-rod", targetProperty: "transform.rotation",
    keyframes: keyframes.map(({ value, ...key }) => ({ ...key, value: [0, 0, extent * (1 - 2 * value)] })) };
  return { pathData, keyframes, rod, extent };
}

type ArtworkCall = { toolId: "graphics.2d.shape.create" | "graphics.2d.text.create" | "graphics.2d.path.create"; input: object };
const shape = (nodeId: string, x: number, y: number, width: number, height: number, fill: string,
  radiusPx = 0, primitive = "rect"): ArtworkCall => ({ toolId: "graphics.2d.shape.create", input: { sceneId, nodeId, x, y, width, height, fill, primitive, radius: radiusPx } });
const path = (nodeId: string, pathData: string, box: typeof guideBox, stroke: string, strokeWidth: number): ArtworkCall => (
  { toolId: "graphics.2d.path.create", input: { sceneId, nodeId, pathData, ...box, stroke, strokeWidth, fill: "transparent" } });
const text = (nodeId: string, label: string, x: number, y: number, width: number, height: number,
  fontSize: number, color: string, fontWeight = 400, textAlign = "left"): ArtworkCall => ({ toolId: "graphics.2d.text.create",
  input: { sceneId, nodeId, text: label, x, y, width, height, fontSize, fontFamily: "Noto Sans CJK SC, sans-serif", color, fontWeight, textAlign } });

export const artwork = [
  shape("background", 0, 0, profile.width, profile.height, "#101a2b"),
  shape("diagram-panel", 24, 92, 386, 220, "#15253b", 12),
  shape("period-panel", 426, 92, 190, 220, "#1b3048", 12),
  shape("kicker-rule", 24, 24, 22, 2, "#65e2de"),
  text("kicker", "物理图解 01  /  周期运动", 54, 16, 316, 18, 12, "#a6bed6", 600),
  text("title", title, 24, 37, 590, 41, 30, "#edf4ff", 700),
  path("center-line", "M 192 35 V 178 M 186 172 H 198", guideBox, "#36516f", 1.5),
  path(motion.guideNodeId, motionInputs(originalSwing).pathData, guideBox, "#6786aa", 2.5),
  path("pendulum-rod", `M 0 0 V ${radius}`, { x: pivot[0], y: pivot[1], width: 4, height: radius }, rgb(colors.rod), 4),
  shape(motion.followerNodeId, pivot[0] - bobRadius, pivot[1] + radius - bobRadius,
    2 * bobRadius, 2 * bobRadius, rgb(colors.bob), 0, "circle"),
  shape("pivot", pivot[0] - 5, pivot[1] - 5, 10, 10, rgb(colors.pin), 0, "circle"),
  text("low-point", "最低点", 172, 276, 88, 20, 13, "#a6bed6", 400, "center"),
  text("period-title", "一个完整往返", 444, 113, 154, 30, 21, "#edf4ff", 700),
  text("period-steps", "01  从一侧出发\n02  摆到另一侧\n03  回到原来一侧", 444, 161, 156, 78, 17, "#dbe7f7", 500),
  shape("period-divider", 444, 255, 154, 1, "#3e5876"),
  text("period-note", "到达对侧，只走了一半", 444, 270, 156, 19, 13, "#8fdddc", 600),
  text("scope-note", "轨迹与计时仅为示意，不代表实测结果。", 24, 325, 592, 20, 13, "#a6bed6"),
];

/** Analytic center of a circular pendulum diagram, independent of the SVG path compiler and keyframe sampler. */
export function expectedCenter({ dx, dy, quarterFrames }: Swing, frame: number): [number, number] {
  const time = Math.max(0, Math.min(4, (frame - release) / quarterFrames));
  const segment = Math.min(3, Math.floor(time));
  const t = time - segment;
  const fraction = segment % 2 === 0 ? t * t : 2 * t - t * t;
  const progress = ([0, 0.5, 1, 0.5][segment] + fraction * (segment < 2 ? 0.5 : -0.5));
  const angle = (2 * progress - 1) * Math.atan2(dx, dy);
  return [pivot[0] + radius * Math.sin(angle), pivot[1] + radius * Math.cos(angle)];
}
