import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Ajv from "ajv";
import schema from "../../schemas/retained-shot-segment.schema.json";
import type { ArtifactRecord, ArtifactStore } from "../contracts/artifact";
import type { RenderJobReceipt, RenderJobRecord } from "../contracts/render-job";
import { RETAINED_SHOT_SEGMENT_VERSION, type RetainedShotSegment } from "../contracts/retained-shot-segment";
import type { LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { verifyDeliveryVideo } from "./creative-delivery-media";
import { assertFiniteJson } from "./project-creative-edits";
import { hashProject, type ProjectSnapshot } from "./project-snapshots";
import { readVerifiedJobArtifact } from "./render-job-output";
import { validateJobRecord } from "./render-job-validation";

const validate = new Ajv({ ownProperties: true }).compile<RetainedShotSegment>(schema);
const manifestLimit = 16 * 1024, snapshotLimit = 8 * 1024 * 1024 + manifestLimit;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const artifactId = (bytes: Uint8Array) => "sha256:" + sha256(bytes);
const dataMediaType = "application/json";
const run = promisify(execFile);

export class RetainedShotSegmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RetainedShotSegmentError";
  }
}
function fail(code: string, message: string): never {
  throw new RetainedShotSegmentError("SHOT_SEGMENT_" + code, message);
}

export function parseRetainedShotSegment(value: unknown): RetainedShotSegment {
  try { assertFiniteJson(value); }
  catch { fail("SCHEMA", "Segment descriptors must be finite JSON."); }
  if (!validate(value)) {
    const e = validate.errors![0];
    fail("SCHEMA", (e.instancePath || "/") + " " + e.message);
  }
  const { range } = value.source;
  if (!Number.isSafeInteger(range.startFrame + range.durationFrames) || value.media.frameCount !== range.durationFrames)
    fail("RANGE", "The half-open source range must match the full decoded frame count.");
  if (value.media.artifactId !== "sha256:" + value.media.contentHash)
    fail("INTEGRITY", "The media ID must equal its content hash.");
  return structuredClone(value);
}

function encodeJson(value: unknown, limit: number) {
  const text = JSON.stringify(value, (_key, data: unknown) =>
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.fromEntries(Object.entries(data).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : data) + "\n";
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limit) fail("SCHEMA", "The retained JSON exceeds its byte limit.");
  return bytes;
}
function decodeJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("SCHEMA", "Retained JSON is unreadable."); }
}

type Source = RetainedShotSegment["source"];
type Profile = RetainedShotSegment["profile"];
function verifySource(snapshot: ProjectSnapshot, projectId: string, source: Source, profile: Profile) {
  const document = snapshot?.document, declared = source.snapshot;
  if (!document || !Array.isArray(document.sequences) || !Array.isArray(document.scenes) || !Array.isArray(document.revisions) ||
      document.schemaVersion !== "1.1.0" || snapshot.schemaVersion !== document.schemaVersion || !Number.isFinite(Date.parse(snapshot.createdAt)) ||
      snapshot.projectId !== projectId || document.project?.id !== projectId || declared.id !== snapshot.id ||
      declared.revisionId !== document.revisions.at(-1)?.id || snapshot.contentHash !== declared.contentHash ||
      hashProject(document) !== declared.contentHash)
    fail("SOURCE", "Use the exact project, immutable snapshot, revision and content hash from the job.");
  const sequence = document.sequences[0], { scope, range } = source;
  if (!sequence || profile.width !== sequence.width || profile.height !== sequence.height || profile.fps !== sequence.fps)
    fail("PROFILE", "The segment profile must be the snapshot's native profile.");
  const selection = scope.kind === "sequence" ? sequence : document.scenes.find(scene => scene.id === scope.id);
  if (!selection || selection.id !== scope.id || !Number.isSafeInteger(selection.durationFrames) ||
      !Number.isSafeInteger(sequence.durationFrames) || range.startFrame + range.durationFrames > Math.min(selection.durationFrames, sequence.durationFrames))
    fail("RANGE", "The segment range is outside the admitted source selection.");
}

async function verifyMp4(bytes: Uint8Array, profile: Profile, range: Source["range"], signal: AbortSignal) {
  const work = await mkdtemp(join(tmpdir(), "sciencemotion-shot-segment-"));
  try {
    const path = join(work, "segment.mp4");
    await writeFile(path, bytes, { signal });
    const decoded = await verifyDeliveryVideo(path, profile, range, false, signal);
    if (decoded.codec !== "h264" || decoded.audio) fail("MEDIA", "A v1 segment requires a silent H.264 MP4.");
    const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
      "-show_frames", "-show_entries", "stream=pix_fmt,time_base:frame=best_effort_timestamp", "-of", "json", path],
    { signal, maxBuffer: 512 * 1024 });
    const probe = JSON.parse(stdout) as { streams: { pix_fmt: string; time_base: string }[]; frames: { best_effort_timestamp: number }[] };
    const [video] = probe.streams, base = /^([1-9]\d*)\/([1-9]\d*)$/.exec(video?.time_base ?? "");
    if (video?.pix_fmt !== "yuv420p" || !base || probe.frames.length !== range.durationFrames)
      fail("MEDIA", "Use a yuv420p MP4 with one timestamp per decoded frame.");
    const numerator = BigInt(base[1]), denominator = BigInt(base[2]), fps = BigInt(profile.fps);
    if (probe.frames.some(({ best_effort_timestamp: pts }, i) =>
      !Number.isSafeInteger(pts) || BigInt(pts) * numerator * fps !== BigInt(i) * denominator))
      fail("MEDIA", "Video frame timestamps must start at zero and follow the admitted constant frame rate.");
    return { frameCount: decoded.frames, rgbHash: decoded.rgbHash };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RetainedShotSegmentError) throw error;
    fail("MEDIA", error instanceof Error ? error.message : "The video could not be verified.");
  } finally { await rm(work, { recursive: true, force: true }); }
}

const owner = (id: string) => ({ ownerType: "shot-segment" as const, ownerId: id });
function verifyDataRecord(record: ArtifactRecord, id: string, expectedSize?: number) {
  if (record.id !== id || record.contentHash !== id.slice(7) || record.uri !== "artifact://sha256/" + id.slice(7) ||
      record.kind !== "data" || record.mediaType !== dataMediaType || (expectedSize !== undefined && record.sizeBytes !== expectedSize))
    fail("INTEGRITY", "Retained JSON metadata differs from the expected artifact.");
}

/** Trusted local handoff, independent of job/workspace ownership after a successful retain. */
export class RetainedShotSegmentStore {
  constructor(private readonly artifacts: ArtifactStore, private readonly lifecycle: LocalArtifactLifecycleManager) {}

  private async readData(id: string, limit: number) {
    try {
      const record = await this.artifacts.get(id);
      if (!record) fail("MISSING", "A retained segment artifact is missing.");
      verifyDataRecord(record, id);
      if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || record.sizeBytes > limit)
        fail("INTEGRITY", "Retained JSON has an invalid size.");
      const bytes = await this.artifacts.read(id);
      if (!bytes) fail("MISSING", "Retained JSON bytes are missing.");
      if (bytes.byteLength !== record.sizeBytes || artifactId(bytes) !== id) fail("INTEGRITY", "Retained JSON bytes differ from their hash.");
      return { record, bytes };
    } catch (error) {
      if (error instanceof RetainedShotSegmentError) throw error;
      fail("INTEGRITY", "The retained JSON could not be verified.");
    }
  }

  private async readVideo(receipt: RenderJobReceipt) {
    try {
      const bytes = await readVerifiedJobArtifact(this.artifacts, receipt);
      if (!bytes) fail("MISSING", "The render receipt's video is missing.");
      return bytes;
    } catch (error) {
      if (error instanceof RetainedShotSegmentError) throw error;
      fail("INTEGRITY", "The stored video differs from the render receipt.");
    }
  }

  async retain(snapshotInput: ProjectSnapshot, jobInput: RenderJobRecord, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const snapshot = structuredClone(snapshotInput), job = structuredClone(jobInput);
    try { validateJobRecord(job); }
    catch { fail("JOB", "The supplied render record is not valid."); }
    const { input, result } = job, { profile, render } = input;
    if (job.state !== "succeeded" || !result || render.operation !== "video" || result.mediaType !== "video/mp4")
      fail("JOB", "A completed video render receipt is required.");
    if (!Number.isSafeInteger(profile.fps) || profile.width % 2 || profile.height % 2)
      fail("PROFILE", "V1 segments use integer FPS and even native dimensions.");
    const snapshotBytes = encodeJson(snapshot, snapshotLimit);
    const source: Source = { snapshot: { ...input.snapshot, artifactId: artifactId(snapshotBytes) },
      scope: render.sceneId === undefined ? { kind: "sequence", id: snapshot?.document?.sequences?.[0]?.id ?? "" } :
        { kind: "scene", id: render.sceneId },
      range: { startFrame: render.startFrame, durationFrames: render.durationFrames } };
    verifySource(snapshot, input.projectId, source, profile);
    const bytes = await this.readVideo(result);
    const verificationSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const observed = await verifyMp4(bytes, profile, source.range, verificationSignal);
    const segment = parseRetainedShotSegment({ schemaVersion: RETAINED_SHOT_SEGMENT_VERSION, projectId: input.projectId, source,
      origin: { kind: "render-job", jobId: job.id, inputHash: job.inputHash }, renderer: input.renderer, profile,
      media: { artifactId: result.artifactId, contentHash: result.contentHash, sizeBytes: result.sizeBytes, mediaType: result.mediaType,
        codec: "h264", pixelFormat: "yuv420p", silent: true, frameCount: observed.frameCount } });
    const manifest = encodeJson(segment, manifestLimit);
    signal?.throwIfAborted();
    const provenance = { projectId: input.projectId };
    const storedSnapshot = await this.artifacts.put({ bytes: snapshotBytes, kind: "data", mediaType: dataMediaType, provenance });
    verifyDataRecord(storedSnapshot, source.snapshot.artifactId, snapshotBytes.byteLength);
    const record = await this.artifacts.put({ bytes: manifest, kind: "data", mediaType: dataMediaType,
      provenance: { ...provenance, sourceArtifactIds: [storedSnapshot.id, result.artifactId] } });
    verifyDataRecord(record, artifactId(manifest), manifest.byteLength);
    signal?.throwIfAborted();
    const retention = owner(record.id);
    await this.lifecycle.attachBatch([
      { ...retention, artifactId: storedSnapshot.id, role: "source-snapshot" },
      { ...retention, artifactId: result.artifactId, role: "video" },
      { ...retention, artifactId: record.id, role: "descriptor" },
    ]);
    // The decoder's transient RGB conversion does not participate in the segment identity.
    return { record, segment, decodedRgbHash: observed.rgbHash };
  }

  async read(id: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) fail("INTEGRITY", "Use a content-addressed segment ID.");
    const retained = async (artifactId: string, role: string) =>
      (await this.lifecycle.references(artifactId)).some(r => r.ownerType === "shot-segment" && r.ownerId === id && r.role === role);
    if (!await retained(id, "descriptor")) fail("MISSING", "No committed segment matches this ID.");
    const { record, bytes: descriptorBytes } = await this.readData(id, manifestLimit);
    const segment = parseRetainedShotSegment(decodeJson(descriptorBytes));
    const { source, media, origin, renderer } = segment;
    if (!await retained(source.snapshot.artifactId, "source-snapshot") || !await retained(media.artifactId, "video"))
      fail("MISSING", "The segment no longer retains both dependencies.");
    const { bytes: sourceBytes } = await this.readData(source.snapshot.artifactId, snapshotLimit);
    const snapshot = decodeJson(sourceBytes) as ProjectSnapshot;
    verifySource(snapshot, segment.projectId, source, segment.profile);
    const videoBytes = await this.readVideo({ jobId: origin.jobId, inputHash: origin.inputHash, artifactId: media.artifactId,
      contentHash: media.contentHash, sizeBytes: media.sizeBytes, mediaType: media.mediaType,
      rendererId: renderer.id, rendererVersion: renderer.version });
    return { record, segment, descriptorBytes, snapshot, sourceBytes, videoBytes };
  }
}
