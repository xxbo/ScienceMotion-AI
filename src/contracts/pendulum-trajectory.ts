import type { PendulumModel, PendulumState } from "./pendulum-model";
import type { Vector3 } from "./project";

export const PENDULUM_SOLVER = { id: "pendulum-rk4", version: "1.0.0" } as const;
export const PENDULUM_MAX_STEPS = 10_000;

export interface PendulumSolveOptions {
  timeStepSeconds: number;
  stepCount: number;
}

export interface PendulumSample extends PendulumState {
  timeSeconds: number;
  bobPositionMeters: Vector3;
  specificEnergySquareMetersPerSecondSquared: number;
}

/** The model declares SI and axes. Sample i is evaluated at i * timeStepSeconds, including both endpoints. */
export interface PendulumTrajectory extends PendulumSolveOptions {
  schemaVersion: "1.0.0";
  model: PendulumModel;
  solver: typeof PENDULUM_SOLVER;
  samples: PendulumSample[];
}
