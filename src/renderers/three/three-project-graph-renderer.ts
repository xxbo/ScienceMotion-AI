import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderStill, selectComposition } from "@remotion/renderer";
import { ProjectGraphRendererError, type ProjectGraphPreviewRequest, type ProjectGraphRenderOutput, type ProjectGraphRenderProgress,
  type ProjectGraphSnapshotRenderer, type ProjectGraphVideoRequest } from "../../contracts/renderer";
import { prepareThreeStaticScene, type ThreeStaticRequest, type ThreeStaticScene } from "./three-static-scene";

type Options = { entryPoint?: string; ffmpegPath?: string };
const chromiumOptions = { gl: "swangle" as const };

function stage(request: ThreeStaticRequest, phase: ProjectGraphRenderProgress["phase"], fraction?: number) {
  request.signal?.throwIfAborted();
  try { request.onProgress?.({ phase, ...(fraction === undefined ? {} : { fraction }) }); } catch { /* Observers only. */ }
  request.signal?.throwIfAborted();
}

function encodeStatic(binary: string, png: string, output: string, model: ThreeStaticScene, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const args = ["-v", "error", "-nostdin", "-y", "-loop", "1", "-framerate", String(model.profile.fps), "-i", png,
    "-map", "0:v:0", "-an", "-c:v", "libx264", "-threads", "1", "-crf", "17", "-pix_fmt", "yuv420p",
    "-frames:v", String(model.range.durationFrames), "-movflags", "+faststart", output];
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
        `FFmpeg could not encode the static frame. ${diagnostic.trim().replace(/\s+/g, " ").slice(-350) || `Exit ${code}.`}`));
    });
  });
}

/** Trusted opt-in adapter. The dedicated browser entry is not part of the default Remotion bundle. */
export class ThreeJsProjectGraphRenderer implements ProjectGraphSnapshotRenderer {
  readonly id = "three-js-project-graph";
  readonly version = "1.0.0";
  private readonly entryPoint: string;
  private readonly ffmpeg: string;
  constructor(options: Options = {}) {
    this.entryPoint = options.entryPoint ?? resolve("src/renderers/three/three-static-browser.tsx");
    this.ffmpeg = options.ffmpegPath ?? "ffmpeg";
  }

  renderPreview(request: ProjectGraphPreviewRequest) { return this.render(request, "png"); }
  renderVideo(request: ProjectGraphVideoRequest) { return this.render(request, "mp4"); }

  private async render(request: ThreeStaticRequest, extension: "png" | "mp4"): Promise<ProjectGraphRenderOutput> {
    const model = prepareThreeStaticScene(request);
    const { width, height } = model.profile;
    if (width > 7680 || height > 7680)
      throw new ProjectGraphRendererError("THREE_STATIC_UNSUPPORTED_OUTPUT", "The static browser surface supports dimensions up to 7680 pixels.");
    if (extension === "mp4" && (width % 2 || height % 2 || model.range.durationFrames > 900))
      throw new ProjectGraphRendererError("THREE_STATIC_UNSUPPORTED_OUTPUT", "Silent H.264 yuv420p needs even dimensions and at most 900 frames.");
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
      const inputProps = { model };
      const composition = await selectComposition({ serveUrl, id: "ThreeStaticSnapshot", inputProps, chromiumOptions });
      const png = join(directory, "frame.png");
      stage(request, "rendering", 0);
      await renderStill({ serveUrl, composition, inputProps, frame: 0, output: png, imageFormat: "png", chromiumOptions, cancelSignal });
      stage(request, "rendering", 1);
      let file = png;
      // This subtree is static. Encode a held frame at the original sequence FPS, without simulating camera keys.
      if (extension === "mp4") {
        stage(request, "encoding", 0);
        file = join(directory, "video.mp4");
        await encodeStatic(this.ffmpeg, png, file, model, request.signal);
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
      throw new ProjectGraphRendererError("THREE_STATIC_BROWSER_FAILED", `Three.js could not produce the static frame. ${message.replace(/\s+/g, " ").slice(0, 450)}`);
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
