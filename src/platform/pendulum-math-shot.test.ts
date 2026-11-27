import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import reference from "../../examples/pendulum-physics-reference.json";
import { createPendulumReplayProject, replayProfile, replayRange } from "../../scripts/fixtures/pendulum-replay-project";
import { preparePendulumMathShot } from "./pendulum-math-shot";
import { preparePendulumReplay } from "./pendulum-replay";
import { solvePendulumTrajectory } from "./pendulum-trajectory";
import { encodePendulumTrajectory } from "./pendulum-trajectory-artifact";
import { hashProject } from "./project-snapshots";

const demand = reference.cases[1], options = { timeStepSeconds: 1 / 240, stepCount: 960 };
const trajectory = solvePendulumTrajectory(demand.model, options);
function request(source = trajectory) {
  const bytes = Buffer.from(encodePendulumTrajectory(source));
  const project = createPendulumReplayProject(createHash("sha256").update(bytes).digest("hex"));
  return { project, pendulumTrajectory: bytes.toString("base64"), revisionId: project.revisions[0].id,
    snapshotHash: hashProject(project), ...replayRange };
}

test("Manim and C use the exact same retained scene clock and poses, including a one-frame trim", () => {
  const input = request(), math = preparePendulumMathShot(input), replay = preparePendulumReplay(input);
  assert.deepEqual(math.source, { artifactId: replay.artifactId, snapshotHash: input.snapshotHash, revisionId: input.revisionId });
  assert.deepEqual([math.profile, math.range], [replayProfile, replayRange]);
  assert.deepEqual(math.frames, replay.poses.map(({ sceneFrame, timeSeconds, angleRadians }) => ({ sceneFrame, timeSeconds, angleRadians })));
  assert.deepEqual([math.frames[0].timeSeconds, math.frames.at(-1)!.timeSeconds], [0.28, 3.8]);
  assert.deepEqual(preparePendulumMathShot({ ...input, startFrame: 51, durationFrames: 1 }).frames, [math.frames[44]]);
  assert.deepEqual(math.curve, trajectory.samples.map(({ timeSeconds, angleRadians }) => ({ timeSeconds, angleRadians })));
});

test("Manim labels a measured cycle from rightward bottom crossings and preserves continuous-phase reference times", () => {
  const { phases, period, model } = preparePendulumMathShot(request());
  assert.deepEqual(model, demand.model);
  assert.deepEqual(phases.map(p => p.phase), demand.checkpoints.map(p => p.phase));
  for (const [i, phase] of phases.entries()) {
    assert.ok(Math.abs(phase.timeSeconds - demand.checkpoints[i].timeSeconds) < 0.001);
    assert.ok(Math.abs(phase.angleRadians - demand.checkpoints[i].angleRadians) < 0.0001);
  }
  assert.equal(period.periodIntervalSeconds[0], phases[1].timeSeconds);
  assert.equal(period.measuredSeconds, period.periodIntervalSeconds[1] - period.periodIntervalSeconds[0]);
  assert.ok(Math.abs(period.measuredSeconds - demand.periodSeconds) < 0.001);
  assert.ok(period.smallAngleSeconds < period.measuredSeconds);
  assert.notEqual(phases[1].timeSeconds * replayProfile.fps % 1, 0);
});

test("Manim rejects mismatched retained data and out-of-range editorial requests before launching Python", () => {
  const input = request();
  assert.throws(() => preparePendulumMathShot({ ...input, snapshotHash: "0".repeat(64) }), { code: "PENDULUM_REPLAY_SNAPSHOT" });
  assert.throws(() => preparePendulumMathShot({ ...input, pendulumTrajectory: Buffer.from("{}").toString("base64") }),
    { code: "PENDULUM_REPLAY_ARTIFACT" });
  assert.throws(() => preparePendulumMathShot({ ...input, startFrame: 99, durationFrames: 2 }), { code: "PENDULUM_REPLAY_RANGE" });
  input.project.sequences[0].width = 960;
  assert.throws(() => preparePendulumMathShot({ ...input, snapshotHash: hashProject(input.project) }), { code: "PENDULUM_MATH_PROFILE" });
});

test("Manim cannot label a period for a retained equilibrium with no crossings", () => {
  const equilibrium = solvePendulumTrajectory({
    ...demand.model, initialState: { angleRadians: 0, angularVelocityRadiansPerSecond: 0 },
  }, options);
  assert.throws(() => preparePendulumMathShot(request(equilibrium)), { code: "PENDULUM_MATH_CYCLE" });
});
