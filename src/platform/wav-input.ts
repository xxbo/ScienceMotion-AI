import type { PcmWavInfo } from "../contracts/project";

export const MAX_WAV_BYTES = 4 * 1024 * 1024;
export class WavInputError extends Error {
  constructor(readonly code: "HOST_WAV_INVALID" | "HOST_WAV_LIMIT", message: string) { super(message); }
}
const invalid = () => new WavInputError("HOST_WAV_INVALID", "Expected a complete 16-bit mono or stereo PCM WAV");

function supportedFormat(channels: number, sampleRate: number) {
  return (channels === 1 || channels === 2) && Number.isSafeInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000;
}

export function pcmWavInfo(metadata: Record<string, unknown> | undefined): PcmWavInfo | undefined {
  const { channels, sampleRate, sampleCount } = metadata ?? {};
  if (typeof channels !== "number" || typeof sampleRate !== "number" || !supportedFormat(channels, sampleRate) ||
      typeof sampleCount !== "number" || !Number.isSafeInteger(sampleCount) || sampleCount < 1 ||
      sampleCount * channels * 2 > MAX_WAV_BYTES - 44) return;
  return { channels, sampleRate, sampleCount };
}

/** Inspect bounded RIFF chunks, accepting ancillary chunks with their RIFF padding. */
export function readPcmWav(bytes: Uint8Array): PcmWavInfo {
  if (bytes.length > MAX_WAV_BYTES) throw new WavInputError("HOST_WAV_LIMIT", "WAV exceeds the supported byte limit");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || u32(4) + 8 !== bytes.length) throw invalid();
  let channels = 0, sampleRate = 0, sampleCount = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw invalid();
    const type = tag(offset), size = u32(offset + 4), body = offset + 8;
    offset = body + size + size % 2;
    if (offset > bytes.length) throw invalid();
    if (type === "fmt ") {
      if (channels || (size !== 16 && size !== 18) || (size === 18 && u16(body + 16) !== 0) || u16(body) !== 1) throw invalid();
      channels = u16(body + 2); sampleRate = u32(body + 4);
      const blockAlign = channels * 2;
      if (!supportedFormat(channels, sampleRate) || u16(body + 14) !== 16 || u16(body + 12) !== blockAlign ||
          u32(body + 8) !== sampleRate * blockAlign) throw invalid();
    } else if (type === "data") {
      if (!channels || sampleCount || !size || size % (channels * 2) !== 0) throw invalid();
      sampleCount = size / (channels * 2);
    }
  }
  if (!sampleCount) throw invalid();
  return { channels, sampleRate, sampleCount };
}
