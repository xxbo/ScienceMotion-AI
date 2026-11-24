import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { DeliveryProfile, DeliveryRange, DeliveryVideoEvidence } from "../contracts/creative-delivery";

type Stream = { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string;
  duration?: string; sample_rate?: string; channels?: number };
type Probe = { streams: Stream[]; format: { format_name: string; duration?: string } };
const run = promisify(execFile);

async function probe(file: string, signal: AbortSignal): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration,sample_rate,channels",
    "-of", "json", file], { signal, maxBuffer: 128 * 1024 });
  return JSON.parse(stdout) as Probe;
}

function decodedHash(file: string, args: string[], maximum: number, signal: AbortSignal): Promise<{ bytes: number; hash: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe",
      "-i", file, ...args, "pipe:1"], { signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
    const digest = createHash("sha256");
    let bytes = 0, error: Error | undefined, stderr = "";
    child.on("error", cause => { error ??= cause; });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (error) return;
      bytes += chunk.length;
      if (bytes > maximum) {
        error = new Error("Decoded media exceeded the admitted size");
        child.kill("SIGKILL");
      } else digest.update(chunk);
    });
    child.once("close", code => {
      if (error || code !== 0) reject(error ?? new Error(`FFmpeg could not decode the artifact ${stderr.trim()}`));
      else resolve({ bytes, hash: digest.digest("hex") });
    });
  });
}

function decodeVideo(file: string, pixelFormat: "rgba" | "rgb24", frameBytes: number, frames: number, signal: AbortSignal) {
  return decodedHash(file, ["-map", "0:v:0", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", pixelFormat,
    "-fps_mode", "passthrough", "-f", "rawvideo"], frameBytes * frames, signal);
}

export async function verifyDeliveryPreview(file: string, profile: DeliveryProfile, signal: AbortSignal): Promise<string> {
  const { streams } = await probe(file, signal);
  const [image] = streams;
  if (streams.length !== 1 || image.codec_type !== "video" || image.codec_name !== "png" || image.width !== profile.width || image.height !== profile.height)
    throw new Error("Preview is not a PNG with the approved dimensions");
  const frameBytes = profile.width * profile.height * 4;
  const decoded = await decodeVideo(file, "rgba", frameBytes, 1, signal);
  if (decoded.bytes !== frameBytes) throw new Error("Preview did not decode to one complete RGBA frame");
  return decoded.hash;
}

const within = (actual: number, expected: number, tolerance: number) => Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;

export async function verifyDeliveryVideo(file: string, profile: DeliveryProfile, range: DeliveryRange, requireAudio: boolean,
  signal: AbortSignal): Promise<DeliveryVideoEvidence> {
  const { streams, format } = await probe(file, signal);
  const video = streams.find(stream => stream.codec_type === "video");
  const audio = streams.find(stream => stream.codec_type === "audio");
  if (!format.format_name.split(",").includes("mp4") || !video || streams.length !== (audio ? 2 : 1) || (requireAudio && !audio))
    throw new Error("Export must contain one MP4 video stream and its required audio");
  const [numerator, denominator] = (video.avg_frame_rate ?? "").split("/").map(Number);
  const expectedSeconds = range.durationFrames / profile.fps;
  const durationSeconds = Number(video.duration);
  if (video.width !== profile.width || video.height !== profile.height || !within(numerator / denominator, profile.fps, 0.000001) ||
      !within(durationSeconds, expectedSeconds, 0.001)) throw new Error("Export profile or duration differs from the approved range");
  const frameBytes = profile.width * profile.height * 3;
  const decoded = await decodeVideo(file, "rgb24", frameBytes, range.durationFrames, signal);
  if (decoded.bytes !== frameBytes * range.durationFrames) throw new Error("Decoded video frame count differs from the approved range");
  const result: DeliveryVideoEvidence = { codec: video.codec_name, frames: range.durationFrames, durationSeconds, rgbHash: decoded.hash };

  let durationTolerance = 0.001;
  if (audio) {
    const sampleRate = Number(audio.sample_rate), channels = audio.channels ?? 0;
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || !Number.isSafeInteger(channels) || channels < 1)
      throw new Error("Export audio has an invalid sample rate or channel count");
    const expectedSamples = expectedSeconds * sampleRate;
    // AAC decoders can return the final padded block after the requested end.
    const padding = audio.codec_name === "aac" ? 1025 : 1;
    durationTolerance = Math.max(durationTolerance, padding / sampleRate);
    if (!within(Number(audio.duration), expectedSeconds, durationTolerance)) throw new Error("Export audio duration differs from the approved range");
    const sampleBytes = channels * 2;
    const pcm = await decodedHash(file, ["-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le"],
      (Math.ceil(expectedSamples) + padding) * sampleBytes, signal);
    const samples = pcm.bytes / sampleBytes;
    if (!Number.isSafeInteger(samples) || samples < 1 || !within(samples, expectedSamples, padding))
      throw new Error("Decoded audio sample count differs from the approved range");
    result.audio = { codec: audio.codec_name, sampleRate, channels, samples, pcmHash: pcm.hash };
  }
  if (!within(Number(format.duration), expectedSeconds, durationTolerance + 0.001))
    throw new Error("MP4 container duration differs from the approved range");
  return result;
}
