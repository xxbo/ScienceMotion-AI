import { createHash } from "node:crypto";
import type { ArtifactStore } from "../contracts/artifact";
import { PENDULUM_REPLAY_MODEL, type PendulumReplay } from "../contracts/pendulum-replay";
import type { ProjectDocument } from "../contracts/project";
import { ProjectGraphRendererError, type ProjectGraphPreviewRequest, type ProjectGraphRenderRequest, type ProjectGraphVideoRequest } from "../contracts/renderer";
import { decodePendulumTrajectory, MAX_PENDULUM_TRAJECTORY_BYTES, readPendulumTrajectory } from "./pendulum-trajectory-artifact";
import { samplePendulumTrajectory } from "./pendulum-trajectory";
import { hashProject } from "./project-snapshots";

type Request = ProjectGraphPreviewRequest | ProjectGraphVideoRequest;
const fail = (code: string, message: string): never => { throw new ProjectGraphRendererError("PENDULUM_REPLAY_" + code, message); };
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const uniform = (values: number[], n: number) => values.length === 3 && values.every(value => value === n);
const matched = (project: ProjectDocument) => project.nodes.filter(node =>
  node.components.some(c => c.kind === "simulation" && c.data.model === PENDULUM_REPLAY_MODEL));

export const hasPendulumReplay = (project: ProjectDocument) => matched(project).length !== 0;

export function assertNoPendulumReplay(request: ProjectGraphRenderRequest) {
  if (hasPendulumReplay(request.project) || request.pendulumTrajectory !== undefined)
    fail("UNSUPPORTED_RENDERER", "Select a trajectory replay renderer for this snapshot.");
}

function binding(request: ProjectGraphRenderRequest) {
  const { project, revisionId, snapshotHash } = request;
  request.signal?.throwIfAborted();
  if (project.revisions.at(-1)?.id !== revisionId || hashProject(project) !== snapshotHash)
    fail("SNAPSHOT", "Use the exact retained snapshot revision and hash for trajectory replay.");
  const [node] = matched(project), [seq] = project.sequences, [scene] = project.scenes, [shot] = project.shots ?? [];
  if (project.schemaVersion !== "1.1.0" || project.project.units !== "metric" ||
      project.project.coordinateSystem !== "right-handed-y-up" || project.project.colorSpace !== "srgb")
    fail("GRAPH", "Use a metric, right-handed Y-up, sRGB ProjectDocument 1.1.0.");
  if (project.sequences.length !== 1 || project.scenes.length !== 1 || project.shots?.length !== 1 ||
      !node || project.nodes.length !== 1 || node.type !== "simulation" || scene.rootNodeIds.length !== 1 || scene.rootNodeIds[0] !== node.id)
    fail("GRAPH", "Use one sequence, one scene, one shot and one root pendulum simulation node.");
  if (seq.shotIds.length !== 1 || seq.shotIds[0] !== shot.id || shot.sceneId !== scene.id || shot.startFrame !== 0 ||
      (shot.inFrame ?? 0) !== 0 || !positiveInteger(seq.durationFrames) || seq.durationFrames !== shot.durationFrames || seq.durationFrames !== scene.durationFrames)
    fail("GRAPH", "Use a single full-length, untrimmed shot starting at sequence frame zero.");
  if (node.parentId !== undefined || node.childIds?.length || node.prefabId !== undefined ||
      !uniform(node.transform.position, 0) || !uniform(node.transform.rotation, 0) || !uniform(node.transform.scale, 1) ||
      (node.transform.pivot && !uniform(node.transform.pivot, 0)) ||
      seq.captions?.length || seq.transitions?.length || seq.trackIds?.length || shot.transitionIn !== undefined || shot.transitionOut !== undefined ||
      project.tracks?.length || project.clips?.length || project.prefabs.length ||
      project.animationTracks.some(track => track.enabled !== false) || project.constraints.some(item => item.enabled) ||
      Object.keys(request.imageAssets ?? {}).length || ("audioAssets" in request && Object.keys(request.audioAssets ?? {}).length))
    fail("GRAPH", "Trajectory replay does not compose node transforms, keyframes, constraints, timeline effects or media.");
  const [component] = node.components;
  const data = component.data;
  if (node.components.length !== 1 || component.engine !== undefined ||
      Object.keys(data).length !== 2 || !Object.hasOwn(data, "model") || !Object.hasOwn(data, "assetId") || typeof data.assetId !== "string" || !data.assetId.trim())
    fail("GRAPH", "Bind one simulation component with only model and assetId.");
  const [asset] = project.assets;
  if (project.assets.length !== 1 || asset.id !== data.assetId || asset.kind !== "data" ||
      !/^[a-f0-9]{64}$/.test(asset.contentHash ?? "") || asset.uri !== `artifact://sha256/${asset.contentHash}`)
    fail("ARTIFACT", "Bind the single retained, content-addressed JSON data asset by project asset ID.");
  const { width, height, fps } = seq;
  if (![width, height, fps].every(positiveInteger) || width > 7680 || height > 7680 || fps !== project.project.timebase.fps)
    fail("PROFILE", "Use native integer dimensions up to 7680 pixels and the project's frame rate.");
  if ((request.sceneId !== undefined && request.sceneId !== scene.id) ||
      (request.profile && (request.profile.width !== width || request.profile.height !== height || (request.profile.fps !== undefined && request.profile.fps !== fps))))
    fail("PROFILE", "Use the replay's single retained scene and native profile.");
  return { artifactId: `sha256:${asset.contentHash}`, profile: { width, height, fps }, sceneDuration: scene.durationFrames };
}

/** Resolve only the verified local input declared by the immutable snapshot. */
export async function loadPendulumReplayTrajectory(request: ProjectGraphRenderRequest, store: Pick<ArtifactStore, "get" | "read">) {
  const { artifactId } = binding(request);
  try {
    const { bytes } = await readPendulumTrajectory(store, artifactId);
    request.signal?.throwIfAborted();
    return Buffer.from(bytes).toString("base64");
  } catch {
    request.signal?.throwIfAborted();
    return fail("ARTIFACT", "The retained pendulum trajectory is missing, corrupt or incompatible.");
  }
}

/** Shared clock and sample pass. The browser sees output indices, not a second integration or frame mapping. */
export function preparePendulumReplay(request: Request): PendulumReplay {
  const { artifactId, profile, sceneDuration } = binding(request);
  const preview = "frame" in request;
  const startFrame = preview ? request.frame : request.startFrame;
  const durationFrames = preview ? 1 : request.durationFrames;
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !positiveInteger(durationFrames) ||
      durationFrames > 900 || durationFrames > sceneDuration - startFrame)
    fail("RANGE", "Choose up to 900 frames inside the retained replay shot.");
  if (!preview && (profile.width % 2 || profile.height % 2))
    fail("PROFILE", "H.264 replay requires even dimensions.");
  const encoded = request.pendulumTrajectory;
  if (typeof encoded !== "string" || encoded.length > 4 * Math.ceil(MAX_PENDULUM_TRAJECTORY_BYTES / 3))
    return fail("ARTIFACT", "Supply the bounded pendulum trajectory bytes retained by this snapshot.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== artifactId)
    fail("ARTIFACT", "The replay input differs from the retained trajectory hash.");
  let trajectory;
  try { trajectory = decodePendulumTrajectory(bytes); }
  catch { return fail("ARTIFACT", "The retained trajectory does not satisfy the pendulum trajectory contract."); }
  if ((sceneDuration - 1) / profile.fps > trajectory.samples.at(-1)!.timeSeconds)
    fail("RANGE", "The replay's last source frame is outside its physical trajectory.");
  const poses = Array.from({ length: durationFrames }, (_, index) => {
    request.signal?.throwIfAborted();
    const sceneFrame = startFrame + index;
    const timeSeconds = sceneFrame / profile.fps;
    const { angleRadians, bobPositionMeters } = samplePendulumTrajectory(trajectory, timeSeconds);
    return { sceneFrame, timeSeconds, angleRadians, bobPositionMeters };
  });
  return { artifactId, profile, range: { startFrame, durationFrames }, lengthMeters: trajectory.model.lengthMeters, poses };
}
