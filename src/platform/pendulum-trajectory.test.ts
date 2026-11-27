import assert from "node:assert/strict";
import test from "node:test";
import reference from "../../examples/pendulum-physics-reference.json";
import { PENDULUM_MAX_STEPS } from "../contracts/pendulum-trajectory";
import { InMemoryArtifactStore } from "./artifact-store";
import { encodePendulumTrajectory, readPendulumTrajectory, retainPendulumTrajectory } from "./pendulum-trajectory-artifact";
import { parsePendulumTrajectory, PendulumTrajectoryError, samplePendulumTrajectory, solvePendulumTrajectory } from "./pendulum-trajectory";

const short = reference.cases[0];
const options = { timeStepSeconds: 1 / 240, stepCount: 240 };
const invalidAt = (path: string) => (e: unknown) => {
  assert.ok(e instanceof PendulumTrajectoryError);
  assert.equal(e.code, "PENDULUM_TRAJECTORY_INVALID");
  assert.equal(e.path, path);
  return true;
};

test("the trajectory has both physical-time endpoints, nonlinear release motion and fixed-rod coordinates", () => {
  const solved = solvePendulumTrajectory(short.model, options);
  assert.deepEqual(solved.solver, { id: "pendulum-rk4", version: "1.0.0" });
  assert.equal(solved.samples.length, 241);
  assert.equal(solved.samples[0].angleRadians, short.model.initialState.angleRadians);
  assert.equal(solved.samples[0].angularVelocityRadiansPerSecond, 0);
  assert.ok(solved.samples[1].angleRadians > solved.samples[0].angleRadians);
  assert.ok(solved.samples[1].angularVelocityRadiansPerSecond > 0);
  for (const [i, state] of solved.samples.entries()) {
    assert.equal(state.timeSeconds, i * options.timeStepSeconds);
    assert.equal(state.bobPositionMeters[2], 0);
    assert.ok(Math.abs(Math.hypot(...state.bobPositionMeters) - short.model.lengthMeters) < 1e-14);
  }
  assert.equal(solved.samples.at(-1)!.timeSeconds, 1);
  assert.deepEqual(parsePendulumTrajectory(solved), solved);
});

test("stationary equilibrium stays exactly at rest rather than receiving a nominal oscillation", () => {
  const solved = solvePendulumTrajectory({ ...short.model, initialState: { angleRadians: 0, angularVelocityRadiansPerSecond: 0 } }, options);
  assert.ok(solved.samples.every(state => state.angleRadians === 0 && state.angularVelocityRadiansPerSecond === 0 &&
    state.specificEnergySquareMetersPerSecondSquared === 0 && state.bobPositionMeters[0] === 0 &&
    state.bobPositionMeters[1] === -short.model.lengthMeters));
});

test("a higher RK4 sample rate improves the endpoint by the expected order of magnitude", () => {
  const end = (hz: number) => solvePendulumTrajectory(short.model, { timeStepSeconds: 1 / hz, stepCount: hz }).samples.at(-1)!;
  const truth = end(1920);
  const error = (hz: number) => {
    const state = end(hz);
    return Math.hypot(state.angleRadians - truth.angleRadians, state.angularVelocityRadiansPerSecond - truth.angularVelocityRadiansPerSecond);
  };
  assert.ok(error(60) > 8 * error(120), "halving the fixed step should reduce integration error by more than 8x");
});

test("Hermite sampling matches a timed crossing between steps and rejects extrapolation", () => {
  const solved = solvePendulumTrajectory(short.model, options);
  const crossing = short.checkpoints[1];
  assert.ok(!solved.samples.some(s => s.timeSeconds === crossing.timeSeconds));
  const point = samplePendulumTrajectory(solved, crossing.timeSeconds);
  assert.equal(point.timeSeconds, crossing.timeSeconds);
  assert.ok(Math.abs(point.angleRadians) < 1e-6);
  assert.ok(Math.abs(point.angularVelocityRadiansPerSecond - crossing.angularVelocityRadiansPerSecond) < 1e-6);
  const exact = samplePendulumTrajectory(solved, solved.samples[5].timeSeconds);
  assert.deepEqual(exact, solved.samples[5]);
  exact.bobPositionMeters[0] = 100;
  assert.notEqual(solved.samples[5].bobPositionMeters[0], 100);
  for (const t of [NaN, Infinity, -0.001, 1.000001]) assert.throws(() => samplePendulumTrajectory(solved, t), invalidAt("/timeSeconds"));
});

test("invalid simulation clocks and retained data fail with field diagnostics", () => {
  for (const stepCount of [0, 1.5, Infinity, PENDULUM_MAX_STEPS + 1])
    assert.throws(() => solvePendulumTrajectory(short.model, { ...options, stepCount }), invalidAt("/stepCount"));
  for (const timeStepSeconds of [0, -1, NaN, Infinity, Number.MIN_VALUE, 0.1])
    assert.throws(() => solvePendulumTrajectory(short.model, { ...options, timeStepSeconds }), invalidAt("/timeStepSeconds"));
  const solved = solvePendulumTrajectory(short.model, options);
  for (const [path, edit] of [
    ["/solver/version", (v: typeof solved) => Object.assign(v.solver, { version: "2.0.0" })],
    ["/samples", (v: typeof solved) => v.samples.pop()],
    ["/samples/0", (v: typeof solved) => v.samples[0].angleRadians = 0],
    ["/samples/1/timeSeconds", (v: typeof solved) => v.samples[1].timeSeconds = 0],
    ["/samples/1/bobPositionMeters", (v: typeof solved) => v.samples[1].bobPositionMeters[2] = 1],
    ["/samples/1/specificEnergySquareMetersPerSecondSquared", (v: typeof solved) => v.samples[1].specificEnergySquareMetersPerSecondSquared = 0],
    ["/samples/1/angularVelocityRadiansPerSecond", (v: typeof solved) => v.samples[1].angularVelocityRadiansPerSecond = Infinity],
    ["/model/gravityMetersPerSecondSquared", (v: typeof solved) => v.model.lengthMeters = Number.MIN_VALUE],
  ] as const) {
    const broken = structuredClone(solved);
    edit(broken);
    assert.throws(() => parsePendulumTrajectory(broken), invalidAt(path));
  }
});

test("equivalent inputs produce identical content-addressed bytes and reads fail on corruption", async () => {
  const artifacts = new InMemoryArtifactStore(), original = solvePendulumTrajectory(short.model, options);
  const reordered = Object.fromEntries(Object.entries(short.model).reverse());
  const repeated = solvePendulumTrajectory(reordered, options);
  assert.deepEqual(encodePendulumTrajectory(original), encodePendulumTrajectory(repeated));
  const record = await retainPendulumTrajectory(artifacts, original);
  assert.deepEqual(await retainPendulumTrajectory(artifacts, repeated), record);
  assert.equal((await artifacts.list()).length, 1);
  const result = await readPendulumTrajectory(artifacts, record.id);
  assert.deepEqual(result, { record, trajectory: original, bytes: encodePendulumTrajectory(original) });
  const altered = result.bytes.slice();
  altered[0] ^= 1;
  await assert.rejects(() => readPendulumTrajectory({ get: () => artifacts.get(record.id), read: async () => altered }, record.id), invalidAt("/artifact"));
});
