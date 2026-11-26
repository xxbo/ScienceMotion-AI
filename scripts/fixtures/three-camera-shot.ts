import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectAnimationTrack, ProjectDocument } from "../../src/contracts/project";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "../../src/platform/artifact-lifecycle";
import { FileSystemArtifactStore } from "../../src/platform/artifact-store";
import { FileSystemProjectWorkspace } from "../../src/platform/filesystem-project-workspace";
import { hashProject } from "../../src/platform/project-snapshots";
import { inspectThreePixels, projectThreeBounds, threeProfile } from "./three-scene-pixels";

export const threeStudyProjectId = "three-static-study";
export const threeStudySource = { id: "three-static-v1", revisionId: "revision-three-static-v1", contentHash: "c6ac973ff3672a2e3db19d9d82c68859eeef2bfbec4eaff8e7343611e3c2b5b8" };
export const threeCameraNodeId = "view-camera", threeCameraPanTrackId = "camera-pan", threeCameraOriginalYaw = 14;
export const threeCameraRange = { startFrame: 6, durationFrames: 42 };
export const threeCameraTracks: ProjectAnimationTrack[] = [
  { id: "camera-slide", targetNodeId: threeCameraNodeId, targetProperty: "transform.position",
    keyframes: [{ frame: 0, value: [0, 2.3, 8] }, { frame: 23, value: [1.15, 2.3, 8] }] },
  { id: threeCameraPanTrackId, targetNodeId: threeCameraNodeId, targetProperty: "transform.rotation",
    keyframes: [{ frame: 23, value: [-14, 0, 0] }, { frame: 47, value: [-14, threeCameraOriginalYaw, 0] }] },
];

export async function retainThreeStaticStudy(directory: string, artifacts: FileSystemArtifactStore, references: FileSystemArtifactReferenceStore) {
  const document = JSON.parse(await readFile("examples/three-static-scene.json", "utf8")) as ProjectDocument;
  assert.equal(document.project.id, threeStudyProjectId);
  assert.equal(hashProject(document), threeStudySource.contentHash);
  const workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), new LocalArtifactLifecycleManager(artifacts, references));
  try {
    await workspace.create(document);
    const saved = await workspace.saveSnapshot(threeStudyProjectId, threeStudySource.revisionId,
      { id: threeStudySource.id, createdAt: document.project.updatedAt });
    assert.equal(saved.contentHash, threeStudySource.contentHash);
    return saved;
  } finally { await workspace.close(); }
}

// Independent of Project Graph sampling: slide right, then yaw left without moving.
export function projectThreeCameraBounds(frame: number, finalYaw = threeCameraOriginalYaw) {
  return projectThreeBounds({
    position: [1.15 * Math.min(frame, 23) / 23, 2.3, 8],
    rotation: [-14, finalYaw * Math.max(0, frame - 23) / 24, 0],
  });
}

export function measureThreeCameraVideo(file: string, finalYaw = threeCameraOriginalYaw) {
  const frameBytes = threeProfile.width * threeProfile.height * 3;
  const { startFrame, durationFrames } = threeCameraRange;
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe",
    "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { timeout: 20_000, maxBuffer: frameBytes * durationFrames + 1024 });
  assert.equal(rgb.byteLength, frameBytes * durationFrames);
  const frames = Array.from({ length: durationFrames }, (_, index) => {
    const frame = startFrame + index, predicted = projectThreeCameraBounds(frame, finalYaw);
    return { predicted, pixels: inspectThreePixels(rgb.subarray(index * frameBytes, (index + 1) * frameBytes), 3, frame, predicted) };
  });
  return { frames, rgbHash: createHash("sha256").update(rgb).digest("hex") };
}
