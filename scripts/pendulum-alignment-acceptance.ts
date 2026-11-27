import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import reference from "../examples/pendulum-physics-reference.json";
import { comparePendulumEvents, detectPendulumEvents, retainedPendulumEvents, type PendulumEventKind } from "../src/platform/pendulum-event-alignment";
import { readPendulumAlignmentInputs, sha256, type PendulumAlignmentView } from "./fixtures/pendulum-alignment-inputs";
import { replayProfile as profile, replayRange as range } from "./fixtures/pendulum-replay-project";

const output = resolve("out/pendulum-alignment"), { width, height, fps } = profile, { startFrame, durationFrames } = range;
const frameSeconds = 1 / fps, stride = width * height * 3;
const firstTime = startFrame / fps, lastTime = (startFrame + durationFrames - 1) / fps;
const tolerance = { eventSeconds: frameSeconds, angleRadians: 0.025, chartMarkerXPixels: 2 };
const chart = { left: 58, top: 138, right: 419, bottom: 270, centerY: 204, degreeSpan: 75, durationSeconds: 4 };
const pivot = [320, 151.2] as const, pixelsPerRod = 115.2;
const json = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const evidence: Record<string, unknown> = { schemaVersion: "1.0.0", status: "running", profile, range, tolerance };

function centerOfOrange(rgb: Uint8Array, view: PendulumAlignmentView): [number, number] {
  const isChart = view === "manim";
  const [x0, y0, x1, y1] = isChart ? [52, 132, 425, 276] : [245, 227, 395, 289];
  const [minimumR, rg, gb] = isChart ? [155, 42, 45] : [95, 25, 22];
  let count = 0, left = width, top = height, right = -1, bottom = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (r <= minimumR || r - g <= rg || g - b <= gb) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
  }
  const [minArea, maxArea, minSpan, maxSpan] = isChart ? [25, 90, 4, 11] : [300, 600, 18, 27];
  assert.ok(count >= minArea && count <= maxArea && right - left >= minSpan && right - left <= maxSpan &&
    bottom - top >= minSpan && bottom - top <= maxSpan, view + " has no complete orange marker.");
  return [(left + right + 1) / 2, (top + bottom + 1) / 2];
}

function inspectVideo(path: string, view: PendulumAlignmentView) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_frames",
    "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration,pix_fmt:frame=best_effort_timestamp_time",
    "-of", "json", path], { encoding: "utf8", timeout: 15_000 })) as {
    streams: Array<Record<string, unknown>>; frames: Array<{ best_effort_timestamp_time: string }>;
  };
  assert.deepEqual(probe.streams.map(s => [s.codec_type, s.codec_name, s.width, s.height, s.avg_frame_rate,
    Number(s.nb_frames), Number(s.duration), s.pix_fmt]),
  [["video", "h264", width, height, "25/1", durationFrames, durationFrames / fps, "yuv420p"]]);
  assert.equal(probe.frames.length, durationFrames);
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe",
    "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24",
    "-f", "rawvideo", "pipe:1"], { timeout: 25_000, maxBuffer: stride * durationFrames + 1024 });
  assert.equal(rgb.length, stride * durationFrames);
  const frames = probe.frames.map(({ best_effort_timestamp_time }, outputFrame) => {
    const ptsSeconds = Number(best_effort_timestamp_time), sceneFrame = startFrame + outputFrame;
    assert.equal(ptsSeconds, outputFrame / fps, view + " has a noncanonical presentation time.");
    const timeSeconds = sceneFrame / fps;
    const center = centerOfOrange(rgb.subarray(outputFrame * stride, (outputFrame + 1) * stride), view);
    let angleRadians: number;
    if (view === "manim") {
      const displayedX = chart.left + timeSeconds * (chart.right - chart.left) / chart.durationSeconds;
      assert.ok(Math.abs(center[0] - displayedX) <= tolerance.chartMarkerXPixels, "The Manim chart clock has drifted.");
      angleRadians = (chart.centerY - center[1]) * chart.degreeSpan / (chart.bottom - chart.top) * Math.PI / 180;
    } else {
      const x = center[0] - pivot[0], y = center[1] - pivot[1];
      assert.ok(y > 0 && Math.abs(Math.hypot(x, y) - pixelsPerRod) <= 2, view + " bob is off the retained arc.");
      angleRadians = Math.atan2(x, y);
    }
    return { outputFrame, sceneFrame, ptsSeconds, timeSeconds, center, angleRadians };
  });
  return { frames, rgbHash: sha256(rgb) };
}

const expectedKinds: PendulumEventKind[] = ["bottom-rightward", "turn-right", "bottom-leftward", "turn-left", "bottom-rightward"];
const labels = ["First rightward bottom crossing", "Right turn", "Leftward bottom crossing", "Turn at the release side", "Next rightward bottom crossing"];
const nearest = (timeSeconds: number) => ({ sceneFrame: Math.round(timeSeconds * fps), outputFrame: Math.round(timeSeconds * fps) - startFrame });
const viewNames = ["remotion", "three", "manim"] as const;

await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "sciencemotion-pendulum-alignment-"));
try {
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.checkout = checkout;
  const input = await readPendulumAlignmentInputs(checkout);
  evidence.source = input.source;
  evidence.snapshot = input.binding;
  evidence.upstreamReports = input.upstreamReports;
  const { trajectory } = input, { samples, timeStepSeconds } = trajectory, analytic = reference.cases[1];
  assert.deepEqual([trajectory.model, timeStepSeconds, trajectory.stepCount], [analytic.model, 1 / 240, 960]);
  const expected = retainedPendulumEvents(samples).filter(e => e.timeSeconds >= firstTime && e.timeSeconds <= lastTime);
  assert.deepEqual(expected.map(row => row.kind), expectedKinds);
  const targets = expected.map((row, i) => {
    const analyticTimeSeconds = (i + 1) * analytic.periodSeconds / 4;
    assert.ok(Math.abs(row.timeSeconds - analyticTimeSeconds) <= reference.solverAcceptance.periodAbsoluteErrorSeconds);
    return { ...row, id: i + 1, label: labels[i], analyticTimeSeconds, ...nearest(row.timeSeconds) };
  });
  evidence.clock = { physicalTimeSeconds: [firstTime, lastTime], ptsStartSeconds: 0, offsetSeconds: firstTime,
    excluded: [{ name: "release", timeSeconds: 0, reason: "before-export" }] };
  evidence.calibration = { motion: { pivot, pixelsPerRod }, manim: chart };
  evidence.reference = { model: trajectory.model, sampleRateHz: 240, sampleCount: samples.length };

  const witnesses = [];
  for (const item of input.media) {
    const file = item.view + ".mp4", path = join(work, file);
    await writeFile(path, item.bytes);
    const { frames, rgbHash } = inspectVideo(path, item.view);
    const maxAngleErrorRadians = Math.max(...frames.map(row => {
      const i = Math.floor(row.timeSeconds / timeStepSeconds), a = samples[i], b = samples[i + 1];
      const expectedAngle = a.angleRadians + (b.angleRadians - a.angleRadians) *
        (row.timeSeconds - a.timeSeconds) / (b.timeSeconds - a.timeSeconds);
      return Math.abs(row.angleRadians - expectedAngle);
    }));
    assert.ok(maxAngleErrorRadians <= tolerance.angleRadians, item.view + " has an angle inconsistent with the retained trajectory.");
    const events = detectPendulumEvents(frames, frameSeconds).map(row => ({ ...row, ...nearest(row.timeSeconds) }));
    witnesses.push({ view: item.view, frames, events, media: { renderer: item.renderer, file, sha256: item.sha256,
      sizeBytes: item.bytes.length, codec: "h264", frameCount: frames.length, durationSeconds: durationFrames / fps,
      rgbHash, maxAngleErrorRadians, receipt: item.receipt } });
  }
  const views = Object.fromEntries(witnesses.map(({ view, events }) => [view, events]));
  const alignment = comparePendulumEvents(targets, views, tolerance.eventSeconds);
  const referencePeriodSeconds = targets[4].timeSeconds - targets[0].timeSeconds;
  const observedPeriodsSeconds = Object.fromEntries(witnesses.map(({ view, events }) => [view, events[4].timeSeconds - events[0].timeSeconds]));
  const periods = Object.values(observedPeriodsSeconds);
  const maxPeriodErrorSeconds = Math.max(...periods.map(period => Math.abs(period - referencePeriodSeconds)));
  const periodSpreadSeconds = Math.max(...periods) - Math.min(...periods);
  assert.ok(maxPeriodErrorSeconds <= frameSeconds && periodSpreadSeconds <= frameSeconds, "The observed full cycles must agree within one frame.");

  // Keep the real decoded clock and event order, but advance only Manim's pixels by three frames.
  // This must fail the timing gate itself, not a source hash or missing-event check.
  const chartFrames = witnesses.find(row => row.view === "manim")!.frames;
  const shiftedFrames = chartFrames.map((row, i) => ({ ...row, angleRadians: chartFrames[Math.min(i + 3, chartFrames.length - 1)].angleRadians }));
  const shiftedEvents = detectPendulumEvents(shiftedFrames, frameSeconds);
  assert.deepEqual(shiftedEvents.map(row => row.kind), expectedKinds);
  assert.throws(() => comparePendulumEvents(targets, { ...views, manim: shiftedEvents }, frameSeconds), /timing tolerance/);
  evidence.negativeControl = { view: "manim", advanceFrames: 3, preservedKinds: expectedKinds, rejectedBy: "event timing tolerance" };

  const maxEventSpreadSeconds = Math.max(...alignment.map(row => row.spreadSeconds));
  const maxReferenceErrorSeconds = Math.max(...alignment.map(row => row.maxReferenceErrorSeconds));
  evidence.events = alignment;
  evidence.media = Object.fromEntries(witnesses.map(({ view, media }) => [view, media]));
  evidence.period = { referencePeriodSeconds, observedPeriodsSeconds, maxPeriodErrorSeconds, periodSpreadSeconds };
  evidence.comparison = { verifiedClips: 3, framesPerClip: durationFrames, matchedEvents: alignment.length,
    maxEventSpreadSeconds, maxReferenceErrorSeconds };
  const ms = (s: number) => (1000 * s).toFixed(2), seconds = (s: number) => s.toFixed(4);
  const report = ["# P2.3-E pendulum alignment", "",
    "Three independently decoded 640 × 360 H.264 clips, 25 fps, source frames 7–95. Times are seconds from release. The release at 0 s is outside the export.", "",
    "| Visible event | Retained time (s) | Nearest scene frame | Remotion (s) | Three.js (s) | Manim (s) | Spread (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...alignment.map(({ reference, observed, spreadSeconds }) =>
      "| " + [reference.label, seconds(reference.timeSeconds), reference.sceneFrame, ...viewNames.map(view => seconds(observed[view].timeSeconds)),
        ms(spreadSeconds)].join(" | ") + " |"),
    "", "Maximum inter-view spread " + ms(maxEventSpreadSeconds) + " ms. Maximum offset from the retained event " + ms(maxReferenceErrorSeconds) +
      " ms. One-frame tolerance 40 ms.", "",
    "Full cycle estimated from the two rightward crossings in each clip. Retained " + seconds(referencePeriodSeconds) + " s. " +
      viewNames.map(view => view + " " + seconds(observedPeriodsSeconds[view]) + " s").join(", ") + ".", "",
    "Times are estimates from 25 fps images, using linear zero-crossing interpolation and an 11-frame quadratic fit for turns. " +
      "They do not imply sub-frame capture precision.", ""].join("\n");
  await Promise.all([
    ...input.media.map(item => writeFile(join(output, item.view + ".mp4"), item.bytes)),
    writeFile(join(output, "snapshot.json"), input.snapshotBytes), writeFile(join(output, "trajectory.json"), input.trajectoryBytes),
    json("frames.json", Object.fromEntries(witnesses.map(({ view, frames }) => [view, frames]))),
    writeFile(join(output, "report.md"), report),
  ]);
  evidence.status = "passed";
  console.log("Verified " + alignment.length + " events across " + witnesses.length + " decoded clips. Maximum inter-view spread " +
    ms(maxEventSpreadSeconds) + " ms, maximum retained offset " + ms(maxReferenceErrorSeconds) + " ms (one frame = 40 ms).");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try { await json("evidence.json", evidence); }
  finally { await rm(work, { recursive: true, force: true }); }
}
