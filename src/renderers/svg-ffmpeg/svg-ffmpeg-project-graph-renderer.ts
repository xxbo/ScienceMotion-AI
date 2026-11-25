import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectAnimationTrack, SceneNode, Vector3 } from "../../contracts/project";
import {
  ProjectGraphRendererError, type ProjectGraphPreviewRequest, type ProjectGraphRenderOutput, type ProjectGraphRenderProgress,
  type ProjectGraphSnapshotRenderer, type ProjectGraphVideoRequest,
} from "../../contracts/renderer";
import { sampleAnimationTrack, validateAnimationTrack } from "../../platform/animation";
import { hashProject } from "../../platform/project-snapshots";

type Shape = { primitive: "rect" | "ellipse" | "circle"; width: number; height: number; fill: string; position: Vector3; track?: ProjectAnimationTrack };
type SceneSlice = { width: number; height: number; fps: number; firstSceneFrame: number; shapes: Shape[] };
type SnapshotRequest = ProjectGraphPreviewRequest | ProjectGraphVideoRequest;
const geometryFields = new Set(["primitive", "width", "height", "fill", "stroke", "strokeWidth", "radius"]);
const hexPaint = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;
const dimension = (value: unknown): value is number => typeof value === "number" && value > 0 && value <= 10_000;
const position2d = (value: unknown): value is Vector3 =>
  Array.isArray(value) && value.length === 3 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[2] === 0;
const uniform = (value: Vector3, component: number) => value.length === 3 &&
  value[0] === component && value[1] === component && value[2] === component;

function unsupported(feature: string): never {
  throw new ProjectGraphRendererError("SVG_FFMPEG_UNSUPPORTED", feature);
}
function invalid(message: string): never {
  throw new ProjectGraphRendererError("SVG_FFMPEG_INVALID_REQUEST", message);
}

function shape(node: SceneNode, track?: ProjectAnimationTrack): Shape {
  if (node.type !== "shape") unsupported(`Node ${node.id} has unsupported type ${node.type}. Only flat shape nodes can be rendered.`);
  if (node.parentId !== undefined || node.childIds?.length || node.prefabId !== undefined)
    unsupported(`Node ${node.id} uses a hierarchy or prefab. Only root shapes can be rendered.`);
  const [component] = node.components;
  if (node.components.length !== 1 || component?.kind !== "geometry" || component.engine !== undefined)
    unsupported(`Node ${node.id} must have exactly one renderer-neutral geometry component.`);
  const { primitive, width, height, fill, strokeWidth, radius } = component.data;
  if (primitive !== "rect" && primitive !== "ellipse" && primitive !== "circle")
    unsupported(`Node ${node.id} must use a rect, ellipse, or circle primitive.`);
  if (!dimension(width) || !dimension(height) || (primitive === "circle" && width !== height))
    unsupported(`Node ${node.id} requires positive dimensions up to 10000 and equal sides for a circle.`);
  if (typeof fill !== "string" || !hexPaint.test(fill) || (strokeWidth ?? 0) !== 0 || (radius ?? 0) !== 0 ||
      Object.keys(component.data).some(key => !geometryFields.has(key)))
    unsupported(`Node ${node.id} requires an opaque hex fill without a visible stroke, rounded corners, or extra geometry fields.`);
  const { position, scale, rotation, pivot } = node.transform;
  if (!position2d(position) || !uniform(scale, 1) || !uniform(rotation, 0) || (pivot !== undefined && !uniform(pivot, 0)))
    unsupported(`Node ${node.id} uses a transform other than a 2D translation.`);
  return { primitive, width, height, fill, position: [...position], track };
}

/** Validate the entire supported graph before staging any frame or starting FFmpeg. */
function prepare(request: SnapshotRequest, start: number, count: number, video: boolean): SceneSlice {
  const { project, revisionId, snapshotHash, profile, sceneId, imageAssets } = request;
  if (project.schemaVersion !== "1.1.0") unsupported("SVG and FFmpeg require Project Graph schema 1.1.0.");
  if (!revisionId || project.revisions.at(-1)?.id !== revisionId || hashProject(project) !== snapshotHash)
    invalid("The supplied revision or snapshot hash differs from the Project Graph.");
  if (project.project.coordinateSystem !== "screen-y-down" || project.project.colorSpace !== "srgb")
    unsupported("SVG and FFmpeg require screen-y-down coordinates and sRGB paint.");
  const [sequence] = project.sequences, [scene] = project.scenes, [shot] = project.shots ?? [];
  if (project.sequences.length !== 1 || project.scenes.length !== 1 || project.shots?.length !== 1 ||
      sequence.shotIds.length !== 1 || sequence.shotIds[0] !== shot.id || shot.sceneId !== scene.id)
    unsupported("SVG and FFmpeg require a single sequence with one shot and one scene.");
  if (sequence.captions?.length || sequence.transitions?.length || shot.transitionIn !== undefined || shot.transitionOut !== undefined)
    unsupported("SVG and FFmpeg do not support captions or transitions.");
  if (project.assets.length || project.clips?.length || project.tracks?.length || sequence.trackIds?.length ||
      Object.keys(imageAssets ?? {}).length || ("audioAssets" in request && Object.keys(request.audioAssets ?? {}).length))
    unsupported("SVG and FFmpeg do not support media assets, timeline tracks, or clips.");
  if (project.prefabs.length || project.constraints.length) unsupported("SVG and FFmpeg do not support prefabs or scene constraints.");
  const { width, height, fps } = sequence;
  if (![width, height].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 7680) || !Number.isSafeInteger(fps) || fps < 1 || fps > 120)
    unsupported("SVG and FFmpeg require integer dimensions up to 7680 and an integer frame rate from 1 to 120.");
  if (profile && (profile.width !== width || profile.height !== height || (profile.fps !== undefined && profile.fps !== fps)))
    unsupported("The render profile must match the snapshot sequence.");
  if (video && (width % 2 || height % 2)) unsupported("H.264 yuv420p output requires even width and height.");
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 || count > 900 ||
      !Number.isSafeInteger(sequence.durationFrames) || count > sequence.durationFrames - start)
    invalid("The requested frame or 1–900 frame range must be inside the sequence.");
  if (sceneId !== undefined && sceneId !== scene.id) invalid("The requested scene is not the snapshot's single scene.");
  const sourceStart = shot.inFrame ?? 0;
  if (!Number.isSafeInteger(shot.startFrame) || shot.startFrame < 0 || !Number.isSafeInteger(shot.durationFrames) ||
      shot.durationFrames < 1 || shot.durationFrames > sequence.durationFrames - shot.startFrame ||
      !Number.isSafeInteger(scene.durationFrames) || !Number.isSafeInteger(sourceStart) || sourceStart < 0 || shot.durationFrames > scene.durationFrames - sourceStart)
    invalid("The shot must be inside the sequence and its source scene.");
  if (sceneId === undefined && (start < shot.startFrame || count > shot.durationFrames - (start - shot.startFrame)))
    unsupported("The requested range falls outside the single shot. Timeline gaps are not supported.");
  const firstSceneFrame = sceneId === undefined ? start - shot.startFrame + sourceStart : start;
  if (count > scene.durationFrames - firstSceneFrame) invalid("The requested range exceeds the scene duration.");

  const nodes = new Map(project.nodes.map(node => [node.id, node]));
  if (nodes.size !== project.nodes.length || new Set(scene.rootNodeIds).size !== nodes.size ||
      scene.rootNodeIds.length !== nodes.size || scene.rootNodeIds.some(id => !nodes.has(id)))
    unsupported("All nodes must be unique roots of the single scene.");
  const tracks = new Map<string, ProjectAnimationTrack>();
  for (const track of project.animationTracks) {
    if (track.enabled === false) continue;
    if (!nodes.has(track.targetNodeId) || tracks.has(track.targetNodeId) || track.targetProperty !== "transform.position" || track.loop ||
        validateAnimationTrack(track).length || track.keyframes.some(key =>
          (key.interpolation ?? "linear") !== "linear" || (key.easing ?? "linear") !== "linear" ||
          !position2d(key.value) || key.frame >= scene.durationFrames))
      unsupported(`Track ${track.id} must be the node's only enabled track, with non-looping scene-local linear 2D position keys.`);
    tracks.set(track.targetNodeId, structuredClone(track));
  }
  return { width, height, fps, firstSceneFrame, shapes: scene.rootNodeIds.map(id => shape(nodes.get(id)!, tracks.get(id))) };
}

function svgFrame({ width, height, shapes }: SceneSlice, sceneFrame: number): string {
  // Match the shared Project Graph canvas behind the authored shapes. Only validated numbers and hex paints enter the XML.
  const body = [`<rect width="${width}" height="${height}" fill="#07111f"/>`];
  for (const { primitive, width: w, height: h, fill, position, track } of shapes) {
    const [x, y] = track ? sampleAnimationTrack(track, sceneFrame)!.value as Vector3 : position;
    if (primitive === "rect") body.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`);
    else if (primitive === "circle") body.push(`<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w / 2}" fill="${fill}"/>`);
    else body.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body.join("")}</svg>\n`;
}

function runFfmpeg(binary: string, directory: string, args: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: directory, signal, killSignal: "SIGKILL", stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", launchError: NodeJS.ErrnoException | undefined;
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", error => { launchError = error; });
    // Wait for the process to exit before the adapter removes its scratch files, including on abort.
    child.once("close", code => {
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0 && !launchError) resolve();
      else if (launchError?.code === "ENOENT" || launchError?.code === "EACCES")
        reject(new ProjectGraphRendererError("SVG_FFMPEG_UNAVAILABLE", "The configured FFmpeg executable is not available."));
      else {
        const details = stderr.trim().replace(/\s+/g, " ").slice(0, 350);
        const unavailable = /unknown (?:decoder|encoder)|(?:decoder|encoder).*not found/i.test(details);
        reject(new ProjectGraphRendererError(unavailable ? "SVG_FFMPEG_UNAVAILABLE" : "SVG_FFMPEG_FAILED",
          `FFmpeg could not render the SVG frames${details ? `: ${details}` : ` (exit ${code})`}.`));
      }
    });
  });
}

/** Opt-in CPU renderer for the shape-only Project Graph slice. No browser or Remotion worker is used. */
export class SvgFfmpegProjectGraphRenderer implements ProjectGraphSnapshotRenderer {
  readonly id = "svg-ffmpeg-project-graph";
  readonly version = "1.0.0";
  constructor(private readonly ffmpegPath = "ffmpeg") {}

  renderPreview(request: ProjectGraphPreviewRequest): Promise<ProjectGraphRenderOutput> {
    return this.render(request, request.frame, 1, "png");
  }
  renderVideo(request: ProjectGraphVideoRequest): Promise<ProjectGraphRenderOutput> {
    return this.render(request, request.startFrame, request.durationFrames, "mp4");
  }

  private async render(request: SnapshotRequest, start: number, count: number, extension: "png" | "mp4"): Promise<ProjectGraphRenderOutput> {
    const { signal, onProgress } = request;
    const report = (phase: ProjectGraphRenderProgress["phase"], fraction?: number) => {
      try { onProgress?.({ phase, ...(fraction === undefined ? {} : { fraction }) }); } catch { /* Observer only. */ }
    };
    const video = extension === "mp4";
    signal?.throwIfAborted();
    report("selecting");
    const slice = prepare(request, start, count, video);
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "sciencemotion-svg-ffmpeg-"));
    try {
      report("rendering", 0);
      for (let i = 0; i < count; i++) {
        signal?.throwIfAborted();
        await writeFile(join(directory, `frame-${String(i).padStart(6, "0")}.svg`), svgFrame(slice, slice.firstSceneFrame + i), { signal });
      }
      if (video) {
        report("rendering", 1);
        report("encoding", 0);
      }
      const file = "render." + extension;
      await runFfmpeg(this.ffmpegPath, directory, ["-v", "error", "-xerror", "-nostdin", "-filter_threads", "1", "-protocol_whitelist", "file,pipe",
        "-f", "image2", "-c:v", "librsvg", "-threads", "1", "-framerate", String(slice.fps), "-start_number", "0",
        "-i", "frame-%06d.svg", "-map", "0:v:0", "-an", "-frames:v", String(count), "-threads", "1",
        ...(video ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
          : ["-c:v", "png", "-pix_fmt", "rgba", "-f", "image2", "-update", "1"]), file], signal);
      signal?.throwIfAborted();
      const path = join(directory, file);
      const output = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!output?.isFile() || output.size < 8 || output.size > 64 * 1024 * 1024)
        throw new ProjectGraphRendererError("SVG_FFMPEG_FAILED", "FFmpeg did not produce a nonempty artifact within the renderer's byte limit.");
      const bytes = await readFile(path, { signal });
      report(video ? "encoding" : "rendering", 1);
      signal?.throwIfAborted();
      return { bytes, extension, mediaType: video ? "video/mp4" : "image/png", rendererId: this.id, rendererVersion: this.version };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
