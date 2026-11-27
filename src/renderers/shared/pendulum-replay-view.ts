import type { PendulumReplay, PendulumReplayPose } from "../../contracts/pendulum-replay";
import type { Vector3 } from "../../contracts/project";

export const pendulumReplayStyle = {
  background: "#07111f", guide: "#22364a", rod: "#a2b5c8", pivot: "#e5eef7", bob: "#f49b39",
  bobRadius: 0.105, pivotRadius: 0.043, rodRadius: 0.015,
};

export function pendulumReplayViewport({ width, height }: PendulumReplay["profile"]) {
  return { pivotX: width / 2, pivotY: 0.42 * height, pixelsPerRod: 0.32 * Math.min(width, height) };
}

/** Normalize one metre-based pose to a unit rod for display, without changing its world direction. */
export function normalizedReplayBob(pose: PendulumReplayPose, lengthMeters: number): Vector3 {
  const [x, y, z] = pose.bobPositionMeters;
  return [x / lengthMeters, y / lengthMeters, z / lengthMeters];
}
