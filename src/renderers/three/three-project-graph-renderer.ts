import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderFrames, renderStill, selectComposition } from "@remotion/renderer";
import type { PendulumReplay } from "../../contracts/pendulum-replay";
import { ProjectGraphRendererError, type ProjectGraphPreviewRequest, type ProjectGraphRenderOutput, type ProjectGraphRenderProgress,
  type ProjectGraphSnapshotRenderer, type ProjectGraphVideoRequest } from "../../contracts/renderer";
import { assertNoPendulumReplay, preparePendulumReplay } from "../../platform/pendulum-replay";
import { prepareThreeCameraScene, type ThreeStaticRequest } from "./three-static-scene";

type Options = { entryPoint?: string; ffmpegPath?: string };
const chromiumOptions = { gl: "swangle" as const };

function report(request: ThreeStaticRequest, phase: ProjectGraphRenderProgress["phase"], fraction?: number) {
  if (request.signal?.aborted) return;
  try { request.onProgress?.({ phase, ...(fraction === undefined ? {} : { fraction }) }); } catch { /* Observers only. */ }
}

function stage(request: ThreeStaticRequest, phase: ProjectGraphRenderProgress["phase"], fraction?: number) {
  request.signal?.throwIfAborted();
  report(request, phase, fraction);
  request.signal?.throwIfAborted();
}

function encodeShot(binary: string, input: string, output: string, fps: number, count: number, held: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const args = ["-v", "error", "-nostdin", "-y", ...(held ? ["-loop", "1"] : ["-start_number", "0"]), "-framerate", String(fps), "-i", input,
    "-map", "0:v:0", "-an", "-c:v", "libx264", "-threads", "1", "-crf", "17", "-pix_fmt", "yuv420p",
    "-frames:v", String(count), "-movflags", "+faststart", output];
  return new Promise<void>((done, reject) => {
    const child = spawn(binary, args, { signal, killSignal: "SIGKILL", stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "", failure: NodeJS.ErrnoException | undefined;
    child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-2048); });
    child.on("error", error => { failure = error; });
    child.once("close", code => {
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0 && !failure) done();
      else if (failure?.code === "ENOENT" || failure?.code === "EACCES" || /unknown encoder.*libx264/i.test(diagnostic))
        reject(new ProjectGraphRendererError("THREE_STATIC_FFMPEG_UNAVAILABLE", "Install an executable FFmpeg with the libx264 encoder."));
      else reject(new ProjectGraphRendererError("THREE_STATIC_FFMPEG_FAILED",
        `FFmpeg could not encode the Three.js shot. ${diagnostic.trim().replace(/\s+/g, " ").slice(-350) || `Exit ${code}.`}`));
    });
  });
}

/** Trusted opt-in adapter. The dedicated browser entry is not part of the default Remotion bundle. */
export class ThreeJsProjectGraphRenderer implements ProjectGraphSnapshotRenderer {
  readonly id: string = "three-js-project-graph";
  readonly version: string = "1.1.0";
  private readonly entryPoint: string;
  private readonly ffmpeg: string;
  constructor(options: Options = {}) {
    this.entryPoint = options.entryPoint ?? resolve("src/renderers/three/three-static-browser.tsx");
    this.ffmpeg = options.ffmpegPath ?? "ffmpeg";
  }

  renderPreview(request: ProjectGraphPreviewRequest) { return this.render(request, "png"); }
  renderVideo(request: ProjectGraphVideoRequest) { return this.render(request, "mp4"); }

  protected replay(request: ThreeStaticRequest): PendulumReplay | undefined {
    assertNoPendulumReplay(request);
    return undefined;
  }
  private async render(request: ThreeStaticRequest, extension: "png" | "mp4"): Promise<ProjectGraphRenderOutput> {
    const replay = this.replay(request);
    const prepared = replay ? undefined : prepareThreeCameraScene(request);
    const profile = replay?.profile ?? prepared!.model.profile;
    const { startFrame, durationFrames } = replay?.range ?? prepared!.model.range;
    const { width, height, fps } = profile;
    if (width > 7680 || height > 7680)
      throw new ProjectGraphRendererError("THREE_STATIC_UNSUPPORTED_OUTPUT", "The static browser surface supports dimensions up to 7680 pixels.");
    if (extension === "mp4" && (width % 2 || height % 2 || durationFrames > 900))
      throw new ProjectGraphRendererError("THREE_STATIC_UNSUPPORTED_OUTPUT", "Silent H.264 yuv420p needs even dimensions and at most 900 frames.");
    const cameraAt = prepared?.cameraAt;
    // Preview and video sample in scene time before bundling. Browser frame zero is the first requested frame.
    const cameraFrames = cameraAt ? Array.from({ length: durationFrames }, (_, index) => {
      request.signal?.throwIfAborted();
      return cameraAt(startFrame + index);
    }) : undefined;
    stage(request, "bundling");
    const { cancelSignal, cancel } = makeCancelSignal();
    request.signal?.addEventListener("abort", cancel, { once: true });
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "sciencemotion-three-static-"));
      const publicDir = join(directory, "public");
      await mkdir(publicDir);
      const serveUrl = await bundle({ entryPoint: this.entryPoint, outDir: join(directory, "bundle"), publicDir });
      stage(request, "selecting");
      const inputProps = replay ? { replay } : { model: prepared!.model, ...(cameraFrames ? { cameraFrames } : {}) };
      const composition = await selectComposition({ serveUrl, id: replay ? "ThreePendulumReplay" : "ThreeStaticSnapshot", inputProps, chromiumOptions });
      const png = join(directory, "frame.png");
      const moving = !!(replay || cameraFrames) && extension === "mp4" && durationFrames > 1;
      const framePattern = join(directory, "frame-%d.png");
      const sequenceCode = replay ? "PENDULUM_REPLAY_FRAME_SEQUENCE" : "THREE_CAMERA_FRAME_SEQUENCE";
      stage(request, "rendering", 0);
      if (moving) {
        const captured = new Set<number>();
        const frameDirectory = directory;
        await renderFrames({ serveUrl, composition, inputProps, frameRange: [0, durationFrames - 1], imageFormat: "png",
          outputDir: null, chromiumOptions, cancelSignal, muted: true, concurrency: 1,
          onStart: () => {}, onFrameUpdate: count => report(request, "rendering", count / durationFrames),
          onFrameBuffer: async (bytes, frame) => {
            if (!Number.isSafeInteger(frame) || frame < 0 || frame >= durationFrames || captured.has(frame))
              throw new ProjectGraphRendererError(sequenceCode, `Unexpected output frame ${frame} from the browser.`);
            captured.add(frame);
            await writeFile(join(frameDirectory, `frame-${frame}.png`), bytes, { signal: request.signal });
          } });
        if (captured.size !== durationFrames)
          throw new ProjectGraphRendererError(sequenceCode, `The browser captured ${captured.size} of ${durationFrames} requested frames.`);
      } else await renderStill({ serveUrl, composition, inputProps, frame: 0, output: png, imageFormat: "png", chromiumOptions, cancelSignal });
      stage(request, "rendering", 1);
      let file = png;
      if (extension === "mp4") {
        stage(request, "encoding", 0);
        file = join(directory, "video.mp4");
        await encodeShot(this.ffmpeg, moving ? framePattern : png, file, fps, durationFrames, !moving, request.signal);
        stage(request, "encoding", 1);
      }
      const bytes = await readFile(file, { signal: request.signal });
      request.signal?.throwIfAborted();
      return { bytes, mediaType: extension === "png" ? "image/png" : "video/mp4", extension, rendererId: this.id, rendererVersion: this.version };
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error instanceof ProjectGraphRendererError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("THREE_STATIC_WEBGL_UNAVAILABLE"))
        throw new ProjectGraphRendererError("THREE_STATIC_WEBGL_UNAVAILABLE", "The Remotion browser could not initialize software WebGL2.");
      if (message.includes("THREE_STATIC_WEBGL_LIMIT"))
        throw new ProjectGraphRendererError("THREE_STATIC_WEBGL_LIMIT", "The requested profile exceeds the browser's WebGL2 viewport or framebuffer limits.");
      throw new ProjectGraphRendererError("THREE_STATIC_BROWSER_FAILED", `Three.js could not render the requested scene. ${message.replace(/\s+/g, " ").slice(0, 450)}`);
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Opt-in renderer identity for replaying the same samples with WebGL geometry. */
export class ThreeJsPendulumReplayRenderer extends ThreeJsProjectGraphRenderer {
  override readonly id = "three-js-pendulum-replay";
  override readonly version = "1.0.0";
  readonly supportsPendulumReplay = true;
  protected override replay(request: ThreeStaticRequest) { return preparePendulumReplay(request); }
}
