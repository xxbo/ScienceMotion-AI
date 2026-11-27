import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RetainedShotSegment } from "../contracts/retained-shot-segment";
import { SHOT_CUT_VERSION, type ShotCutFrame, type ShotCutPlan, type ShotCutReport, type ShotCutSpan } from "../contracts/shot-cut";
import { parseRetainedShotSegment, type RetainedShotSegmentStore } from "./retained-shot-segment";

const run = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const idPattern = /^sha256:[a-f0-9]{64}$/;
const ticksPerFrame = 1000;
const ffmpegBase = ["-v", "error", "-xerror", "-nostdin", "-protocol_whitelist", "file,pipe"];

export class ShotCutError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ShotCutError";
  }
}
function fail(code: string, message: string): never {
  throw new ShotCutError("SHOT_CUT_" + code, message);
}

export function planShotCut(sources: readonly { id: string; segment: RetainedShotSegment }[]): ShotCutPlan {
  if (sources.length !== 2 || sources.some(source => !idPattern.test(source.id)))
    fail("INPUT", "Provide two ordered retained segment IDs.");
  // No dependency on engine, snapshot or scope identity. The native clock and geometry must agree.
  const [first, second] = sources.map(source => parseRetainedShotSegment(source.segment));
  const profile = first.profile;
  if (profile.width !== second.profile.width || profile.height !== second.profile.height || profile.fps !== second.profile.fps)
    fail("PROFILE", "A stream-copy cut needs the same native width, height and frame rate.");
  const span = (index: number, segment: RetainedShotSegment, startFrame: number): ShotCutSpan => ({
    segmentId: sources[index].id, projectId: segment.projectId, source: segment.source, renderer: segment.renderer,
    mediaArtifactId: segment.media.artifactId, output: { startFrame, durationFrames: segment.media.frameCount },
  });
  return { schemaVersion: SHOT_CUT_VERSION, profile, durationFrames: first.media.frameCount + second.media.frameCount,
    spans: [span(0, first, 0), span(1, second, first.media.frameCount)] };
}

export function locateShotCutFrame(plan: ShotCutPlan, outputFrame: number): ShotCutFrame {
  if (!Number.isSafeInteger(outputFrame) || outputFrame < 0 || outputFrame >= plan.durationFrames)
    fail("RANGE", "The frame is outside the cut.");
  const current = plan.spans.find(({ output }) => outputFrame >= output.startFrame && outputFrame < output.startFrame + output.durationFrames);
  if (!current) fail("RANGE", "The frame has no retained source.");
  const mediaFrame = outputFrame - current.output.startFrame;
  return { outputFrame, segmentId: current.segmentId, mediaFrame, sourceFrame: current.source.range.startFrame + mediaFrame };
}

/** An ordinal comparison, not a set or a sample-based similarity check. */
export function assertShotCutFrames(plan: ShotCutPlan, expected: readonly (readonly string[])[], actual: readonly string[]): void {
  if (expected.length !== plan.spans.length || expected.some((part, i) => part.length !== plan.spans[i].output.durationFrames) ||
      actual.length !== plan.durationFrames)
    fail("FRAMES", "Decoded frame counts do not match the cut or its retained segments.");
  for (const [i, { output }] of plan.spans.entries()) {
    for (let j = 0; j < output.durationFrames; j++) {
      const frame = output.startFrame + j;
      if (actual[frame] !== expected[i][j])
        fail("FRAMES", "Decoded output frame " + frame + " differs from retained segment " + (i + 1) + " frame " + j + ".");
    }
  }
}

const childOptions = (signal: AbortSignal) => ({ signal, maxBuffer: 512 * 1024, killSignal: "SIGKILL" as const });

async function frameHashes(path: string, plan: ShotCutPlan, signal: AbortSignal) {
  const { stdout } = await run("ffmpeg", [...ffmpegBase, "-threads", "1", "-i", path, "-map", "0:v:0",
    "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24",
    "-f", "framehash", "-hash", "sha256", "pipe:1"], childOptions(signal));
  return stdout.trim().split("\n").filter(line => line.trim() && !line.startsWith("#")).map(line => {
    const [stream, , , , frameBytes, hash, ...extra] = line.split(",").map(s => s.trim());
    if (stream !== "0" || Number(frameBytes) !== plan.profile.width * plan.profile.height * 3 ||
        !/^[a-f0-9]{64}$/.test(hash ?? "") || extra.length)
      fail("FRAMES", "Unexpected decoded frame evidence.");
    return hash;
  });
}

type Probe = {
  streams: {
    codec_type: string; codec_name: string; codec_tag_string: string; pix_fmt: string; width: number; height: number;
    avg_frame_rate: string; time_base: string; start_pts: number; duration_ts: number; nb_frames: string;
  }[];
  frames: { best_effort_timestamp: number }[];
};

async function verifyCutClock(path: string, plan: ShotCutPlan, timescale: number, signal: AbortSignal): Promise<void> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_frames", "-show_entries",
    "stream=codec_type,codec_name,codec_tag_string,pix_fmt,width,height,avg_frame_rate,time_base,start_pts,duration_ts,nb_frames:frame=best_effort_timestamp",
    "-of", "json", path], childOptions(signal));
  const { streams, frames } = JSON.parse(stdout) as Probe;
  const [video] = streams, { width, height, fps } = plan.profile, count = plan.durationFrames;
  if (streams.length !== 1 || video.codec_type !== "video" || video.codec_name !== "h264" || video.codec_tag_string !== "avc3" ||
      video.pix_fmt !== "yuv420p" || video.width !== width || video.height !== height || video.avg_frame_rate !== fps + "/1" ||
      video.time_base !== "1/" + timescale || video.start_pts !== 0 || video.duration_ts !== count * ticksPerFrame ||
      Number(video.nb_frames) !== count || frames.length !== count || frames.some((row, i) => row.best_effort_timestamp !== i * ticksPerFrame))
    fail("CLOCK", "The cut must be one silent H.264 track with its exact zero-based native presentation clock.");
}

/** Join whole, verified A segments without re-encoding. Return bytes only after full decode and timing verification. */
export async function assembleShotCut(
  store: Pick<RetainedShotSegmentStore, "read">, segmentIds: readonly string[], signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; report: ShotCutReport }> {
  const ids = [...segmentIds];
  if (ids.length !== 2 || ids.some(id => !idPattern.test(id))) fail("INPUT", "Provide two ordered retained segment IDs.");
  const deadline = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  deadline.throwIfAborted();
  const entries = [];
  for (const id of ids) {
    const entry = await store.read(id);
    deadline.throwIfAborted();
    if (entry.record.id !== id || "sha256:" + sha(entry.descriptorBytes) !== id ||
        entry.segment.media.sizeBytes !== entry.videoBytes.byteLength || sha(entry.videoBytes) !== entry.segment.media.contentHash)
      fail("SOURCE", "Retained bytes do not match the requested segment.");
    entries.push({ ...entry, id });
  }
  const plan = planShotCut(entries), timescale = plan.profile.fps * ticksPerFrame;
  const work = await mkdtemp(join(tmpdir(), "sciencemotion-shot-cut-"));
  try {
    const expected = [], ffconcat = ["ffconcat version 1.0"];
    for (const [i, entry] of entries.entries()) {
      const input = join(work, "original-" + i + ".mp4"), name = "span-" + i + ".mp4";
      await writeFile(input, entry.videoBytes, { signal: deadline });
      expected.push(await frameHashes(input, plan, deadline));
      // Different engines can emit different MP4 track time bases for the same native FPS.
      await run("ffmpeg", [...ffmpegBase, "-i", input, "-map", "0:v:0", "-c:v", "copy", "-map_metadata", "-1",
        "-video_track_timescale", String(timescale), join(work, name)], childOptions(deadline));
      ffconcat.push("file " + name, "duration " + (plan.spans[i].output.durationFrames / plan.profile.fps).toFixed(9));
    }
    const order = join(work, "cut.ffconcat"), output = join(work, "cut.mp4");
    await writeFile(order, ffconcat.join("\n") + "\n", { signal: deadline });
    // Concat's MP4-to-Annex-B conversion carries each clip's H.264 parameter sets in-band.
    await run("ffmpeg", [...ffmpegBase, "-f", "concat", "-safe", "1", "-auto_convert", "1", "-i", order,
      "-map", "0:v:0", "-c:v", "copy", "-tag:v", "avc3", "-map_metadata", "-1", "-movflags", "+faststart",
      "-video_track_timescale", String(timescale), "-movie_timescale", String(timescale), output], childOptions(deadline));
    await verifyCutClock(output, plan, timescale, deadline);
    const actual = await frameHashes(output, plan, deadline);
    assertShotCutFrames(plan, expected, actual);
    const bytes = await readFile(output, { signal: deadline });
    const nextFrame = plan.spans[1].output.startFrame;
    const witness = (frame: number) => ({ ...locateShotCutFrame(plan, frame), rgbHash: actual[frame] });
    return { bytes, report: { plan,
      media: { mediaType: "video/mp4", codec: "h264", sampleEntry: "avc3", pixelFormat: "yuv420p", silent: true,
        contentHash: sha(bytes), sizeBytes: bytes.length, frameCount: actual.length,
        durationSeconds: plan.durationFrames / plan.profile.fps, timescale },
      verification: { mode: "stream-copy", allDecodedFramesMatch: true, rgbFrameHashes: actual,
        seam: { before: witness(nextFrame - 1), after: witness(nextFrame) } },
    } };
  } catch (error) {
    deadline.throwIfAborted();
    if (error instanceof ShotCutError) throw error;
    fail("MEDIA", error instanceof Error ? error.message : "Unable to assemble verified retained videos.");
  } finally { await rm(work, { recursive: true, force: true }); }
}
