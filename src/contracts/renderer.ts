import type { EpisodePackage } from "./episode";

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
