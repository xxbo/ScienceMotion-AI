import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createEmptyProject } from "./empty-project";
import { readPcmWav, MAX_WAV_BYTES } from "./wav-input";
import { verifiedRenderWavAssets } from "./wav-render-inputs";

function wave(sampleCount = 1) {
  const bytes = Buffer.alloc(54 + sampleCount * 4);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEJUNK", 8);
  bytes.writeUInt32LE(1, 16); bytes[20] = 10;
  bytes.write("fmt ", 22); bytes.writeUInt32LE(16, 26); bytes.writeUInt16LE(1, 30); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt32LE(48_000, 34); bytes.writeUInt32LE(192_000, 38); bytes.writeUInt16LE(4, 42); bytes.writeUInt16LE(16, 44);
  bytes.write("data", 46); bytes.writeUInt32LE(sampleCount * 4, 50);
  return bytes;
}

test("PCM WAV validation checks RIFF padding, format and complete sample frames", () => {
  const bytes = wave();
  assert.deepEqual(readPcmWav(bytes), { sampleRate: 48_000, channels: 2, sampleCount: 1 });
  assert.throws(() => readPcmWav(bytes.subarray(0, -1)), /complete 16-bit/);
  const compressed = Buffer.from(bytes);
  compressed.writeUInt16LE(3, 30);
  assert.throws(() => readPcmWav(compressed), /complete 16-bit/);
  const invalidAlign = Buffer.from(bytes);
  invalidAlign.writeUInt16LE(2, 42);
  assert.throws(() => readPcmWav(invalidAlign), /complete 16-bit/);
  assert.throws(() => readPcmWav(Buffer.alloc(MAX_WAV_BYTES + 1)), /supported byte limit/);
});

test("render audio verifies only the requested range's bytes, hashes and PCM metadata", () => {
  const bytes = wave(1600);
  const hash = createHash("sha256").update(bytes).digest("hex"), id = `sha256:${hash}`;
  const project = createEmptyProject({ id: "p", name: "P", episodeId: "e", durationFrames: 10 });
  project.assets.push({ id: "wave", kind: "audio", uri: `artifact://sha256/${hash}`, contentHash: hash,
    metadata: { mediaType: "audio/wav", ...readPcmWav(bytes) } });
  project.sequences[0].trackIds = ["voice"];
  project.tracks = [{ id: "voice", name: "Voice", kind: "audio", clipIds: ["clip"] }];
  project.clips = [{ id: "clip", assetId: "wave", startFrame: 3, durationFrames: 1 }];
  const range = { project, revisionId: "r", snapshotHash: "hash", startFrame: 3, durationFrames: 1 };
  const request = { ...range, audioAssets: { [id]: bytes.toString("base64") } };
  assert.deepEqual(verifiedRenderWavAssets(request).files.get(id), bytes);
  assert.equal(verifiedRenderWavAssets({ ...range, startFrame: 4 }).files.size, 0);
  assert.equal(verifiedRenderWavAssets({ ...range, sceneId: "scene" }).files.size, 0);
  assert.throws(() => verifiedRenderWavAssets(range), /does not match/);
  const swapped = Buffer.from(bytes);
  swapped[54] = 1;
  assert.throws(() => verifiedRenderWavAssets({ ...range, audioAssets: { [id]: swapped.toString("base64") } }), /snapshot hash/);
  project.assets[0].metadata!.sampleCount = 1601;
  assert.throws(() => verifiedRenderWavAssets(request), /hash or metadata/);
});
