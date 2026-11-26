import assert from "node:assert/strict";
import test from "node:test";
import reference from "../../examples/pendulum-physics-reference.json";
import { parsePendulumModel, pendulumAngularAcceleration, pendulumBobPosition, pendulumSpecificEnergy, PendulumModelError } from "./pendulum-model";

const input = () => structuredClone(reference.cases[0].model);
const near = (a: number, b: number, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

function invalid(value: unknown, path: string) {
  assert.throws(() => parsePendulumModel(value), error => {
    assert.ok(error instanceof PendulumModelError);
    assert.equal(error.code, "PENDULUM_MODEL_INVALID");
    assert.equal(error.path, path);
    return true;
  });
}

test("ideal pendulum loads the explicit SI model without substituting defaults or retaining caller state", () => {
  const short = input();
  const parsed = parsePendulumModel(short);
  assert.deepEqual(parsed, short);
  short.initialState.angleRadians = 0;
  assert.notEqual(parsed.initialState.angleRadians, 0);
  assert.equal(parsePendulumModel(reference.cases[1].model).lengthMeters, 2);
});

test("pendulum preflight names unsupported model settings and ambiguous numeric inputs", () => {
  const { lengthMeters, ...missingLength } = input();
  invalid(missingLength, "/lengthMeters");
  invalid({ ...input(), schemaVersion: "2.0.0" }, "/schemaVersion");
  invalid({ ...input(), units: "imperial" }, "/units");
  invalid({ ...input(), coordinateSystem: "screen-y-down" }, "/coordinateSystem");
  invalid({ ...input(), "frames/rate~fps": 24 }, "/frames~1rate~0fps");
  for (const bad of [0, -1, "0.5", NaN, Infinity]) invalid({ ...input(), lengthMeters: bad }, "/lengthMeters");
  for (const bad of [0, -1, "9.80665", NaN, Infinity])
    invalid({ ...input(), gravityMetersPerSecondSquared: bad }, "/gravityMetersPerSecondSquared");
});

test("release excludes degree-like angles, inversion and an initial push, but permits equilibrium and both directions", () => {
  for (const angleRadians of [-30, -Math.PI, Math.PI, NaN, Infinity])
    invalid({ ...input(), initialState: { ...input().initialState, angleRadians } }, "/initialState/angleRadians");
  invalid({ ...input(), initialState: { angleRadians: -0.5, angularVelocityRadiansPerSecond: 0.1 } }, "/initialState/angularVelocityRadiansPerSecond");
  for (const angleRadians of [0, -2.8, 2.8])
    assert.equal(parsePendulumModel({ ...input(), initialState: { angleRadians, angularVelocityRadiansPerSecond: 0 } }).initialState.angleRadians, angleRadians);
});

test("the model rejects non-representable physical scales even when both input parameters are finite", () => {
  for (const [lengthMeters, gravityMetersPerSecondSquared] of [
    [Number.MIN_VALUE, 1], [Number.MAX_VALUE, 2], [1e300, 1e-300], [1e-200, 1e-200],
  ]) invalid({ ...input(), lengthMeters, gravityMetersPerSecondSquared }, "/gravityMetersPerSecondSquared");
});

test("the nonlinear restoring acceleration and bob position agree with the Y-up swing plane", () => {
  const model = parsePendulumModel(input());
  const { angleRadians } = model.initialState;
  const halfRatio = model.gravityMetersPerSecondSquared / (2 * model.lengthMeters);
  near(pendulumAngularAcceleration(model, angleRadians), halfRatio);
  near(pendulumAngularAcceleration(model, -angleRadians), -halfRatio);
  near(pendulumAngularAcceleration(model, 0), 0);
  assert.deepEqual(pendulumBobPosition(model, 0), [0, -0.5, 0]);
  const left = pendulumBobPosition(model, angleRadians), right = pendulumBobPosition(model, -angleRadians);
  near(left[0], -0.25);
  near(left[1], -Math.sqrt(3) / 4);
  near(Math.hypot(...left), model.lengthMeters);
  assert.deepEqual(right, [-left[0], left[1], 0]);
});

test("specific energy matches both bottom-crossing directions and is zero at rest locally at the bottom", () => {
  const model = parsePendulumModel(input());
  const { specificEnergySquareMetersPerSecondSquared: expected, checkpoints } = reference.cases[0];
  near(pendulumSpecificEnergy(model, model.initialState), expected);
  for (const state of [checkpoints[1], checkpoints[3]]) near(pendulumSpecificEnergy(model, state), expected);
  assert.equal(pendulumSpecificEnergy(model, { angleRadians: 0, angularVelocityRadiansPerSecond: 0 }), 0);
  assert.ok(pendulumSpecificEnergy(model, { angleRadians: 1e-10, angularVelocityRadiansPerSecond: 0 }) > 0);
});
