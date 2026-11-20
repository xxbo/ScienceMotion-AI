import { createHash } from "node:crypto";
import type { ArtifactStore } from "../contracts/artifact";
import type { PcmWavInfo } from "../contracts/project";
import type { ProjectGraphVideoRequest } from "../contracts/renderer";
import { firstSequenceAudioClips } from "./project-timeline";
import { MAX_WAV_BYTES, readPcmWav, WavInputError } from "./wav-input";

const limit = () => new WavInputError("HOST_WAV_LIMIT", "Render WAV inputs exceed their aggregate byte limit");
const invalid = (message: string) => new WavInputError("HOST_WAV_INVALID", message);
const sameInfo = (a: PcmWavInfo, b: PcmWavInfo) =>
  a.channels === b.channels && a.sampleRate === b.sampleRate && a.sampleCount === b.sampleCount;

function requestAudio(request: ProjectGraphVideoRequest) {
  const end = request.startFrame + request.durationFrames;
  const clips = request.sceneId ? [] : firstSequenceAudioClips(request.project)
    .filter(({ clip }) => clip.startFrame < end && clip.startFrame + clip.durationFrames > request.startFrame);
  const sources = new Map<string, PcmWavInfo>();
  for (const { source } of clips) {
    const prior = sources.get(source.artifactId);
    if (prior && !sameInfo(prior, source)) throw invalid("Conflicting snapshot metadata for the same WAV artifact");
    sources.set(source.artifactId, source);
  }
  return { clips, sources };
}

export async function loadRenderWavAssets(request: ProjectGraphVideoRequest, artifacts: Pick<ArtifactStore, "get" | "read">) {
  const { sources } = requestAudio(request);
  if (!sources.size) return;
  let remaining = MAX_WAV_BYTES;
  const assets: Record<string, string> = {};
  for (const [id, info] of sources) {
    request.signal?.throwIfAborted();
    const record = await artifacts.get(id);
    if (record?.kind !== "audio" || record.mediaType !== "audio/wav") throw invalid("Snapshot WAV artifact is missing or has an incompatible type");
    if (record.sizeBytes > remaining) throw limit();
    const bytes = await artifacts.read(id);
    if (!bytes || bytes.length !== record.sizeBytes || !sameInfo(info, readPcmWav(bytes)))
      throw invalid("Snapshot WAV bytes differ from the stored audio metadata");
    remaining -= bytes.length;
    assets[id] = Buffer.from(bytes).toString("base64");
  }
  request.signal?.throwIfAborted();
  return assets;
}

/** Verify the exact range's input bytes again inside the selected renderer. */
export function verifiedRenderWavAssets(request: ProjectGraphVideoRequest) {
  const { clips, sources } = requestAudio(request), assets = request.audioAssets ?? {};
  if (Object.keys(assets).length !== sources.size) throw invalid("Render WAV payload does not match the requested snapshot range");
  const files = new Map<string, Buffer>();
  let remaining = MAX_WAV_BYTES;
  for (const [id, info] of sources) {
    request.signal?.throwIfAborted();
    const encoded = assets[id];
    if (!Object.hasOwn(assets, id) || typeof encoded !== "string") throw invalid("Render WAV payload is missing a snapshot asset");
    if (encoded.length > 4 * Math.ceil(remaining / 3)) throw limit();
    const bytes = Buffer.from(encoded, "base64");
    remaining -= bytes.length;
    if (remaining < 0) throw limit();
    if (bytes.toString("base64") !== encoded || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== id ||
        !sameInfo(info, readPcmWav(bytes))) throw invalid("Render WAV payload differs from the snapshot hash or metadata");
    files.set(id, bytes);
  }
  return { clips, files };
}
