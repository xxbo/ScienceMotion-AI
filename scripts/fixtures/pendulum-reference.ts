import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import Ajv from "ajv";
import projectSchema from "../../schemas/project.schema.json";
import type { ProjectAnimationTrack, SceneNode } from "../../src/contracts/project";
import { createEmptyProject } from "../../src/platform/empty-project";
import { assertCreativeDocument } from "../../src/platform/project-creative-edits";
import { InMemorySnapshotStore } from "../../src/platform/project-snapshots";

const createdAt = "2026-11-25T00:00:00.000Z";
const title = "单摆的运动与周期";
const point = (x: number, y: number): [number, number] => [x, y];
const profile = { width: 640, height: 360, fps: 20 };
const video = { startFrame: 0, durationFrames: 120 };
const pivot = point(222, 128), radiusPx = 144, bobRadiusPx = 14, amplitudeDegrees = 18;
const releaseFrame = 12, quarterFrames = 12, cycles = 2, cycleFrames = 4 * quarterFrames;
const bobRgb: [number, number, number] = [101, 226, 222];
const pinRgb: [number, number, number] = [230, 239, 255];
const searchWindow = { x: 154, y: 244, width: 136, height: 50 };
const rgbHex = (rgb: number[]) => "#" + rgb.map(value => value.toString(16).padStart(2, "0")).join("");
const roundPx = (value: number) => Math.round(value * 1000) / 1000;
const [px, py] = pivot;
const angles = [amplitudeDegrees, 0, -amplitudeDegrees, 0] as const;
const phases = ["left-extreme", "lowest-rightward", "right-extreme", "lowest-leftward"] as const;
const expectedCenter = (angle: number) => point(
  roundPx(px - radiusPx * Math.sin(angle * Math.PI / 180)),
  roundPx(py + radiusPx * Math.cos(angle * Math.PI / 180)),
);
const target = (frame: number, phase: string, angle: number) => ({ frame, phase, center: expectedCenter(angle) });
const swing = Array.from({ length: 4 * cycles + 1 }, (_, quarter) => ({
  frame: releaseFrame + quarter * quarterFrames, angle: angles[quarter % 4], phase: phases[quarter % 4],
}));
const checkpoints = [
  target(0, "opening-hold", amplitudeDegrees),
  ...swing.map(({ frame, angle, phase }) => target(frame, phase, angle)),
  target(video.durationFrames - 1, "closing-hold", amplitudeDegrees),
];

function node(id: string, type: SceneNode["type"], x: number, y: number, components: SceneNode["components"] = []): SceneNode {
  return { id, name: id, type, transform: { position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components };
}
const shape = (id: string, primitive: "rect" | "circle", x: number, y: number, width: number, height: number, fill: string, radius = 0) =>
  node(id, "shape", x, y, [{ kind: "geometry", data: { primitive, width, height, fill, radius, strokeWidth: 0 } }]);
const label = (id: string, text: string, x: number, y: number, width: number, height: number, fontSize: number, color: string, fontWeight = 400) =>
  node(id, "text", x, y, [{ kind: "text", data: { text, width, height, fontSize, color, fontWeight, fontFamily: "Noto Sans CJK SC, sans-serif" } }]);

function buildReference() {
  const project = createEmptyProject({ id: "pendulum-motion-reference", name: title, episodeId: "pendulum-period", createdAt,
    ...profile, durationFrames: video.durationFrames });
  const swingArm = node("swing-arm", "group", px, py);
  const rod = { ...shape("pendulum-rod", "rect", -2, 0, 4, radiusPx, "#c7d7ec"), parentId: swingArm.id };
  const bob = { ...shape("pendulum-bob", "circle", -bobRadiusPx, radiusPx - bobRadiusPx, 2 * bobRadiusPx, 2 * bobRadiusPx, rgbHex(bobRgb)), parentId: swingArm.id };
  swingArm.childIds = [rod.id, bob.id];
  const [leftX, sideY] = expectedCenter(amplitudeDegrees);
  const [rightX] = expectedCenter(-amplitudeDegrees);
  const arc = `M ${px - 24} ${py - 92} V ${py + radiusPx - 92 + 8} M ${leftX - 24} ${sideY - 92} A ${radiusPx} ${radiusPx} 0 0 0 ${rightX - 24} ${sideY - 92}`;
  project.nodes = [
    shape("background", "rect", 0, 0, profile.width, profile.height, "#101a2b"),
    shape("diagram-card", "rect", 24, 92, 396, 228, "#15253b", 12),
    shape("explanation-card", "rect", 432, 92, 184, 228, "#1a2e46", 12),
    node("swing-guide", "path", 24, 92, [{ kind: "geometry", data: { pathData: arc, width: 396, height: 228, fill: "transparent", stroke: "#4b6b8c", strokeWidth: 2 } }]),
    swingArm, rod, bob,
    shape("pendulum-pivot", "circle", px - 5, py - 5, 10, 10, rgbHex(pinRgb)),
    label("reference-kicker", "动作研究 01  /  2D 参考", 24, 15, 368, 18, 12, "#9bb7d1", 600),
    label("reference-title", title, 24, 36, 592, 40, 29, "#edf4ff", 700),
    label("lowest-point", "最低点", 204, 292, 80, 18, 12, "#9bb7d1"),
    label("period-title", "一个周期", 449, 111, 150, 32, 23, "#edf4ff", 700),
    label("period-text", "从一侧出发\n经过最低点到对侧\n回到出发的一侧", 449, 153, 148, 103, 17, "#dce8fa"),
    label("diagram-note", "示意计时 · 非实测", 449, 284, 148, 18, 12, "#9bb7d1"),
  ];
  const motion: ProjectAnimationTrack["keyframes"] = [{ frame: 0, value: [0, 0, amplitudeDegrees] }];
  for (const [quarter, { frame, angle }] of swing.entries()) {
    motion.push({ frame, value: [0, 0, angle],
      ...(quarter ? { interpolation: "bezier", easing: quarter % 2 ? "ease-in" : "ease-out" } : {}) });
  }
  project.animationTracks = [{ id: "swing-angle", targetNodeId: swingArm.id, targetProperty: "transform.rotation", keyframes: motion }];
  const sceneId = "pendulum-period";
  project.scenes = [{ id: sceneId, name: title, durationFrames: video.durationFrames, rootNodeIds: project.nodes.filter(item => !item.parentId).map(item => item.id) }];
  project.shots = [{ id: "shot-pendulum", name: title, sceneId, startFrame: 0, durationFrames: video.durationFrames }];
  project.sequences[0].shotIds = ["shot-pendulum"];
  project.revisions[0].message = "Pin the P2.1-A pendulum reference with existing angular keyframes";
  assertCreativeDocument(project);
  const validate = new Ajv({ allErrors: true, strict: true }).compile(projectSchema);
  assert.ok(validate(project), JSON.stringify(validate.errors));

  return {
    schemaVersion: "1.0.0",
    brief: {
      title, audience: "第一次学习周期运动的观众",
      learningGoal: "能区分单程摆动和一个完整周期。",
      editorialClaim: "从同一侧极值出发，经过另一侧极值并回到原来的极值，完成一次完整摆动。",
      reference: "https://openstax.org/books/university-physics-volume-1/pages/15-4-pendulums",
      motionKind: "authored-angular-keyframes",
      scope: "示意动画。像素长度和播放时长不代表实际单摆的长度和周期。",
    },
    snapshot: new InMemorySnapshotStore().save(project, { id: "pendulum-motion-v1", createdAt }),
    workload: {
      profile, video, motion: { pivot, radiusPx, bobRadiusPx, amplitudeDegrees, releaseFrame, cycleFrames, cycles },
      previews: [releaseFrame, releaseFrame + quarterFrames, releaseFrame + 2 * quarterFrames],
      checkpoints, searchWindow, bobRgb, pinRgb,
      directionChecks: swing.filter(({ phase }) => phase.startsWith("lowest")).map(({ frame, phase }) => ({
        beforeFrame: frame - 2, crossingFrame: frame, afterFrame: frame + 2, direction: phase === phases[1] ? "right" : "left",
      })),
      tolerances: { pngChannel: 0, videoChannel: 10, pngPositionPx: 1, videoPositionPx: 2, minCrossingOffsetPx: 4 },
    },
  };
}
export type PendulumReference = ReturnType<typeof buildReference>;

const [option, extra] = process.argv.slice(2);
assert.ok((option === undefined || option === "--write") && extra === undefined);
const reference = buildReference();
const file = "examples/pendulum-motion-reference.json";
if (option === "--write") await writeFile(file, JSON.stringify(reference, null, 2) + "\n");
else assert.deepEqual(JSON.parse(await readFile(file, "utf8")), reference, "The pinned pendulum reference differs from its authored fixture");
console.log(`Verified ${reference.snapshot.id} ${reference.snapshot.contentHash}`);
