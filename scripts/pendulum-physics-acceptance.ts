import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import reference from "../examples/pendulum-physics-reference.json";
import type { PendulumModel } from "../src/contracts/pendulum-model";
import { parsePendulumModel, pendulumAngularAcceleration, pendulumBobPosition, pendulumSpecificEnergy, PendulumModelError } from "../src/platform/pendulum-model";

const fixturePath = "examples/pendulum-physics-reference.json";
const schemaPath = "schemas/pendulum-model.schema.json";
const output = resolve("out/pendulum-physics-contract");
await mkdir(output, { recursive: true });
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", trajectorySamples: 0, renderedFrames: 0 };
const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= 2e-12, `${label}: ${actual} differs from ${expected}`);

// The pinned targets were calculated by the series for the complete elliptic integral.
// Verify them by the independent arithmetic-geometric mean identity, without integrating a trajectory.
function analyticPeriod(model: PendulumModel) {
  const omegaSquared = model.gravityMetersPerSecondSquared / model.lengthMeters;
  const theta0 = model.initialState.angleRadians;
  assert.notEqual(theta0, 0, "The stationary equilibrium has no observed period");
  let a = 1, b = Math.cos(theta0 / 2);
  for (let iteration = 0; iteration < 20; iteration++) {
    if (Math.abs(a - b) <= Number.EPSILON * a) return (2 * Math.PI / Math.sqrt(omegaSquared)) / a;
    [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  }
  assert.fail("Complete elliptic integral did not converge for the reference input");
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const [bytes, schema] = await Promise.all([readFile(fixturePath), readFile(schemaPath)]);
  await Promise.all([writeFile(join(output, "reference.json"), bytes), writeFile(join(output, "pendulum-model.schema.json"), schema)]);
  assert.equal(reference.schemaVersion, "1.0.0");
  assert.equal(reference.id, "pendulum-physics-reference-v1");
  assert.deepEqual(reference.cases.map(c => c.id), ["short", "long"]);
  assert.deepEqual(reference.solverAcceptance, { periodAbsoluteErrorSeconds: 0.001, checkpointAngleAbsoluteErrorRadians: 0.0001,
    checkpointAngularVelocityAbsoluteErrorRadiansPerSecond: 0.0001, maxRelativeSpecificEnergyDrift: 0.00001 });
  evidence.reference = { id: reference.id, path: fixturePath, sha256: createHash("sha256").update(bytes).digest("hex") };
  evidence.periodMethod = "complete-elliptic-integral-via-arithmetic-geometric-mean";

  const phases = ["release-left", "lowest-rightward", "opposite-extreme", "lowest-leftward", "return-left"];
  const cases = reference.cases.map(({ id, model: input, periodSeconds, specificEnergySquareMetersPerSecondSquared, checkpoints }, caseIndex) => {
    const model = parsePendulumModel(input);
    const { lengthMeters: length, gravityMetersPerSecondSquared: gravity, initialState } = model;
    assert.equal(length, [0.5, 2][caseIndex]);
    assert.equal(gravity, 9.80665);
    near(initialState.angleRadians, -Math.PI / 6, `${id} release angle`);
    const period = analyticPeriod(model);
    near(period, periodSeconds, `${id} period`);
    const smallAnglePeriod = 2 * Math.PI * Math.sqrt(length / gravity);
    assert.ok(period / smallAnglePeriod > 1.017 && period / smallAnglePeriod < 1.018, "The finite-amplitude period must differ from the small-angle approximation");
    const energy = gravity * length * (1 - Math.cos(initialState.angleRadians));
    near(energy, specificEnergySquareMetersPerSecondSquared, `${id} specific energy`);
    const crossingSpeed = Math.sqrt(2 * energy) / length;
    const angles = [initialState.angleRadians, 0, -initialState.angleRadians, 0, initialState.angleRadians];
    const speeds = [0, crossingSpeed, 0, -crossingSpeed, 0];
    assert.deepEqual(checkpoints.map(c => c.phase), phases);
    const verified = checkpoints.map((checkpoint, i) => {
      const { phase, timeSeconds, angleRadians, angularVelocityRadiansPerSecond, bobPositionMeters } = checkpoint;
      near(timeSeconds, period * i / 4, `${id} ${phase} time`);
      near(angleRadians, angles[i], `${id} ${phase} angle`);
      near(angularVelocityRadiansPerSecond, speeds[i], `${id} ${phase} angular velocity`);
      const acceleration = pendulumAngularAcceleration(model, angleRadians);
      near(acceleration, [1, 0, -1, 0, 1][i] * gravity / (2 * length), `${id} ${phase} angular acceleration`);
      const energyAtCheckpoint = pendulumSpecificEnergy(model, checkpoint);
      near(energyAtCheckpoint, energy, `${id} ${phase} energy`);
      const position = pendulumBobPosition(model, angleRadians);
      assert.equal(bobPositionMeters.length, 3);
      position.forEach((coordinate, axis) => near(coordinate, bobPositionMeters[axis], `${id} ${phase} coordinate ${axis}`));
      near(Math.hypot(...position), length, `${id} ${phase} rod length`);
      return { ...checkpoint, angularAccelerationRadiansPerSecondSquared: acceleration,
        specificEnergySquareMetersPerSecondSquared: energyAtCheckpoint };
    });
    return { id, model, periodSeconds: period, smallAnglePeriodSeconds: smallAnglePeriod, checkpoints: verified };
  });
  const periodRatio = cases[1].periodSeconds / cases[0].periodSeconds;
  near(periodRatio, 2, "period ratio for four times the length");
  evidence.cases = cases;
  evidence.periodRatio = periodRatio;
  evidence.solverAcceptance = reference.solverAcceptance;

  const base = reference.cases[0].model;
  const invalid: Array<{ reason: string; input: unknown; path: string }> = [
    { reason: "non-si-units", input: { ...base, units: "imperial" }, path: "/units" },
    { reason: "canvas-coordinate-system", input: { ...base, coordinateSystem: "screen-y-down" }, path: "/coordinateSystem" },
    { reason: "zero-length", input: { ...base, lengthMeters: 0 }, path: "/lengthMeters" },
    { reason: "invalid-gravity", input: { ...base, gravityMetersPerSecondSquared: -9.80665 }, path: "/gravityMetersPerSecondSquared" },
    { reason: "degrees-as-radians", input: { ...base, initialState: { ...base.initialState, angleRadians: -30 } }, path: "/initialState/angleRadians" },
    { reason: "initial-push", input: { ...base, initialState: { ...base.initialState, angularVelocityRadiansPerSecond: 1 } }, path: "/initialState/angularVelocityRadiansPerSecond" },
    { reason: "renderer-clock-in-physics-input", input: { ...base, fps: 24 }, path: "/fps" },
  ];
  const diagnostics: Array<{ reason: string; code: string; path: string; message: string }> = [];
  for (const candidate of invalid) assert.throws(() => parsePendulumModel(candidate.input), error => {
    assert.ok(error instanceof PendulumModelError);
    assert.equal(error.code, "PENDULUM_MODEL_INVALID");
    assert.equal(error.path, candidate.path);
    diagnostics.push({ reason: candidate.reason, code: error.code, path: error.path, message: error.message });
    return true;
  });
  evidence.rejections = diagnostics;
  evidence.status = "passed";
  console.log(`Verified 10 analytic SI pendulum checkpoints and ${diagnostics.length} input rejections. Periods: ${cases.map(c => c.periodSeconds.toFixed(6)).join(" s and ")} s. No trajectory was integrated.`);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally { await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n"); }
