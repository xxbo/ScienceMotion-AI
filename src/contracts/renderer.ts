import type { EpisodePackage } from "./episode";
import type { ProjectDocument } from "./project";
import type { LayoutFrameMeasurement } from "./layout-inspection";

export interface RendererCapabilities {
  sceneTypes: string[];
  outputFormats: string[];
  supportsAudio: boolean;
  supportsCaptions: boolean;
}

export interface RenderRequest {
  episode: EpisodePackage;
  outputPath: string;
  profile?: { width: number; height: number; fps?: number };
}

export interface RenderResult {
  rendererId: string;
  rendererVersion: string;
  episodeId: string;
  schemaVersion: EpisodePackage["schemaVersion"];
  outputPath: string;
  diagnostics: Array<{ level: "info" | "warning" | "error"; code: string; message: string }>;
}

/**
 * Renderer adapters consume approved episode packages.
 * Implementations must not call language models or mutate the input package.
 */
export interface EpisodeRenderer {
  readonly id: string;
  readonly version: string;
  readonly supportedSchemaVersions: string[];
  readonly capabilities: RendererCapabilities;
  render(request: RenderRequest): Promise<RenderResult>;
}


/** Renderer contract for immutable Project Graph snapshots; editorial generation stays upstream. */
export interface ProjectRenderRequest {
  project: ProjectDocument; revisionId: string; snapshotHash: string; outputPath: string;
  sceneId?: string; startFrame: number; durationFrames: number;
  profile?: { width: number; height: number; fps?: number };
}
export interface ProjectRenderResult {
  rendererId: string; rendererVersion: string; projectId: string; revisionId: string;
  snapshotHash: string; outputPath: string;
  diagnostics: Array<{ level: "info" | "warning" | "error"; code: string; message: string }>;
}
export interface ProjectGraphRenderer {
  readonly id: string; readonly version: string; readonly supportedProjectSchemaVersions: string[];
  render(request: ProjectRenderRequest): Promise<ProjectRenderResult>;
}


/** Immutable Project Graph render contract; renderers never rewrite editorial meaning. */
export interface ProjectGraphRenderProgress { phase: "bundling" | "selecting" | "rendering" | "encoding"; fraction?: number }
export interface ProjectGraphRenderRequest {
  project: ProjectDocument; revisionId: string; snapshotHash: string; sceneId?: string;
  /** Immutable PNG bytes in base64, keyed by the snapshot's canonical artifact IDs. */
  imageAssets?: Readonly<Record<string, string>>;
  profile?: { width: number; height: number; fps?: number }; signal?: AbortSignal; onProgress?: (progress: ProjectGraphRenderProgress) => void;
}
export interface ProjectGraphPreviewRequest extends ProjectGraphRenderRequest { frame: number }
export interface ProjectGraphVideoRequest extends ProjectGraphRenderRequest {
  startFrame: number; durationFrames: number;
  /** Immutable PCM WAV bytes in base64, keyed by the requested range's artifact IDs. */
  audioAssets?: Readonly<Record<string, string>>;
}
/** Final cgroup counters for the enabled resource controls, in decimal to preserve kernel precision. */
export interface RenderWorkerResourceUsage {
  cpuUsageUsec?: string;
  cpuThrottledPeriods?: string;
  memoryOomEvents?: string;
  memoryOomKills?: string;
  temporaryCapacityBytes?: string;
  temporaryMinimumAvailableBytes?: string;
  temporaryMinimumAvailableInodes?: string;
}
export interface ProjectGraphRenderOutput { bytes: Uint8Array; mediaType: "image/png" | "video/mp4"; extension: "png" | "mp4"; rendererId: string; rendererVersion: string;
  execution?: { kind: "local-process"; protocolVersion: "1.0.0"; jobId: string; processId: number; elapsedMs: number; resourceUsage?: RenderWorkerResourceUsage } }
export interface ProjectGraphLayoutRequest extends ProjectGraphRenderRequest { frames: number[]; signal?: AbortSignal }
export interface ProjectGraphSnapshotRenderer { readonly id: string; readonly version: string; renderPreview(request: ProjectGraphPreviewRequest): Promise<ProjectGraphRenderOutput>; renderVideo(request: ProjectGraphVideoRequest): Promise<ProjectGraphRenderOutput>; measureLayout?(request: ProjectGraphLayoutRequest): Promise<LayoutFrameMeasurement[]> }

/** A renderer diagnostic that is safe to return through foreground tools and render jobs. */
export class ProjectGraphRendererError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectGraphRendererError";
  }
}
