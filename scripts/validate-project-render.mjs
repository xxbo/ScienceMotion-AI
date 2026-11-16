import Ajv from "ajv";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const projectSchema = JSON.parse(await readFile("schemas/project.schema.json", "utf8"));
const fixture = JSON.parse(await readFile("examples/project-graph-demo.props.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateProject = ajv.compile(projectSchema);
if (!validateProject(fixture.project)) throw new Error("Project Graph render fixture failed Project Schema validation: " + JSON.stringify(validateProject.errors));

const file = process.argv[2] ?? "out/project-graph-demo.mp4";
const result = spawnSync("ffprobe", ["-v","error","-show_streams","-show_format","-of","json",file], { encoding:"utf8" });
if (result.status !== 0) { process.stderr.write(result.stderr || "ffprobe failed\\n"); process.exit(result.status ?? 1); }
const data = JSON.parse(result.stdout);
const video = data.streams?.find((stream) => stream.codec_type === "video");
const duration = Number(data.format?.duration);
const fps = video?.r_frame_rate;
const checks = [
  ["video stream exists", Boolean(video)],
  ["1920x1080", video?.width === 1920 && video?.height === 1080],
  ["30 FPS", fps === "30/1" || fps === "30/1.0"],
  ["10 second project sequence", duration >= 9.9 && duration <= 10.1],
];
for (const [label, passed] of checks) console.log((passed ? "PASS  " : "FAIL  ") + label);
console.log("File: " + file + "; duration: " + duration.toFixed(2) + "s; video: " + (video?.codec_name ?? "none"));
if (checks.some(([, passed]) => !passed)) process.exit(1);
