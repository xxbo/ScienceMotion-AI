import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import reference from "../examples/pendulum-physics-reference.json";
import { PENDULUM_SOLVER, type PendulumTrajectory } from "../src/contracts/pendulum-trajectory";
import type { ProjectAsset } from "../src/contracts/project";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../src/platform/artifact-store";
import { createEmptyProject } from "../src/platform/empty-project";
import { FileSystemProjectWorkspace } from "../src/platform/filesystem-project-workspace";
import { encodePendulumTrajectory, readPendulumTrajectory, retainPendulumTrajectory } from "../src/platform/pendulum-trajectory-artifact";
import { samplePendulumTrajectory, solvePendulumTrajectory } from "../src/platform/pendulum-trajectory";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";

const output = resolve("out/pendulum-trajectory");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sciencemotion-pendulum-trajectory-"));
const fixturePath = "examples/pendulum-physics-reference.json";
const projectId = "pendulum-physics-trajectories", snapshotId = "pendulum-trajectories-v1";
const createdAt = "2026-11-27T00:00:00.000Z";
const solveOptions = { timeStepSeconds: 1 / 240, stepCount: 960 };
const tolerances = reference.solverAcceptance;
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", solver: PENDULUM_SOLVER, solveOptions, tolerances, renderedFrames: 0 };
const json = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const artifactDirectory = join(directory, "artifacts"), referenceDirectory = join(directory, "references");
const openWorkspace = (artifacts: FileSystemArtifactStore, references: FileSystemArtifactReferenceStore) =>
  FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));

function measure(demand: typeof reference.cases[number], trajectory: PendulumTrajectory) {
  assert.deepEqual(trajectory.model, demand.model);
  assert.deepEqual(trajectory.solver, PENDULUM_SOLVER);
  assert.deepEqual([trajectory.timeStepSeconds, trajectory.stepCount], [solveOptions.timeStepSeconds, solveOptions.stepCount]);
  const { samples, timeStepSeconds } = trajectory, { lengthMeters: L, gravityMetersPerSecondSquared: g } = trajectory.model;
  assert.equal(samples.length, 961);
  assert.deepEqual([samples[0].timeSeconds, samples.at(-1)!.timeSeconds], [0, 4]);
  assert.equal(samples[0].angleRadians, demand.model.initialState.angleRadians);
  assert.equal(samples[0].angularVelocityRadiansPerSecond, 0);
  const initialEnergy = demand.specificEnergySquareMetersPerSecondSquared;
  const bottomCrossings: Array<{ direction: "rightward" | "leftward"; timeSeconds: number; sampleIndices: [number, number] }> = [];
  let maxRelativeSpecificEnergyDrift = 0, maxRodLengthErrorMeters = 0;
  for (const [i, sample] of samples.entries()) {
    assert.equal(sample.timeSeconds, i * timeStepSeconds);
    const { angleRadians: theta, angularVelocityRadiansPerSecond: omega, bobPositionMeters: [x, y, z] } = sample;
    assert.equal(z, 0);
    assert.ok(Math.abs(x - L * Math.sin(theta)) < 1e-12 && Math.abs(y + L * Math.cos(theta)) < 1e-12);
    maxRodLengthErrorMeters = Math.max(maxRodLengthErrorMeters, Math.abs(Math.hypot(x, y, z) - L));
    const energy = (L * omega) ** 2 / 2 + g * L * (1 - Math.cos(theta));
    assert.ok(Math.abs(energy - sample.specificEnergySquareMetersPerSecondSquared) < 1e-12);
    maxRelativeSpecificEnergyDrift = Math.max(maxRelativeSpecificEnergyDrift, Math.abs(energy - initialEnergy) / initialEnergy);
    if (!i) continue;
    const prior = samples[i - 1];
    const direction = prior.angleRadians < 0 && theta >= 0 ? "rightward" : prior.angleRadians > 0 && theta <= 0 ? "leftward" : undefined;
    if (!direction) continue;
    const sign = direction === "rightward" ? 1 : -1;
    assert.ok(omega * sign > 0 && prior.angularVelocityRadiansPerSecond * sign > 0);
    // Infer event time from adjacent uniform samples. No analytic period enters the measurement.
    const fraction = -prior.angleRadians / (theta - prior.angleRadians);
    bottomCrossings.push({ direction, timeSeconds: prior.timeSeconds + fraction * (sample.timeSeconds - prior.timeSeconds), sampleIndices: [i - 1, i] });
  }
  assert.ok(maxRodLengthErrorMeters < 1e-12);
  assert.ok(maxRelativeSpecificEnergyDrift <= tolerances.maxRelativeSpecificEnergyDrift, `${demand.id} energy drift`);
  assert.ok(bottomCrossings.every((crossing, i) => crossing.direction === (i % 2 === 0 ? "rightward" : "leftward")));
  const rightwardTimes = bottomCrossings.filter(event => event.direction === "rightward").map(event => event.timeSeconds);
  assert.equal(rightwardTimes.length, demand.id === "short" ? 3 : 2);
  assert.ok(Math.abs(rightwardTimes[0] - demand.checkpoints[1].timeSeconds) <= tolerances.periodAbsoluteErrorSeconds);
  const periods = rightwardTimes.slice(1).map((time, i) => {
    const measuredSeconds = time - rightwardTimes[i], absoluteErrorSeconds = Math.abs(measuredSeconds - demand.periodSeconds);
    assert.ok(absoluteErrorSeconds <= tolerances.periodAbsoluteErrorSeconds, `${demand.id} period error ${absoluteErrorSeconds}`);
    return { measuredSeconds, absoluteErrorSeconds };
  });
  const checkpoints = demand.checkpoints.map(expected => {
    const sample = samplePendulumTrajectory(trajectory, expected.timeSeconds);
    const angleErrorRadians = Math.abs(sample.angleRadians - expected.angleRadians);
    const angularVelocityErrorRadiansPerSecond = Math.abs(sample.angularVelocityRadiansPerSecond - expected.angularVelocityRadiansPerSecond);
    const bobPositionErrorMeters = Math.hypot(...sample.bobPositionMeters.map((v, i) => v - expected.bobPositionMeters[i]));
    assert.equal(sample.timeSeconds, expected.timeSeconds);
    assert.ok(angleErrorRadians <= tolerances.checkpointAngleAbsoluteErrorRadians, `${demand.id} ${expected.phase} angle`);
    assert.ok(angularVelocityErrorRadiansPerSecond <= tolerances.checkpointAngularVelocityAbsoluteErrorRadiansPerSecond, `${demand.id} ${expected.phase} angular velocity`);
    assert.ok(bobPositionErrorMeters <= L * tolerances.checkpointAngleAbsoluteErrorRadians + 1e-12);
    return { phase: expected.phase, sample, angleErrorRadians, angularVelocityErrorRadiansPerSecond, bobPositionErrorMeters };
  });
  return { sampleCount: samples.length, durationSeconds: samples.at(-1)!.timeSeconds, analyticPeriodSeconds: demand.periodSeconds,
    bottomCrossings, periods, checkpoints, maxRodLengthErrorMeters, maxRelativeSpecificEnergyDrift };
}

try {
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.node = process.version;
  evidence.reference = { id: reference.id, path: fixturePath, sha256: createHash("sha256").update(await readFile(fixturePath)).digest("hex") };
  assert.equal(reference.id, "pendulum-physics-reference-v1");
  assert.deepEqual(reference.cases.map(c => c.id), ["short", "long"]);
  const published = new FileSystemArtifactStore(artifactDirectory);
  const datasets = await Promise.all(reference.cases.map(async demand => {
    const solved = solvePendulumTrajectory(demand.model, solveOptions);
    const record = await retainPendulumTrajectory(published, solved, { projectId });
    return { demand, record, assetId: `pendulum-${demand.id}-trajectory` };
  }));
  assert.notEqual(datasets[0].record.id, datasets[1].record.id);
  const orphan = await published.put({ bytes: new TextEncoder().encode("unreferenced retention control"), kind: "data", mediaType: "text/plain" });
  const project = createEmptyProject({ id: projectId, name: "Pendulum trajectories", episodeId: "pendulum-physics", createdAt });
  project.project.units = "metric";
  project.project.coordinateSystem = "right-handed-y-up";
  project.assets = datasets.map(({ record, assetId }) => ({ id: assetId, kind: "data", uri: record.uri, contentHash: record.contentHash }));
  const writer = await openWorkspace(published, new FileSystemArtifactReferenceStore(referenceDirectory));
  let retained: ProjectSnapshot;
  try {
    await writer.create(project);
    const revisionId = project.revisions.at(-1)!.id;
    retained = await writer.saveSnapshot(projectId, revisionId, { id: snapshotId, createdAt });
    const detached = await writer.applyPatch(projectId, { schemaVersion: "1.3.0", projectId, baseRevisionId: revisionId,
      patches: datasets.map(({ assetId }) => ({ op: "remove-asset", assetId })) },
    { newRevisionId: "revision-detach", createdAt: "2026-11-27T00:00:01.000Z", message: "Leave the trajectory artifacts pinned only by the retained snapshot" });
    assert.deepEqual(detached.project.assets, []);
  } finally { await writer.close(); }

  const artifacts = new FileSystemArtifactStore(artifactDirectory), references = new FileSystemArtifactReferenceStore(referenceDirectory);
  const reopened = await openWorkspace(artifacts, references);
  try {
    const snapshot = await reopened.getSnapshot(snapshotId);
    assert.deepEqual(snapshot, retained);
    assert.ok(snapshot);
    assert.equal(snapshot.contentHash, hashProject(project));
    assert.deepEqual((await reopened.get(projectId))?.assets, []);
    const collection = await reopened.collectGarbage({ olderThanMs: 0, now: new Date(Date.now() + 1_000) });
    assert.deepEqual(collection, { scanned: 3, retained: 2, deleted: [orphan.id], errors: [] });
    const result = [];
    for (const { demand, record, assetId } of datasets) {
      const binding: ProjectAsset | undefined = snapshot.document.assets.find(asset => asset.id === assetId);
      assert.deepEqual(binding, { id: assetId, kind: "data", uri: record.uri, contentHash: record.contentHash });
      const refs = await references.list({ artifactId: record.id });
      assert.deepEqual(refs.map(ref => ref.ownerType), ["snapshot"]);
      assert.deepEqual(JSON.parse(refs[0].ownerId).slice(-2), [projectId, snapshotId]);
      const loaded = await readPendulumTrajectory(artifacts, record.id);
      assert.deepEqual(loaded.record, record);
      const repeated = solvePendulumTrajectory(loaded.trajectory.model, solveOptions);
      assert.deepEqual(encodePendulumTrajectory(repeated), loaded.bytes);
      const file = `${demand.id}-trajectory.json`;
      await writeFile(join(output, file), loaded.bytes);
      result.push({ id: demand.id, artifact: loaded.record, assetId, file, repeatedSolveMatchesBytes: true, ...measure(demand, loaded.trajectory) });
    }
    const periodRatio = result[1].periods[0].measuredSeconds / result[0].periods[0].measuredSeconds;
    const p = tolerances.periodAbsoluteErrorSeconds;
    assert.ok(Math.abs(periodRatio - 2) <= 3 * p / (reference.cases[0].periodSeconds - p));
    evidence.cases = result;
    evidence.periodRatio = periodRatio;
    evidence.retention = { snapshotId, snapshotHash: snapshot.contentHash, afterReopen: true, snapshotOnly: true, collection };
    await json("snapshot.json", snapshot);
    evidence.status = "passed";
    console.log(`Verified ${result.map(item => item.sampleCount).join(" + ")} retained samples, ten checkpoints and byte-identical replay. Measured periods ${result.map(item => item.periods[0].measuredSeconds.toFixed(7)).join(" s, ")} s.`);
  } finally { await reopened.close(); }
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await json("evidence.json", evidence); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
