import { spawnSync } from "node:child_process";

const file = process.argv[2] ?? "out/science-motion-demo.mp4";
const result = spawnSync(
  "ffprobe",
  ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
  { encoding: "utf8" }
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || "ffprobe failed\n");
  process.exit(result.status ?? 1);
}

const metadata = JSON.parse(result.stdout);
const video = metadata.streams?.find((stream) => stream.codec_type === "video");
const audio = metadata.streams?.find((stream) => stream.codec_type === "audio");
const duration = Number(metadata.format?.duration);
const fps = video?.r_frame_rate;

const checks = [
  ["video stream exists", Boolean(video)],
  ["1920x1080", video?.width === 1920 && video?.height === 1080],
  ["30 FPS", fps === "30/1" || fps === "30/1.0"],
  ["audio stream exists", Boolean(audio)],
  ["duration between 50 and 70 seconds", duration >= 50 && duration <= 70],
];

for (const [label, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
}

console.log(`File: ${file}; duration: ${duration.toFixed(2)}s; video: ${video?.codec_name}; audio: ${audio?.codec_name ?? "none"}`);

if (checks.some(([, passed]) => !passed)) {
  process.exit(1);
}
