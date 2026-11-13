import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const episodePath = process.argv[2] ?? "episodes/cpu-cache/episode.json";
const schemaPath = "schemas/episode.schema.json";
const [episodeText, schemaText] = await Promise.all([
  readFile(episodePath, "utf8"),
  readFile(schemaPath, "utf8"),
]);
const episode = JSON.parse(episodeText);
const schema = JSON.parse(schemaText);
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

if (!validate(episode)) {
  console.error("Episode schema validation failed:");
  for (const error of validate.errors ?? []) {
    console.error(`- ${error.instancePath || "/"}: ${error.message}`);
  }
  process.exit(1);
}

const errors = [];
const unique = (items, label) => {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) errors.push(`${label} contains duplicate IDs`);
  return new Set(ids);
};
const sourceIds = unique(episode.sources, "sources");
const claimIds = unique(episode.claims, "claims");
const narrationIds = unique(episode.narration, "narration");
const shotIds = unique(episode.shots, "shots");
const assetIds = unique(episode.assets, "assets");
unique(episode.audioCues, "audioCues");
unique(episode.captions, "captions");

for (const claim of episode.claims) {
  for (const id of claim.sourceIds) if (!sourceIds.has(id)) errors.push(`claim ${claim.id} references missing source ${id}`);
}
for (const narration of episode.narration) {
  for (const id of narration.claimIds) if (!claimIds.has(id)) errors.push(`narration ${narration.id} references missing claim ${id}`);
  if (narration.timing.endFrame <= narration.timing.startFrame) errors.push(`narration ${narration.id} has invalid frame range`);
  if (narration.timing.endFrame > episode.episode.durationFrames) errors.push(`narration ${narration.id} exceeds episode duration`);
}
let frameCursor = 0;
for (const shot of episode.shots) {
  for (const id of shot.narrationIds) if (!narrationIds.has(id)) errors.push(`shot ${shot.id} references missing narration ${id}`);
  frameCursor += shot.durationFrames;
}
if (frameCursor !== episode.episode.durationFrames) {
  errors.push(`shot durations total ${frameCursor} frames; episode declares ${episode.episode.durationFrames}`);
}
for (const cue of episode.audioCues) {
  if (cue.assetId && !assetIds.has(cue.assetId)) errors.push(`audio cue ${cue.id} references missing asset ${cue.assetId}`);
  if (cue.narrationId && !narrationIds.has(cue.narrationId)) errors.push(`audio cue ${cue.id} references missing narration ${cue.narrationId}`);
  if (cue.startFrame + (cue.durationFrames ?? 0) > episode.episode.durationFrames) errors.push(`audio cue ${cue.id} exceeds episode duration`);
}
for (const caption of episode.captions) {
  if (!narrationIds.has(caption.narrationId)) errors.push(`caption ${caption.id} references missing narration ${caption.narrationId}`);
  if (caption.startFrame !== undefined && caption.endFrame !== undefined && caption.endFrame <= caption.startFrame) errors.push(`caption ${caption.id} has invalid frame range`);
}
if (new Set(episode.shots.map((shot) => shot.id)).size !== shotIds.size) errors.push("shot ID integrity check failed");

if (errors.length) {
  console.error("Episode semantic validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Valid episode package: ${episode.episode.id}`);
console.log(`Schema: ${episode.schemaVersion}; shots: ${episode.shots.length}; claims: ${episode.claims.length}; narration segments: ${episode.narration.length}`);
console.log("Schema and cross-reference validation passed.");
