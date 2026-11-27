import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import reference from "../../examples/pendulum-physics-reference.json";
import { createPendulumReplayProject, replayProfile, replayRange } from "../../scripts/fixtures/pendulum-replay-project";
import { RemotionProjectGraphRenderer, RemotionPendulumReplayRenderer } from "../renderers/remotion/remotion-project-graph-renderer";
import { ThreeJsProjectGraphRenderer, ThreeJsPendulumReplayRenderer } from "../renderers/three/three-project-graph-renderer";
import { InMemoryArtifactStore } from "./artifact-store";
import { encodePendulumTrajectory, retainPendulumTrajectory } from "./pendulum-trajectory-artifact";
import { samplePendulumTrajectory, solvePendulumTrajectory } from "./pendulum-trajectory";
import { hasPendulumReplay, loadPendulumReplayTrajectory, preparePendulumReplay } from "./pendulum-replay";
import { hashProject } from "./project-snapshots";

const trajectory = solvePendulumTrajectory(reference.cases[1].model, { timeStepSeconds: 1 / 240, stepCount: 960 });
const bytes = encodePendulumTrajectory(trajectory);
function request(payload: Uint8Array = bytes) {
  const project = createPendulumReplayProject(createHash("sha256").update(payload).digest("hex"));
  return { project, revisionId: project.revisions.at(-1)!.id, snapshotHash: hashProject(project),
    pendulumTrajectory: Buffer.from(payload).toString("base64") };
}
const code = (name: string) => ({ code: "PENDULUM_REPLAY_" + name });

test("a video trim and an isolated preview use the same physical timestamps at a non-native sample rate", () => {
  const source = request();
  const video = preparePendulumReplay({ ...source, ...replayRange });
  assert.deepEqual([video.profile, video.range, video.poses.length], [replayProfile, replayRange, 89]);
  assert.deepEqual(video.poses.map(p => p.sceneFrame), Array.from({ length: 89 }, (_, i) => i + 7));
  assert.deepEqual([video.poses[0].timeSeconds, video.poses.at(-1)!.timeSeconds], [7 / 25, 95 / 25]);
  assert.notEqual(video.poses[0].timeSeconds / trajectory.timeStepSeconds % 1, 0);
  for (const i of [0, 44, 88]) {
    const pose = video.poses[i], preview = preparePendulumReplay({ ...source, frame: pose.sceneFrame });
    const expected = samplePendulumTrajectory(trajectory, pose.sceneFrame / 25);
    assert.deepEqual(preview.poses, [pose]);
    assert.deepEqual(pose.bobPositionMeters, expected.bobPositionMeters);
    assert.equal(pose.angleRadians, expected.angleRadians);
  }
});

test("replay preflight requires the immutable revision and native scene profile", () => {
  const source = request();
  assert.throws(() => preparePendulumReplay({ ...source, revisionId: "some-other-head", frame: 7 }), code("SNAPSHOT"));
  assert.throws(() => preparePendulumReplay({ ...source, snapshotHash: "0".repeat(64), frame: 7 }), code("SNAPSHOT"));
  assert.throws(() => preparePendulumReplay({ ...source, sceneId: "missing", frame: 7 }), code("PROFILE"));
  assert.throws(() => preparePendulumReplay({ ...source, profile: { ...replayProfile, fps: 24 }, frame: 7 }), code("PROFILE"));
});

test("missing, modified and schema-incompatible data fail before replay", () => {
  const source = request();
  assert.throws(() => preparePendulumReplay({ ...source, pendulumTrajectory: undefined, frame: 7 }), code("ARTIFACT"));
  const changed = Buffer.from(bytes); changed[0] ^= 1;
  assert.throws(() => preparePendulumReplay({ ...source, pendulumTrajectory: changed.toString("base64"), frame: 7 }), code("ARTIFACT"));
  assert.throws(() => preparePendulumReplay({ ...request(Buffer.from("{}")), frame: 7 }), code("ARTIFACT"));
  source.project.nodes[0].components[0].data.assetId = "another-data-asset";
  assert.throws(() => preparePendulumReplay({ ...source, snapshotHash: hashProject(source.project), frame: 7 }), code("ARTIFACT"));
});

test("the bounded replay cannot extrapolate or silently accept authored trims and transforms", () => {
  const source = request();
  assert.throws(() => preparePendulumReplay({ ...source, frame: -1 }), code("RANGE"));
  assert.throws(() => preparePendulumReplay({ ...source, startFrame: 99, durationFrames: 2 }), code("RANGE"));
  const short = solvePendulumTrajectory(reference.cases[1].model, { timeStepSeconds: 1 / 240, stepCount: 80 });
  assert.throws(() => preparePendulumReplay({ ...request(encodePendulumTrajectory(short)), frame: 0 }), code("RANGE"));
  source.project.shots![0].inFrame = 2;
  assert.throws(() => preparePendulumReplay({ ...source, snapshotHash: hashProject(source.project), frame: 7 }), code("GRAPH"));
  source.project.shots![0].inFrame = 0;
  source.project.nodes[0].transform.rotation = [0, 2, 0];
  assert.throws(() => preparePendulumReplay({ ...source, snapshotHash: hashProject(source.project), frame: 7 }), code("GRAPH"));
});

test("the host resolver reads only the snapshot's verified trajectory record", async () => {
  const source = request();
  const artifacts = new InMemoryArtifactStore();
  await assert.rejects(() => loadPendulumReplayTrajectory(source, artifacts), code("ARTIFACT"));
  const record = await retainPendulumTrajectory(artifacts, trajectory);
  assert.equal(source.project.assets[0].uri, record.uri);
  assert.equal(await loadPendulumReplayTrajectory(source, artifacts), source.pendulumTrajectory);
});

test("existing renderer identities reject replay and opted-in renderers still verify the artifact before bundling", async () => {
  const source = { ...request(), frame: 7 };
  assert.ok(hasPendulumReplay(source.project));
  const standard = [new RemotionProjectGraphRenderer("/not-an-entry"), new ThreeJsProjectGraphRenderer({ entryPoint: "/not-an-entry" })];
  assert.deepEqual(standard.map(r => [r.id, r.version]), [["remotion.project-graph", "1.0.0"], ["three-js-project-graph", "1.1.0"]]);
  for (const renderer of standard) await assert.rejects(() => renderer.renderPreview(source), code("UNSUPPORTED_RENDERER"));
  const optedIn = [new RemotionPendulumReplayRenderer("/not-an-entry"), new ThreeJsPendulumReplayRenderer({ entryPoint: "/not-an-entry" })];
  for (const renderer of optedIn) {
    assert.equal(renderer.supportsPendulumReplay, true);
    await assert.rejects(() => renderer.renderPreview({ ...source, pendulumTrajectory: undefined }), code("ARTIFACT"));
  }
});
