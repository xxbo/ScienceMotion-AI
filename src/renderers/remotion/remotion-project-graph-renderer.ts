import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderFrames, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LayoutFrameMeasurement } from "../../contracts/layout-inspection";
import type { PendulumReplay } from "../../contracts/pendulum-replay";
import { ProjectGraphRendererError } from "../../contracts/renderer";
import type { ProjectGraphLayoutRequest, ProjectGraphPreviewRequest, ProjectGraphRenderProgress, ProjectGraphRenderRequest,
  ProjectGraphSnapshotRenderer, ProjectGraphRenderOutput, ProjectGraphVideoRequest } from "../../contracts/renderer";
import { verifiedPngSources } from "../../platform/png-render-inputs";
import { assertValidFollowPaths } from "../../platform/follow-path";
import { verifiedRenderWavAssets } from "../../platform/wav-render-inputs";
import { assertNoPendulumReplay, hasPendulumReplay, preparePendulumReplay } from "../../platform/pendulum-replay";
import { serveRenderWavSources } from "./render-wav-sources";

export class RemotionProjectGraphRenderer implements ProjectGraphSnapshotRenderer {
  readonly id: string = "remotion.project-graph"; readonly version = "1.0.0";
  readonly supportsPendulumReplay?: true;
  private serveUrlPromise?: Promise<string>;
  private readonly browserOptions: { onBrowserDownload?: () => never };
  constructor(private readonly entryPoint = resolve("src/index.ts"), private readonly boundedTemporaryStorage = false,
    private readonly prepareBundle?: () => Promise<string>) {
    this.browserOptions = boundedTemporaryStorage ? {
      onBrowserDownload: () => { throw new Error("Install the Remotion browser before running disk-budgeted jobs"); },
    } : {};
  }
  private serveUrl(): Promise<string> {
    if (!this.serveUrlPromise) {
      const load = this.prepareBundle ?? (() => bundle({ entryPoint: this.entryPoint, enableCaching: !this.boundedTemporaryStorage }));
      this.serveUrlPromise = load().catch(error => { this.serveUrlPromise = undefined; throw error; });
    }
    return this.serveUrlPromise;
  }
  private report(request: ProjectGraphRenderRequest, phase: ProjectGraphRenderProgress["phase"], fraction?: number) {
    // Remotion can invoke progress from stream callbacks: cancellation must not throw there.
    if (request.signal?.aborted) return;
    try { request.onProgress?.({ phase, ...(fraction === undefined ? {} : { fraction: Math.max(0, Math.min(1, fraction)) }) }); } catch { /* Observers cannot change rendering. */ }
  }
  private stage(request: ProjectGraphRenderRequest, phase: ProjectGraphRenderProgress["phase"], fraction?: number) {
    request.signal?.throwIfAborted();
    this.report(request, phase, fraction);
    request.signal?.throwIfAborted();
  }
  private cancellation(request: ProjectGraphRenderRequest) {
    const { cancelSignal, cancel } = makeCancelSignal();
    request.signal?.addEventListener("abort", cancel, { once: true });
    return { cancelSignal, dispose: () => request.signal?.removeEventListener("abort", cancel) };
  }
  private inputProps(request: ProjectGraphRenderRequest) {
    assertValidFollowPaths(request.project);
    const imageSources = verifiedPngSources(request);
    return { project: structuredClone(request.project), sceneId: request.sceneId, ...(imageSources ? { imageSources } : {}) };
  }
  protected replay(request: ProjectGraphPreviewRequest | ProjectGraphVideoRequest): PendulumReplay | undefined {
    assertNoPendulumReplay(request);
    return undefined;
  }
  async measureLayout(request: ProjectGraphLayoutRequest): Promise<LayoutFrameMeasurement[]> {
    if (this.supportsPendulumReplay || hasPendulumReplay(request.project) || request.pendulumTrajectory !== undefined)
      throw new ProjectGraphRendererError("PENDULUM_REPLAY_LAYOUT_UNSUPPORTED", "Browser layout inspection is not available for trajectory replay.");
    const cancellation = this.cancellation(request);
    try {
      this.stage(request, "bundling");
      const renderProps = this.inputProps(request);
      const serveUrl = await this.serveUrl(), token = randomUUID();
      const inputProps = { ...renderProps, sceneId: undefined, layoutInspection: { token } };
      this.stage(request, "selecting");
      const composition = await selectComposition({ serveUrl, id: "ProjectGraph", inputProps, ...this.browserOptions });
      const measurements = new Map<number, LayoutFrameMeasurement>();
      this.stage(request, "rendering", 0);
      await renderFrames({ composition, serveUrl, inputProps, frames: request.frames, imageFormat: "none", outputDir: null,
        concurrency: 1, muted: true, cancelSignal: cancellation.cancelSignal, timeoutInMilliseconds: 20000, ...this.browserOptions,
        onStart: () => {}, onFrameUpdate: count => this.report(request, "rendering", count / request.frames.length),
        onArtifact: artifact => {
          if (!artifact.filename.startsWith(`layout-${token}-`)) return;
          if (!request.frames.includes(artifact.frame) || measurements.has(artifact.frame) || typeof artifact.content !== "string" || artifact.content.length > 4 * 1024 * 1024)
            throw new Error("Unexpected, duplicate or oversized browser layout evidence");
          measurements.set(artifact.frame, JSON.parse(artifact.content) as LayoutFrameMeasurement);
        } });
      request.signal?.throwIfAborted();
      if (measurements.size !== request.frames.length) throw new Error("Browser layout instrumentation did not return every requested frame");
      return request.frames.map(frame => measurements.get(frame)!);
    } finally { cancellation.dispose(); }
  }
  async renderPreview(request: ProjectGraphPreviewRequest): Promise<ProjectGraphRenderOutput> {
    const cancellation = this.cancellation(request); let directory: string | undefined;
    try {
      const replay = this.replay(request);
      this.stage(request, "bundling");
      const inputProps = replay ? { replay } : this.inputProps(request), serveUrl = await this.serveUrl();
      this.stage(request, "selecting");
      const composition = await selectComposition({ serveUrl, id: replay ? "PendulumReplay2D" : "ProjectGraph", inputProps, ...this.browserOptions });
      directory = await mkdtemp(join(tmpdir(), "sciencemotion-preview-")); const output = join(directory, "preview.png");
      this.stage(request, "rendering", 0);
      await renderStill({ composition, serveUrl, output, frame: replay ? 0 : request.frame, inputProps, cancelSignal: cancellation.cancelSignal, ...this.browserOptions });
      this.stage(request, "rendering", 1);
      return { bytes: new Uint8Array(await readFile(output)), mediaType: "image/png", extension: "png", rendererId: this.id, rendererVersion: this.version };
    } finally { cancellation.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); }
  }
  async renderVideo(request: ProjectGraphVideoRequest): Promise<ProjectGraphRenderOutput> {
    const cancellation = this.cancellation(request); let directory: string | undefined;
    let wavServer: Awaited<ReturnType<typeof serveRenderWavSources>> | undefined;
    try {
      const replay = this.replay(request);
      this.stage(request, "bundling");
      const props = replay ? { replay } : this.inputProps(request), audio = replay ? undefined : verifiedRenderWavAssets(request);
      if (audio?.files.size) wavServer = await serveRenderWavSources(audio.files);
      const inputProps = wavServer && audio ? { ...props, audioClips: audio.clips.map(({ clip, source }) => ({ clip, src: wavServer!.url(source.artifactId) })) } : props;
      const serveUrl = await this.serveUrl();
      this.stage(request, "selecting");
      const composition = await selectComposition({ serveUrl, id: replay ? "PendulumReplay2D" : "ProjectGraph", inputProps, ...this.browserOptions });
      directory = await mkdtemp(join(tmpdir(), "sciencemotion-video-")); const output = join(directory, "render.mp4");
      this.stage(request, "rendering", 0);
      await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: output, inputProps,
        frameRange: replay ? [0, replay.poses.length - 1] : [request.startFrame, request.startFrame + request.durationFrames - 1],
        pixelFormat: "yuv420p", cancelSignal: cancellation.cancelSignal,
        ...(wavServer ? { audioCodec: "aac" as const } : {}),
        disableSharedMemoryCapture: this.boundedTemporaryStorage, ...this.browserOptions,
        onProgress: p => this.report(request, p.renderedDoneIn === null ? "rendering" : "encoding", p.progress) });
      request.signal?.throwIfAborted();
      return { bytes: new Uint8Array(await readFile(output)), mediaType: "video/mp4", extension: "mp4", rendererId: this.id, rendererVersion: this.version };
    } finally {
      cancellation.dispose();
      try { await wavServer?.close(); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    }
  }
}

/** Opt-in renderer identity for snapshot-bound 2D trajectory playback. */
export class RemotionPendulumReplayRenderer extends RemotionProjectGraphRenderer {
  override readonly id = "remotion.pendulum-replay";
  override readonly supportsPendulumReplay = true;
  protected override replay(request: ProjectGraphPreviewRequest | ProjectGraphVideoRequest) { return preparePendulumReplay(request); }
}
