export type Confidence = "high" | "medium" | "low" | "illustrative";
export type AudioCueType = "narration" | "music" | "sfx";
export type AssetMediaType = "image" | "audio" | "video" | "model" | "font" | "other";

export interface EpisodePackage {
  schemaVersion: "1.0.0";
  episode: {
    id: string;
    title: string;
    language: string;
    audience: string;
    durationFrames: number;
    fps: number;
    outputProfile: { width: number; height: number; aspectRatio?: string };
  };
  sources: Array<{
    id: string; title: string; publisher: string; url: string;
    publishedAt?: string; retrievedAt: string; license?: string;
  }>;
  claims: Array<{
    id: string; statement: string; sourceIds: string[];
    confidence: Confidence; caveats: string[];
    value?: number; unit?: string;
  }>;
  narration: Array<{
    id: string; text: string; claimIds: string[];
    voiceDirection?: string;
    timing: { startFrame: number; endFrame: number };
  }>;
  shots: Array<{
    id: string; sceneType: string; durationFrames: number;
    narrationIds: string[];
    sceneIntent: { summary: string; data?: Record<string, unknown> };
    transition: string;
  }>;
  assets: Array<{
    id: string; mediaType: AssetMediaType; uri: string;
    contentHash?: string; license?: string; attribution?: string;
  }>;
  audioCues: Array<{
    id: string; type: AudioCueType; assetId?: string; narrationId?: string;
    startFrame: number; durationFrames?: number; gain: number; ducking?: boolean;
  }>;
  captions: Array<{
    id: string; narrationId: string; text: string;
    startFrame?: number; endFrame?: number;
  }>;
}
