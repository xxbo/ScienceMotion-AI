import { PENDULUM_REPLAY_MODEL } from "../../src/contracts/pendulum-replay";
import { createEmptyProject } from "../../src/platform/empty-project";

export const replayProjectId = "pendulum-shared-replay", replaySceneId = "pendulum";
export const replayAssetId = "pendulum-long-trajectory";
export const replaySnapshotId = "pendulum-replay-v1";
export const replayProfile = { width: 640, height: 360, fps: 25 };
export const replayRange = { startFrame: 7, durationFrames: 89 };

export function createPendulumReplayProject(contentHash: string) {
  const project = createEmptyProject({ id: replayProjectId, name: "Shared nonlinear pendulum replay", episodeId: "pendulum-physics",
    ...replayProfile, durationFrames: 100, createdAt: "2026-11-27T00:00:00.000Z" });
  project.project.units = "metric";
  project.project.coordinateSystem = "right-handed-y-up";
  project.assets = [{ id: replayAssetId, kind: "data", uri: `artifact://sha256/${contentHash}`, contentHash }];
  project.nodes = [{ id: "simulation", name: "Pendulum", type: "simulation",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ kind: "simulation", data: { model: PENDULUM_REPLAY_MODEL, assetId: replayAssetId } }] }];
  project.scenes = [{ id: replaySceneId, name: "Retained SI motion", durationFrames: 100, rootNodeIds: ["simulation"] }];
  project.shots = [{ id: "pendulum-replay", name: "Replay", sceneId: replaySceneId, startFrame: 0, durationFrames: 100 }];
  project.sequences[0].shotIds = ["pendulum-replay"];
  return project;
}
