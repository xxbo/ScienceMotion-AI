import type { PendulumSample, PendulumTrajectory } from "../contracts/pendulum-trajectory";
import { ProjectGraphRendererError, type ProjectGraphVideoRequest } from "../contracts/renderer";
import { preparePendulumReplay } from "./pendulum-replay";
import { decodePendulumTrajectory } from "./pendulum-trajectory-artifact";
import { samplePendulumTrajectory } from "./pendulum-trajectory";

export const PENDULUM_MATH_RENDERER = { id: "manim.pendulum-math", version: "1.0.0" } as const;
type Point = { timeSeconds: number; angleRadians: number };

/** Infer the continuous event time from adjacent retained samples, not a rounded video frame. */
function zeros(trajectory: PendulumTrajectory, key: "angleRadians" | "angularVelocityRadiansPerSecond") {
  const result: Array<{ timeSeconds: number; direction: 1 | -1 }> = [];
  const { samples } = trajectory;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], before = a[key], after = b[key];
    const direction = before < 0 && after >= 0 ? 1 : before > 0 && after <= 0 ? -1 : 0;
    if (!direction) continue;
    const fraction = -before / (after - before);
    result.push({ direction, timeSeconds: a.timeSeconds + fraction * (b.timeSeconds - a.timeSeconds) });
  }
  return result;
}
const point = ({ timeSeconds, angleRadians }: PendulumSample): Point => ({ timeSeconds, angleRadians });

/** Build the standalone Manim shot from the same verified source and poses as C. */
export function preparePendulumMathShot(request: ProjectGraphVideoRequest) {
  const { artifactId, profile, range, poses } = preparePendulumReplay(request);
  if (profile.width !== 640 || profile.height !== 360)
    throw new ProjectGraphRendererError("PENDULUM_MATH_PROFILE", "The mathematics shot uses the 640 × 360 replay canvas.");
  const trajectory = decodePendulumTrajectory(Buffer.from(request.pendulumTrajectory!, "base64"));
  const { model, samples } = trajectory;
  const { lengthMeters: length, gravityMetersPerSecondSquared: gravity } = model;
  const bottom = zeros(trajectory, "angleRadians"), turns = zeros(trajectory, "angularVelocityRadiansPerSecond");
  const [firstRight, secondRight] = bottom.filter(event => event.direction === 1);
  const [firstBottom, nextBottom] = bottom, [opposite, returned] = turns;
  const releaseLeft = model.initialState.angleRadians < 0;
  const firstDirection = releaseLeft ? 1 : -1;
  if (!secondRight || !returned || !nextBottom || firstBottom.direction !== firstDirection || nextBottom.direction !== -firstDirection ||
      opposite.direction !== -firstDirection || returned.direction !== firstDirection ||
      !(0 < firstBottom.timeSeconds && firstBottom.timeSeconds < opposite.timeSeconds &&
        opposite.timeSeconds < nextBottom.timeSeconds && nextBottom.timeSeconds < returned.timeSeconds))
    throw new ProjectGraphRendererError("PENDULUM_MATH_CYCLE", "Use a retained oscillation with a full cycle and two rightward bottom crossings.");
  const periodIntervalSeconds: [number, number] = [firstRight.timeSeconds, secondRight.timeSeconds];
  const phases = [
    { phase: releaseLeft ? "release-left" : "release-right", ...point(samples[0]) },
    { phase: releaseLeft ? "lowest-rightward" : "lowest-leftward", timeSeconds: firstBottom.timeSeconds, angleRadians: 0 },
    { phase: "opposite-extreme", ...point(samplePendulumTrajectory(trajectory, opposite.timeSeconds)) },
    { phase: releaseLeft ? "lowest-leftward" : "lowest-rightward", timeSeconds: nextBottom.timeSeconds, angleRadians: 0 },
    { phase: releaseLeft ? "return-left" : "return-right", ...point(samplePendulumTrajectory(trajectory, returned.timeSeconds)) },
  ];
  return { schemaVersion: "1.0.0" as const, renderer: PENDULUM_MATH_RENDERER,
    source: { artifactId, snapshotHash: request.snapshotHash, revisionId: request.revisionId }, profile, range, model,
    sampleRateHz: 1 / trajectory.timeStepSeconds, curve: samples.map(point),
    frames: poses.map(({ sceneFrame, timeSeconds, angleRadians }) => ({ sceneFrame, timeSeconds, angleRadians })),
    phases, period: { measuredSeconds: periodIntervalSeconds[1] - periodIntervalSeconds[0], periodIntervalSeconds,
      smallAngleSeconds: 2 * Math.PI * Math.sqrt(length / gravity) } };
}

export type PendulumMathShot = ReturnType<typeof preparePendulumMathShot>;
