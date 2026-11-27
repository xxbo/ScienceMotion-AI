import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import reference from "../examples/pendulum-physics-reference.json";
import { preparePendulumMathShot } from "../src/platform/pendulum-math-shot";
import { decodePendulumTrajectory } from "../src/platform/pendulum-trajectory-artifact";
import { hashProject, type ProjectSnapshot } from "../src/platform/project-snapshots";
import { createPendulumReplayProject, replayProfile as profile, replayRange as range, replaySceneId, replaySnapshotId } from "./fixtures/pendulum-replay-project";
import { readRetainedLongPendulum } from "./fixtures/pendulum-retained-source";

const output = resolve("out/pendulum-math");
const previewFrames = [7, 51, 95];
const { width, height, fps } = profile;
const { startFrame, durationFrames } = range;
const stride = width * height * 3;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", profile, range };
type XY = [number, number];
const distance = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Independent pixel-space reference for the fixed Manim acceptance canvas and B's 30° release.
const projectAngle = (timeSeconds: number, radians: number): XY =>
  [58 + 361 * timeSeconds / 4, 204 - 132 * (radians * 180 / Math.PI) / 75];

function orangeCenter(rgb: Uint8Array): XY {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 132; y < 276; y++) for (let x = 52; x < 425; x++) {
    const i = 3 * (y * width + x), r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (r > 155 && r - g > 42 && g - b > 45) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
    }
  }
  assert.ok(count >= 25 && count <= 90 && maxX - minX >= 4 && maxX - minX <= 11 &&
    maxY - minY >= 4 && maxY - minY <= 11, "Expected one complete orange angle marker");
  return [(minX + maxX + 1) / 2, (minY + maxY + 1) / 2];
}

function cyanNear(rgb: Uint8Array, [x, y]: XY) {
  for (let row = Math.round(y) - 2; row <= Math.round(y) + 2; row++)
    for (let col = Math.round(x) - 2; col <= Math.round(x) + 2; col++) {
      const i = 3 * (row * width + col);
      if (rgb[i + 1] > 155 && rgb[i + 1] - rgb[i] > 60 && rgb[i + 2] > 135) return true;
    }
  return false;
}

function countBright(rgb: Uint8Array, x0: number, y0: number, x1: number, y1: number) {
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = 3 * (y * width + x);
    if (Math.min(rgb[i], rgb[i + 1], rgb[i + 2]) > 150) count++;
  }
  return count;
}

function inspectVideo(path: string) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v",
    "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", path], { encoding: "utf8", timeout: 15_000 }));
  assert.equal(probe.frames.length, durationFrames);
  for (const [i, frame] of probe.frames.entries()) assert.equal(Number(frame.best_effort_timestamp_time), i / fps);
  const { streams } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries",
    "stream=codec_name,codec_type,width,height,avg_frame_rate,nb_frames,duration,pix_fmt", "-of", "json", path], { encoding: "utf8", timeout: 15_000 }));
  assert.deepEqual(streams.map((s: Record<string, unknown>) => [s.codec_type, s.codec_name, s.width, s.height, s.avg_frame_rate,
    Number(s.nb_frames), Number(s.duration), s.pix_fmt]), [["video", "h264", width, height, "25/1", durationFrames, durationFrames / fps, "yuv420p"]]);
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe",
    "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24",
    "-f", "rawvideo", "pipe:1"], { timeout: 25_000, maxBuffer: stride * durationFrames + 1024 });
  assert.equal(rgb.length, stride * durationFrames);
  return rgb;
}

await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "sciencemotion-pendulum-math-"));
try {
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.checkout = checkout;
  const { bytes, identity } = await readRetainedLongPendulum(checkout);
  evidence.source = identity;
  const project = createPendulumReplayProject(identity.contentHash);
  const snapshot: ProjectSnapshot = { schemaVersion: "1.0.0", id: replaySnapshotId, projectId: project.project.id,
    createdAt: project.project.createdAt, contentHash: hashProject(project), document: project };
  const revisionId = project.revisions.at(-1)!.id;
  evidence.snapshot = { id: snapshot.id, revisionId, contentHash: snapshot.contentHash };
  const shot = preparePendulumMathShot({ project, revisionId, snapshotHash: snapshot.contentHash,
    sceneId: replaySceneId, ...range, pendulumTrajectory: bytes.toString("base64") });
  const { model, samples } = decodePendulumTrajectory(bytes);
  assert.equal(shot.source.artifactId, identity.artifactId);
  assert.deepEqual([shot.model, shot.profile, shot.range, shot.sampleRateHz], [reference.cases[1].model, profile, range, 240]);
  assert.deepEqual([shot.curve.length, shot.curve[0].timeSeconds, shot.curve.at(-1)!.timeSeconds], [961, 0, 4]);
  assert.deepEqual(shot.phases.map(phase => phase.phase), reference.cases[1].checkpoints.map(phase => phase.phase));
  const phaseErrors = shot.phases.map((phase, i) => {
    const target = reference.cases[1].checkpoints[i];
    const timeErrorSeconds = Math.abs(phase.timeSeconds - target.timeSeconds), angleErrorRadians = Math.abs(phase.angleRadians - target.angleRadians);
    assert.ok(timeErrorSeconds <= reference.solverAcceptance.periodAbsoluteErrorSeconds);
    assert.ok(angleErrorRadians <= reference.solverAcceptance.checkpointAngleAbsoluteErrorRadians);
    return { phase: phase.phase, timeErrorSeconds, angleErrorRadians };
  });
  assert.ok(shot.period.smallAngleSeconds < shot.period.measuredSeconds);
  assert.ok(Math.abs(shot.period.measuredSeconds - reference.cases[1].periodSeconds) <= reference.solverAcceptance.periodAbsoluteErrorSeconds);
  evidence.mathematics = { equation: "θ̈ + (g/L) sin θ = 0", model, period: shot.period, phases: shot.phases, phaseErrors };

  const payload = Buffer.from(JSON.stringify(shot) + "\n");
  const input = join(work, "manim-input.json"), video = join(work, "pendulum-math.mp4");
  await writeFile(input, payload);
  await Promise.all([json("snapshot.json", snapshot), writeFile(join(output, "trajectory.json"), bytes),
    writeFile(join(output, "manim-input.json"), payload)]);
  evidence.inputHash = sha(payload);
  const python = process.env.PENDULUM_MANIM_PYTHON ?? "python3";
  const logs = execFileSync(python, ["src/renderers/manim/pendulum_math_scene.py", input, video, join(work, "media")],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 });
  const runtime = JSON.parse(logs.trim().split("\n").at(-1)!);
  assert.deepEqual([runtime.manim, runtime.renderer], ["0.19.1", "cairo"]);
  evidence.renderer = { ...shot.renderer, runtime };

  const rgb = inspectVideo(video);
  const first = rgb.subarray(0, stride);
  // Verify the formula, both period readouts, and the plotted trace are visible in the decoded image.
  assert.ok(countBright(first, 390, 25, 616, 72) > 240, "The motion equation is missing");
  assert.ok(countBright(first, 461, 230, 604, 255) > 180 && countBright(first, 527, 288, 604, 310) > 40,
    "The measurements and small-angle comparison are missing");
  for (const i of [120, 240, 360, 480, 600, 720, 840]) {
    const { timeSeconds, angleRadians } = samples[i];
    assert.ok(cyanNear(first, projectAngle(timeSeconds, angleRadians)), "The cyan trajectory trace is missing");
  }
  const frameChecks = shot.frames.map((pose, index) => {
    assert.deepEqual([pose.sceneFrame, pose.timeSeconds], [startFrame + index, (startFrame + index) / fps]);
    const t = pose.timeSeconds, i = Math.floor(t * 240), a = samples[i], b = samples[i + 1];
    const independentAngle = a.angleRadians + (b.angleRadians - a.angleRadians) * (t - a.timeSeconds) / (b.timeSeconds - a.timeSeconds);
    assert.ok(Math.abs(pose.angleRadians - independentAngle) < 2e-5);
    const decoded = rgb.subarray(index * stride, (index + 1) * stride);
    assert.ok(countBright(decoded, 515, 139, 604, 158) > 50 && countBright(decoded, 515, 171, 604, 191) > 50,
      "The time and angle readouts must remain visible");
    const expected = projectAngle(t, independentAngle), measured = orangeCenter(decoded), errorPixels = distance(expected, measured);
    assert.ok(errorPixels <= 2, "Scene frame " + pose.sceneFrame + ": chart marker misses the retained angle by " + errorPixels + " px");
    return { outputFrame: index, ...pose, expected, measured, errorPixels };
  });
  assert.ok(distance(frameChecks[0].measured, projectAngle(0, samples[0].angleRadians)) > 20, "The nonzero export trim must not restart at release");
  const previewImages = [];
  for (const frame of previewFrames) {
    const i = frame - startFrame, pixels = rgb.subarray(i * stride, (i + 1) * stride);
    const png = PNG.sync.write({ width, height, data: pixels } as PNG, { inputColorType: 2, colorType: 2 });
    const name = "preview-" + frame + ".png";
    await writeFile(join(output, name), png);
    previewImages.push({ frame, file: name, sha256: sha(png) });
  }
  const videoBytes = await readFile(video);
  const maxMarkerErrorPixels = Math.max(...frameChecks.map(frame => frame.errorPixels));
  await Promise.all([json("frames.json", frameChecks), writeFile(join(output, "pendulum-math.mp4"), videoBytes)]);
  evidence.media = { file: "pendulum-math.mp4", codec: "h264", sha256: sha(videoBytes), rgbHash: sha(rgb), sizeBytes: videoBytes.length,
    durationSeconds: durationFrames / fps, frameCount: durationFrames, silent: true, previews: previewImages };
  evidence.comparison = { checkedFrames: durationFrames, maxMarkerErrorPixels, markerTolerancePixels: 2,
    physicalTimeSeconds: [frameChecks[0].timeSeconds, frameChecks.at(-1)!.timeSeconds] };
  evidence.status = "passed";
  console.log("Verified " + durationFrames + " Manim frames from the retained 2 m pendulum. Maximum chart marker error " +
    maxMarkerErrorPixels.toFixed(3) + " px. Measured period " + shot.period.measuredSeconds.toFixed(6) + " s.");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await json("evidence.json", evidence); }
  finally { await rm(work, { recursive: true, force: true }); }
}
