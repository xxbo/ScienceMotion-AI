import Ajv from "ajv";
import modelSchema from "../../schemas/pendulum-model.schema.json";
import trajectorySchema from "../../schemas/pendulum-trajectory.schema.json";
import type { PendulumModel } from "../contracts/pendulum-model";
import { PENDULUM_MAX_STEPS, PENDULUM_SOLVER, type PendulumSample, type PendulumSolveOptions, type PendulumTrajectory } from "../contracts/pendulum-trajectory";
import { parsePendulumModel, pendulumAngularAcceleration, pendulumBobPosition, pendulumSpecificEnergy, PendulumModelError } from "./pendulum-model";

const validate = new Ajv({ strict: true, ownProperties: true }).addSchema(modelSchema).compile<PendulumTrajectory>(trajectorySchema);
const escapePointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const closeFloat = (actual: number, expected: number) =>
  actual === expected || Math.abs(actual - expected) <= (16 * Number.EPSILON) * Math.abs(expected);

export class PendulumTrajectoryError extends Error {
  readonly code = "PENDULUM_TRAJECTORY_INVALID";
  constructor(readonly path: string, message: string) {
    super(`${path || "/"} ${message}`);
    this.name = "PendulumTrajectoryError";
  }
}

function checkClock(model: PendulumModel, { timeStepSeconds: h, stepCount }: PendulumSolveOptions) {
  if (!Number.isSafeInteger(stepCount) || stepCount < 1 || stepCount > PENDULUM_MAX_STEPS)
    throw new PendulumTrajectoryError("/stepCount", `must be an integer from 1 to ${PENDULUM_MAX_STEPS}`);
  if (!Number.isFinite(h) || h / 2 <= 0 || !Number.isFinite(h * stepCount))
    throw new PendulumTrajectoryError("/timeStepSeconds", "must yield finite, positive half-steps and a finite duration");
  const nondimensionalStep = h * Math.sqrt(model.gravityMetersPerSecondSquared / model.lengthMeters);
  if (!(nondimensionalStep > 0 && nondimensionalStep <= 0.1))
    throw new PendulumTrajectoryError("/timeStepSeconds", "must give 0 < h sqrt(g/L) <= 0.1 for this solver");
}

function observe(model: PendulumModel, timeSeconds: number, angleRadians: number, angularVelocityRadiansPerSecond: number, path: string): PendulumSample {
  const state = { angleRadians, angularVelocityRadiansPerSecond };
  const bobPositionMeters = pendulumBobPosition(model, angleRadians);
  const specificEnergySquareMetersPerSecondSquared = pendulumSpecificEnergy(model, state);
  if (![angleRadians, angularVelocityRadiansPerSecond, ...bobPositionMeters, specificEnergySquareMetersPerSecondSquared].every(Number.isFinite))
    throw new PendulumTrajectoryError(path, "must yield a finite state, bob position and energy");
  return { timeSeconds, ...state, bobPositionMeters, specificEnergySquareMetersPerSecondSquared };
}

/** Classical RK4 integrates the nonlinear SI equation. It uses no reference period, frame rate or randomness. */
export function solvePendulumTrajectory(input: unknown, options: PendulumSolveOptions): PendulumTrajectory {
  const parsed = parsePendulumModel(input);
  // Fixed field order makes serialized output independent of the input JSON's property order.
  const model: PendulumModel = { schemaVersion: parsed.schemaVersion, model: parsed.model, units: parsed.units, coordinateSystem: parsed.coordinateSystem,
    lengthMeters: parsed.lengthMeters, gravityMetersPerSecondSquared: parsed.gravityMetersPerSecondSquared,
    initialState: { angleRadians: parsed.initialState.angleRadians, angularVelocityRadiansPerSecond: parsed.initialState.angularVelocityRadiansPerSecond } };
  const { timeStepSeconds: h, stepCount } = options;
  checkClock(model, { timeStepSeconds: h, stepCount });
  const half = h / 2, acceleration = (angle: number) => pendulumAngularAcceleration(model, angle);
  const weighted = (a: number, b: number, c: number, d: number) => a / 6 + b / 3 + c / 3 + d / 6;
  let theta = model.initialState.angleRadians, omega: number = model.initialState.angularVelocityRadiansPerSecond;
  const samples: PendulumSample[] = [];
  for (let i = 0; i <= stepCount; i++) {
    samples.push(observe(model, i * h, theta, omega, `/samples/${i}`));
    if (i === stepCount) break;
    const a1 = acceleration(theta);
    const v2 = omega + half * a1, a2 = acceleration(theta + half * omega);
    const v3 = omega + half * a2, a3 = acceleration(theta + half * v2);
    const v4 = omega + h * a3, a4 = acceleration(theta + h * v3);
    theta += h * weighted(omega, v2, v3, v4);
    omega += h * weighted(a1, a2, a3, a4);
  }
  return { schemaVersion: "1.0.0", model, solver: { ...PENDULUM_SOLVER }, timeStepSeconds: h, stepCount, samples };
}

/** Validate retained data without replacing samples or silently re-running the solver. */
export function parsePendulumTrajectory(input: unknown): PendulumTrajectory {
  if (!validate(input)) {
    const error = validate.errors![0];
    const field = error.keyword === "required" ? error.params.missingProperty :
      error.keyword === "additionalProperties" ? error.params.additionalProperty : undefined;
    throw new PendulumTrajectoryError(error.instancePath + (typeof field === "string" ? "/" + escapePointer(field) : ""), error.message ?? "does not match the trajectory contract");
  }
  let model: PendulumModel;
  try { model = parsePendulumModel(input.model); }
  catch (error) {
    if (error instanceof PendulumModelError) throw new PendulumTrajectoryError("/model" + error.path, "must satisfy the SI pendulum model");
    throw error;
  }
  checkClock(model, input);
  const { samples, stepCount, timeStepSeconds: h } = input;
  if (samples.length !== stepCount + 1)
    throw new PendulumTrajectoryError("/samples", "must contain the initial state and one sample per step");
  if (samples[0].angleRadians !== model.initialState.angleRadians ||
      samples[0].angularVelocityRadiansPerSecond !== model.initialState.angularVelocityRadiansPerSecond)
    throw new PendulumTrajectoryError("/samples/0", "must match the model's initial state");
  for (const [i, sample] of samples.entries()) {
    const path = `/samples/${i}`;
    if (sample.timeSeconds !== i * h) throw new PendulumTrajectoryError(path + "/timeSeconds", "must equal the step index times timeStepSeconds");
    const expected = observe(model, sample.timeSeconds, sample.angleRadians, sample.angularVelocityRadiansPerSecond, path);
    if (!sample.bobPositionMeters.every((value, axis) => closeFloat(value, expected.bobPositionMeters[axis])))
      throw new PendulumTrajectoryError(path + "/bobPositionMeters", "must match the retained angle and model length");
    if (!closeFloat(sample.specificEnergySquareMetersPerSecondSquared, expected.specificEnergySquareMetersPerSecondSquared))
      throw new PendulumTrajectoryError(path + "/specificEnergySquareMetersPerSecondSquared", "must match the retained state and model");
  }
  return structuredClone(input);
}

/** Sample a solved or validated trajectory in physical seconds. Hermite interpolation uses angle and angular velocity. */
export function samplePendulumTrajectory(trajectory: PendulumTrajectory, timeSeconds: number): PendulumSample {
  const { model, samples } = trajectory;
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > samples[samples.length - 1].timeSeconds)
    throw new PendulumTrajectoryError("/timeSeconds", "must be inside the retained time range");
  let low = 0, high = samples.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), sample = samples[mid];
    if (timeSeconds === sample.timeSeconds) return { ...sample, bobPositionMeters: [...sample.bobPositionMeters] };
    if (timeSeconds < sample.timeSeconds) high = mid - 1;
    else low = mid + 1;
  }
  const left = samples[low - 1], right = samples[low];
  const h = right.timeSeconds - left.timeSeconds, u = (timeSeconds - left.timeSeconds) / h;
  const v0 = left.angularVelocityRadiansPerSecond, v1 = right.angularVelocityRadiansPerSecond;
  const delta = right.angleRadians - left.angleRadians;
  const b = 3 * delta - h * (2 * v0 + v1), c = -2 * delta + h * (v0 + v1);
  const theta = left.angleRadians + u * (h * v0 + u * (b + u * c));
  const omega = v0 + u * ((2 * b + 3 * u * c) / h);
  return observe(model, timeSeconds, theta, omega, "/timeSeconds");
}
