import type { ComponentKind, SceneNode, Vector3 } from "../../contracts/project";
import { ProjectGraphRendererError, type ProjectGraphPreviewRequest, type ProjectGraphVideoRequest } from "../../contracts/renderer";
import { hashProject } from "../../platform/project-snapshots";

export type ThreeStaticRequest = ProjectGraphPreviewRequest | ProjectGraphVideoRequest;
export type ThreeStaticGeometry = { primitive: "box"; width: number; height: number; depth: number } | { primitive: "sphere"; radius: number };
export type ThreeStaticMaterial = { model: "lambert"; color: string };
export type ThreeStaticTransform = { position: Vector3; rotationRadians: Vector3; scale: Vector3 };
export type ThreeStaticCamera = { nodeId: string; projection: "perspective"; position: Vector3; rotationRadians: Vector3;
  fovYDegrees: number; near: number; far: number };
export type ThreeStaticLight = { nodeId: string; type: "ambient"; color: string; intensity: number } |
  { nodeId: string; type: "directional"; color: string; intensity: number; position: Vector3; target: Vector3 };

/** Normalized data for the future static renderer. World units are preserved without conversion. */
export interface ThreeStaticScene {
  sceneId: string;
  sequenceId: string;
  shotId: string;
  profile: { width: number; height: number; fps: number };
  range: { startFrame: number; durationFrames: number };
  backgroundColor: string;
  camera: ThreeStaticCamera;
  meshes: Array<{ nodeId: string; transform: ThreeStaticTransform; geometry: ThreeStaticGeometry; material: ThreeStaticMaterial }>;
  lights: ThreeStaticLight[];
}

type Location = { path: string; nodeId?: string; sceneId?: string; trackId?: string; constraintId?: string };
type Problem = "INVALID_SNAPSHOT" | "INVALID_REQUEST" | "UNSUPPORTED_PROJECT" | "UNSUPPORTED_TIMELINE" | "UNSUPPORTED_FEATURE" |
  "INVALID_ROOTS" | "UNSUPPORTED_NODE" | "INVALID_TRANSFORM" | "INVALID_COMPONENT" | "UNSUPPORTED_FIELD" |
  "INVALID_GEOMETRY" | "INVALID_MATERIAL" | "INVALID_CAMERA" | "INVALID_LIGHT" | "UNSUPPORTED_ANIMATION";
export type ThreeStaticDiagnostic = Location & { code: `THREE_STATIC_${Problem}`; message: string };

export class ThreeStaticSceneError extends ProjectGraphRendererError {
  constructor(readonly diagnostic: ThreeStaticDiagnostic) {
    const { code, path, message, nodeId } = diagnostic;
    super(code, `${nodeId === undefined ? "" : `Node ${nodeId}. `}${path}. ${message}`);
    this.name = "ThreeStaticSceneError";
  }
}

function fail(code: Problem, location: Location, message: string): never {
  throw new ThreeStaticSceneError({ ...location, code: `THREE_STATIC_${code}`, message });
}
const field = (loc: Location, key: string | number): Location => ({ ...loc, path: `${loc.path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}` });
const where = (path: string, sceneId?: string): Location => ({ path, ...(sceneId === undefined ? {} : { sceneId }) });
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(Math.fround(value)) && (value === 0 || Math.fround(value) !== 0);
const positive = (value: unknown): value is number => number(value) && value > 0;
const vector = (value: unknown): value is Vector3 => Array.isArray(value) && value.length === 3 && number(value[0]) && number(value[1]) && number(value[2]);
const uniform = (v: Vector3, n: number) => v.every(value => value === n);
const integer = (v: number) => Number.isSafeInteger(v) && v > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function only(data: Record<string, unknown>, keys: string[], loc: Location) {
  const unsupported = Object.keys(data).find(key => !keys.includes(key));
  if (unsupported !== undefined) fail("UNSUPPORTED_FIELD", field(loc, unsupported), `Use only ${keys.join(", ")} in this component.`);
}

function color(value: unknown, location: Location, type: "INVALID_MATERIAL" | "INVALID_LIGHT"): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail(type, location, "Use an opaque sRGB color in #RRGGBB form.");
  return value.toLowerCase();
}

function transform(node: SceneNode, loc: Location): ThreeStaticTransform {
  const at = field(loc, "transform");
  const { position, rotation, scale, pivot } = node.transform ?? {};
  if (!vector(position)) fail("INVALID_TRANSFORM", field(at, "position"), "Use a three-number position representable in finite float32 values.");
  if (!vector(rotation)) fail("INVALID_TRANSFORM", field(at, "rotation"), "Use three finite XYZ Euler angles in degrees.");
  if (!vector(scale) || !scale.every(positive) || (node.type !== "mesh" && !uniform(scale, 1)))
    fail("INVALID_TRANSFORM", field(at, "scale"), node.type === "mesh" ? "Use strictly positive finite XYZ scales." : "Use unit scale for cameras and lights.");
  if (pivot !== undefined && (!vector(pivot) || !uniform(pivot, 0)))
    fail("INVALID_TRANSFORM", field(at, "pivot"), "Omit the pivot or use [0, 0, 0] for this static subset.");
  if (node.type === "light" && !uniform(rotation, 0))
    fail("INVALID_TRANSFORM", field(at, "rotation"), "Use zero rotation. A directional light aims from position toward its explicit target.");
  return { position: [...position], rotationRadians: rotation.map(deg => deg * Math.PI / 180) as Vector3, scale: [...scale] };
}

function components(node: SceneNode, loc: Location, required: ComponentKind[]) {
  const byKind = new Map<ComponentKind, { data: Record<string, unknown>; at: Location }>();
  const collection = field(loc, "components");
  for (const [i, item] of node.components.entries()) {
    const at = field(collection, i);
    if (!required.includes(item.kind) || byKind.has(item.kind))
      fail("INVALID_COMPONENT", field(at, "kind"), `This node needs exactly one of each of these components: ${required.join(", ")}.`);
    if (item.engine !== undefined) fail("INVALID_COMPONENT", field(at, "engine"), "Use a renderer-neutral component without an engine tag.");
    if (!record(item.data)) fail("INVALID_COMPONENT", field(at, "data"), "Supply a component data object.");
    byKind.set(item.kind, { data: item.data, at: field(at, "data") });
  }
  if (byKind.size !== required.length) fail("INVALID_COMPONENT", collection, `Supply the required components: ${required.join(", ")}.`);
  return byKind;
}

function geometry({ data, at }: { data: Record<string, unknown>; at: Location }): ThreeStaticGeometry {
  const { primitive } = data;
  if (primitive === "box") {
    only(data, ["primitive", "width", "height", "depth"], at);
    const size = (key: "width" | "height" | "depth") => {
      const value = data[key];
      if (!positive(value) || !positive(value / 2)) fail("INVALID_GEOMETRY", field(at, key), "Use a positive box dimension with a representable half extent.");
      return value;
    };
    return { primitive, width: size("width"), height: size("height"), depth: size("depth") };
  }
  if (primitive === "sphere") {
    only(data, ["primitive", "radius"], at);
    const { radius } = data;
    if (!positive(radius)) fail("INVALID_GEOMETRY", field(at, "radius"), "Use a positive finite sphere radius.");
    return { primitive, radius };
  }
  return fail("INVALID_GEOMETRY", field(at, "primitive"), "Use box or sphere geometry. External meshes and other primitives are not supported.");
}

function material({ data, at }: { data: Record<string, unknown>; at: Location }): ThreeStaticMaterial {
  only(data, ["model", "color"], at);
  if (data.model !== "lambert") fail("INVALID_MATERIAL", field(at, "model"), "Use the opaque lambert material model.");
  return { model: data.model, color: color(data.color, field(at, "color"), "INVALID_MATERIAL") };
}

function assertMeshExtents(shape: ThreeStaticGeometry, pose: ThreeStaticTransform, loc: Location) {
  const half = shape.primitive === "box" ? [shape.width / 2, shape.height / 2, shape.depth / 2] : [shape.radius, shape.radius, shape.radius];
  const scaled = half.map((n, i) => n * pose.scale[i]);
  const extent = Math.hypot(...scaled);
  if (!scaled.every(positive) || !pose.position.every(n => number(Math.abs(n) + extent)))
    fail("INVALID_TRANSFORM", field(field(loc, "transform"), "scale"), "Choose geometry and a transform whose scaled world extents remain finite and nonzero at float32 precision.");
}

function camera(nodeId: string, { data, at }: { data: Record<string, unknown>; at: Location }, pose: ThreeStaticTransform,
  aspect: number): ThreeStaticCamera {
  only(data, ["projection", "fovYDegrees", "near", "far"], at);
  const { projection, fovYDegrees, near, far } = data;
  if (projection !== "perspective") fail("INVALID_CAMERA", field(at, "projection"), "Use a perspective camera.");
  if (!positive(fovYDegrees) || fovYDegrees >= 180) fail("INVALID_CAMERA", field(at, "fovYDegrees"), "Set a vertical field of view strictly between 0 and 180 degrees.");
  const focalScale = 1 / Math.tan(fovYDegrees * Math.PI / 360);
  if (!positive(focalScale) || !positive(focalScale / aspect))
    fail("INVALID_CAMERA", field(at, "fovYDegrees"), "Choose a field of view with representable projection scales at the sequence aspect ratio.");
  if (!positive(near)) fail("INVALID_CAMERA", field(at, "near"), "Set the near plane to a positive finite distance.");
  if (!positive(far) || Math.fround(far) <= Math.fround(near))
    fail("INVALID_CAMERA", field(at, "far"), "Set a far plane that remains farther than near at float32 precision.");
  const depth = far - near;
  if (!positive((far + near) / depth) || !positive(2 * far * near / depth))
    fail("INVALID_CAMERA", field(at, "far"), "Choose clipping planes with representable depth projection coefficients.");
  return { nodeId, projection, position: pose.position, rotationRadians: pose.rotationRadians, fovYDegrees, near, far };
}

function light(nodeId: string, { data, at }: { data: Record<string, unknown>; at: Location }, pose: ThreeStaticTransform,
  nodeLocation: Location): ThreeStaticLight {
  const { type, intensity, target } = data;
  if (type !== "ambient" && type !== "directional") fail("INVALID_LIGHT", field(at, "type"), "Use ambient or directional lighting.");
  only(data, type === "ambient" ? ["type", "color", "intensity"] : ["type", "color", "intensity", "target"], at);
  if (!number(intensity) || intensity < 0) fail("INVALID_LIGHT", field(at, "intensity"), "Use a finite, nonnegative intensity.");
  const paint = color(data.color, field(at, "color"), "INVALID_LIGHT");
  if (type === "ambient") {
    if (!uniform(pose.position, 0)) fail("INVALID_TRANSFORM", field(field(nodeLocation, "transform"), "position"), "Ambient light has no position. Use [0, 0, 0].");
    return { nodeId, type, color: paint, intensity };
  }
  if (!vector(target) || target.every((value, i) => Math.fround(value) === Math.fround(pose.position[i])))
    fail("INVALID_LIGHT", field(at, "target"), "Set a finite XYZ world target distinct from the light position.");
  return { nodeId, type, color: paint, intensity, position: pose.position, target: [...target] };
}

/** Pure preflight on an immutable canonical ProjectDocument render request. Nothing renders here. */
export function prepareThreeStaticScene(request: ThreeStaticRequest): ThreeStaticScene {
  const { project, revisionId, snapshotHash, profile, sceneId } = request;
  request.signal?.throwIfAborted();
  if (project.schemaVersion !== "1.1.0") fail("UNSUPPORTED_PROJECT", where("/project/schemaVersion"), "Use ProjectDocument 1.1.0.");
  if (!revisionId || project.revisions.at(-1)?.id !== revisionId)
    fail("INVALID_SNAPSHOT", where("/revisionId"), "Use the exact retained head revision for this snapshot.");
  if (hashProject(project) !== snapshotHash) fail("INVALID_SNAPSHOT", where("/snapshotHash"), "Use the content hash of the retained ProjectDocument.");
  if (project.project.coordinateSystem !== "right-handed-y-up")
    fail("UNSUPPORTED_PROJECT", where("/project/project/coordinateSystem"), "Use right-handed-y-up scene coordinates. Convert the authored scene explicitly.");
  if (project.project.colorSpace !== "srgb") fail("UNSUPPORTED_PROJECT", where("/project/project/colorSpace"), "Use sRGB paint for the static subset.");

  if (project.sequences.length !== 1) fail("UNSUPPORTED_TIMELINE", where("/project/sequences"), "Supply one sequence for a static shot.");
  if (project.scenes.length !== 1) fail("UNSUPPORTED_TIMELINE", where("/project/scenes"), "Supply one scene for a static shot.");
  if (project.shots?.length !== 1) fail("UNSUPPORTED_TIMELINE", where("/project/shots"), "Supply one full-length shot.");
  const [sequence] = project.sequences, [scene] = project.scenes, [shot] = project.shots;
  const here = (path: string) => where(path, scene.id);
  if (sequence.shotIds.length !== 1 || sequence.shotIds[0] !== shot.id)
    fail("UNSUPPORTED_TIMELINE", here("/project/sequences/0/shotIds"), "Reference only the single shot from the sequence.");
  if (shot.sceneId !== scene.id) fail("UNSUPPORTED_TIMELINE", here("/project/shots/0/sceneId"), "Reference the single scene from the shot.");
  if (shot.startFrame !== 0) fail("UNSUPPORTED_TIMELINE", here("/project/shots/0/startFrame"), "Start the only shot at frame 0. Gaps are not supported.");
  if ((shot.inFrame ?? 0) !== 0) fail("UNSUPPORTED_TIMELINE", here("/project/shots/0/inFrame"), "Use the full scene without a source trim.");
  if (!integer(sequence.durationFrames) || sequence.durationFrames !== shot.durationFrames || shot.durationFrames !== scene.durationFrames)
    fail("UNSUPPORTED_TIMELINE", here("/project/shots/0/durationFrames"), "Match the positive sequence, shot and scene durations.");
  for (const [present, path, label] of [
    [sequence.captions?.length, "/project/sequences/0/captions", "captions"],
    [sequence.transitions?.length, "/project/sequences/0/transitions", "transitions"],
    [shot.transitionIn !== undefined, "/project/shots/0/transitionIn", "shot transitions"],
    [shot.transitionOut !== undefined, "/project/shots/0/transitionOut", "shot transitions"],
    [sequence.trackIds?.length, "/project/sequences/0/trackIds", "timeline tracks"],
    [project.tracks?.length, "/project/tracks", "timeline tracks"],
    [project.clips?.length, "/project/clips", "media clips"],
    [project.assets.length, "/project/assets", "external assets"],
    [project.prefabs.length, "/project/prefabs", "prefabs"],
    [Object.keys(request.imageAssets ?? {}).length, "/imageAssets", "PNG inputs"],
    ["audioAssets" in request && Object.keys(request.audioAssets ?? {}).length, "/audioAssets", "WAV inputs"],
  ] as const) if (present) fail("UNSUPPORTED_FEATURE", here(path), `Remove ${label} from the static 3D render input.`);
  const animation = project.animationTracks.findIndex(track => track.enabled !== false);
  if (animation !== -1) {
    const track = project.animationTracks[animation];
    fail("UNSUPPORTED_ANIMATION", { ...here(`/project/animationTracks/${animation}`), nodeId: track.targetNodeId, trackId: track.id },
      "Use a static pose without enabled keyframes, including camera keys.");
  }
  const constraint = project.constraints.findIndex(item => item.enabled);
  if (constraint !== -1) {
    const item = project.constraints[constraint];
    fail("UNSUPPORTED_FEATURE", { ...here(`/project/constraints/${constraint}`), nodeId: item.sourceNodeId, constraintId: item.id },
      "Use explicit transforms without enabled scene constraints.");
  }

  const { width, height, fps } = sequence;
  if (sceneId !== undefined && sceneId !== scene.id) fail("INVALID_REQUEST", here("/sceneId"), "Select the snapshot's single scene.");
  if (![width, height, fps].every(integer) || fps !== project.project.timebase.fps)
    fail("UNSUPPORTED_TIMELINE", here("/project/sequences/0"), "Use positive integer dimensions and match the project frame rate.");
  if (profile && (profile.width !== width || profile.height !== height || (profile.fps !== undefined && profile.fps !== fps)))
    fail("INVALID_REQUEST", here("/profile"), "Match the retained sequence's width, height and frame rate.");
  const still = "frame" in request;
  const startFrame = still ? request.frame : request.startFrame;
  const durationFrames = still ? 1 : request.durationFrames;
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= sequence.durationFrames)
    fail("INVALID_REQUEST", here(still ? "/frame" : "/startFrame"), "Start inside the shot's zero-based frame range.");
  if (!integer(durationFrames) || durationFrames > sequence.durationFrames - startFrame)
    fail("INVALID_REQUEST", here("/durationFrames"), "Keep the positive frame count within the shot.");

  const byId = new Map<string, { node: SceneNode; loc: Location }>();
  for (const [i, node] of project.nodes.entries()) {
    const loc = { ...here(`/project/nodes/${i}`), nodeId: node.id };
    if (byId.has(node.id)) fail("INVALID_ROOTS", field(loc, "id"), "Use unique node IDs in the scene.");
    byId.set(node.id, { node, loc });
    if (node.parentId !== undefined || node.childIds?.length || node.prefabId !== undefined)
      fail("UNSUPPORTED_NODE", loc, "Use flat root nodes without children or prefab instances.");
  }
  const roots = new Set<string>();
  const meshes: ThreeStaticScene["meshes"] = [], lights: ThreeStaticLight[] = [];
  let selectedCamera: ThreeStaticCamera | undefined;
  for (const [i, nodeId] of scene.rootNodeIds.entries()) {
    const entry = byId.get(nodeId);
    if (!entry || roots.has(nodeId)) fail("INVALID_ROOTS", { ...here(`/project/scenes/0/rootNodeIds/${i}`), nodeId }, "Each scene root must identify a different node in this snapshot.");
    roots.add(nodeId);
    const { node, loc } = entry;
    if (node.type !== "mesh" && node.type !== "camera" && node.type !== "light")
      fail("UNSUPPORTED_NODE", field(loc, "type"), "The static 3D subset uses only mesh, camera and light nodes.");
    const pose = transform(node, loc);
    if (node.type === "mesh") {
      const data = components(node, loc, ["geometry", "material"]);
      const shape = geometry(data.get("geometry")!);
      assertMeshExtents(shape, pose, loc);
      meshes.push({ nodeId, transform: pose, geometry: shape, material: material(data.get("material")!) });
    } else if (node.type === "camera") {
      if (selectedCamera) fail("INVALID_CAMERA", loc, "Keep exactly one perspective camera in the scene.");
      selectedCamera = camera(nodeId, components(node, loc, ["camera"]).get("camera")!, pose, width / height);
    } else lights.push(light(nodeId, components(node, loc, ["light"]).get("light")!, pose, loc));
  }
  const rootLocation = here("/project/scenes/0/rootNodeIds");
  const missing = project.nodes.find(node => !roots.has(node.id));
  if (missing) fail("INVALID_ROOTS", { ...rootLocation, nodeId: missing.id }, "List every project node as a root of the single scene.");
  if (!selectedCamera) fail("INVALID_CAMERA", rootLocation, "Add exactly one perspective camera.");
  if (!meshes.length) fail("INVALID_GEOMETRY", rootLocation, "Add at least one mesh with a supported primitive.");
  return { sceneId: scene.id, sequenceId: sequence.id, shotId: shot.id, profile: { width, height, fps }, range: { startFrame, durationFrames },
    backgroundColor: "#07111f", camera: selectedCamera, meshes, lights };
}
