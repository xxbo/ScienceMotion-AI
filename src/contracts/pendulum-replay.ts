import type { Vector3 } from "./project";

/** Renderer-neutral binding inside a Project Graph simulation component. */
export const PENDULUM_REPLAY_MODEL = "pendulum-trajectory-v1";
export interface PendulumReplayPose {
  sceneFrame: number;
  timeSeconds: number;
  angleRadians: number;
  bobPositionMeters: Vector3;
}

/** Server-verified poses that both browser compositions consume in output order. */
export interface PendulumReplay {
  profile: { width: number; height: number; fps: number };
  range: { startFrame: number; durationFrames: number };
  artifactId: string;
  lengthMeters: number;
  poses: PendulumReplayPose[];
}
