import assert from "node:assert/strict";
import test from "node:test";
import reference from "../../examples/pendulum-physics-reference.json";
import { comparePendulumEvents, detectPendulumEvents, retainedPendulumEvents } from "./pendulum-event-alignment";
import { samplePendulumTrajectory, solvePendulumTrajectory } from "./pendulum-trajectory";

const frameSeconds = 1 / 25, duration = 89, start = 7, release = reference.cases[1];
const trajectory = solvePendulumTrajectory(release.model, { timeStepSeconds: 1 / 240, stepCount: 960 });
const kinds = ["bottom-rightward", "turn-right", "bottom-leftward", "turn-left", "bottom-rightward"];
const rows = Array.from({ length: duration }, (_, i) => {
  const timeSeconds = (start + i) / 25;
  const theta = samplePendulumTrajectory(trajectory, timeSeconds).angleRadians;
  return { timeSeconds, angleRadians: Math.round(theta / 0.008) * 0.008 };
});
const events = detectPendulumEvents(rows, frameSeconds);
const retained = retainedPendulumEvents(trajectory.samples);

test("retained events distinguish directed bottom crossings from turns and exclude the release endpoint", () => {
  assert.deepEqual(retained.map(row => row.kind), kinds);
  retained.forEach((row, i) => assert.ok(Math.abs(row.timeSeconds - (i + 1) * release.periodSeconds / 4) < 0.001));
  assert.ok(retained.every(row => row.timeSeconds >= rows[0].timeSeconds && row.timeSeconds <= rows.at(-1)!.timeSeconds));
});

test("visual event detection handles exact zeros and quantized extrema without reference times", () => {
  assert.deepEqual(events.map(row => row.kind), kinds);
  assert.deepEqual(events.map(row => row.method),
    ["linear-crossing", "quadratic-turn", "linear-crossing", "quadratic-turn", "linear-crossing"]);
  assert.deepEqual(events.map(row => row.support[1] - row.support[0]), [1, 10, 1, 10, 1]);
  events.forEach((row, i) => assert.ok(Math.abs(row.timeSeconds - retained[i].timeSeconds) < 0.02));
  assert.deepEqual(events.map(row => Math.round(row.timeSeconds * 25)), [18, 36, 54, 72, 90]);
});

test("matching requires count, order, direction and a uniform decoded clock", () => {
  assert.throws(() => comparePendulumEvents(retained, { a: events, b: events.slice(1) }, frameSeconds), /event count/);
  const changed = events.map((row, i) => i === 1 ? { ...row, kind: "turn-left" as const } : row);
  assert.throws(() => comparePendulumEvents(retained, { a: events, b: changed }, frameSeconds), /direction/);
  const invalid = rows.map((row, i) => i === 8 ? { ...row, timeSeconds: row.timeSeconds + 0.001 } : row);
  assert.throws(() => detectPendulumEvents(invalid, frameSeconds), /uniform/);
  assert.throws(() => detectPendulumEvents([-1, 1, 0.8, -1].map((angleRadians, i) =>
    ({ angleRadians, timeSeconds: i / 25 })), frameSeconds), /11-frame neighborhood/);
});

test("the alignment gate rejects a clip with a timing slip but the same event sequence", () => {
  const shifted = rows.map((row, i) => ({ ...row, angleRadians: rows[Math.min(i + 3, rows.length - 1)].angleRadians }));
  const wrong = detectPendulumEvents(shifted, frameSeconds);
  assert.deepEqual(wrong.map(row => row.kind), kinds);
  const close = comparePendulumEvents(retained, { a: events, b: events }, frameSeconds);
  assert.ok(close.every(row => row.spreadSeconds === 0 && row.maxReferenceErrorSeconds < 0.02));
  assert.throws(() => comparePendulumEvents(retained, { a: events, b: wrong }, frameSeconds), /timing tolerance/);
});

test("agreement with the reference alone is insufficient if the visual streams disagree by more than a frame", () => {
  const adjusted = (offset: number) => events.map((e, i) => ({ ...e, timeSeconds: retained[i].timeSeconds + offset }));
  assert.throws(() => comparePendulumEvents(retained, { early: adjusted(-0.03), late: adjusted(0.03) }, frameSeconds), /timing tolerance/);
});
