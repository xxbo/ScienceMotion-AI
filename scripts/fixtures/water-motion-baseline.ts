import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import Ajv from "ajv";
import type { DeliveryRange, DeliverySnapshot } from "../../src/contracts/creative-delivery";
import type { CreativeRepairReport } from "../../src/contracts/creative-repair";
import { createEmptyProject } from "../../src/platform/empty-project";
import { assertCreativeDocument } from "../../src/platform/project-creative-edits";
import { hashProject, InMemorySnapshotStore, type ProjectSnapshot } from "../../src/platform/project-snapshots";
import schema from "../../schemas/project.schema.json";

export interface WaterMotionBaseline {
  source: { trialId: string; sceneId: string; snapshot: DeliverySnapshot };
  snapshot: ProjectSnapshot;
  workload: {
    previewFrame: number;
    video: DeliveryRange;
    markerSamples: Array<{ frame: number; x: number; y: number }>;
    swatches: Array<{ name: string; x: number; y: number; rgb: [number, number, number] }>;
    markerRgb: [number, number, number];
    videoColorTolerance: number;
  };
}

const trialId = "p1-4-water-loop-2026-11-24";
const trial = `docs/ai-trials/${trialId}`;
const repairPath = "water-loop/repair.json";
const manifest = JSON.parse(await readFile(`${trial}/manifest.json`, "utf8")) as {
  trialId: string;
  approved: DeliverySnapshot;
  files: Record<string, { sha256: string; bytes: number }>;
};
const repairBytes = await readFile(`${trial}/${repairPath}`);
assert.equal(manifest.trialId, trialId);
assert.deepEqual({ sha256: createHash("sha256").update(repairBytes).digest("hex"), bytes: repairBytes.byteLength }, manifest.files[repairPath]);
const repair = JSON.parse(repairBytes.toString("utf8")) as CreativeRepairReport;
assert.equal(repair.stop, "verified");
const checkpoint = repair.lastVerified;
assert.ok(checkpoint && checkpoint.findings.length === 0);
assert.deepEqual(manifest.approved, { id: checkpoint.snapshotId, revisionId: checkpoint.revisionId, contentHash: checkpoint.snapshotHash });
const verified = repair.run.turns.flatMap(({ decision, call }) =>
  decision.kind === "invoke" && decision.toolId === "project.snapshot.inspect" && call?.result?.ok
    ? [call.result.output as ProjectSnapshot]
    : []).find(snapshot => snapshot.id === checkpoint.snapshotId);
assert.ok(verified);
assert.equal(verified.contentHash, manifest.approved.contentHash);
assert.equal(hashProject(verified.document), manifest.approved.contentHash);
assert.equal(verified.document.revisions.at(-1)?.id, manifest.approved.revisionId);

const scene = verified.document.scenes.find(item => item.id === "evaporate");
const shot = verified.document.shots?.find(item => item.sceneId === scene?.id);
assert.ok(scene && shot && shot.startFrame === 0 && shot.durationFrames === scene.durationFrames);
const nodeIds = ["evaporation-background", "water-surface", "marker"];
const nodes = nodeIds.map(id => {
  const node = verified.document.nodes.find(node => node.id === id);
  assert.ok(node?.type === "shape" && !node.parentId && scene.rootNodeIds.includes(id));
  return node;
});
const tracks = verified.document.animationTracks.filter(track => track.targetNodeId === "marker");
assert.equal(tracks.length, 1);
const { width, height, fps } = verified.document.sequences[0];
const project = createEmptyProject({ id: "water-motion-baseline", name: "Evaporation motion baseline", episodeId: verified.document.editorial.episodeId,
  width, height, fps, durationFrames: shot.durationFrames, createdAt: verified.createdAt });
project.revisions[0].message = "Derive the evaporation motion fixture from the verified water-cycle snapshot";
project.scenes = [{ ...scene, rootNodeIds: nodeIds }];
project.nodes = nodes;
project.animationTracks = tracks;
project.shots = [shot];
project.sequences[0].shotIds = [shot.id];
assertCreativeDocument(project);
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
assert.ok(validate(project), JSON.stringify(validate.errors));

const derived: WaterMotionBaseline = {
  source: { trialId, sceneId: scene.id, snapshot: manifest.approved },
  snapshot: new InMemorySnapshotStore().save(project, { id: "water-motion-v1", createdAt: verified.createdAt }),
  workload: {
    previewFrame: 40,
    video: { startFrame: 12, durationFrames: 40 },
    markerSamples: [{ frame: 12, x: 324, y: 237 }, { frame: 40, x: 341, y: 196 }, { frame: 51, x: 347, y: 176 }],
    swatches: [
      { name: "background", x: 26, y: 26, rgb: [16, 39, 64] },
      { name: "water", x: 320, y: 286, rgb: [40, 102, 139] },
    ],
    markerRgb: [130, 226, 251],
    videoColorTolerance: 8,
  },
};
const path = "examples/water-motion-baseline.json";
const [option, extra] = process.argv.slice(2);
assert.ok((option === undefined || option === "--write") && extra === undefined);
if (option === "--write") await writeFile(path, JSON.stringify(derived, null, 2) + "\n");
else assert.deepEqual(JSON.parse(await readFile(path, "utf8")), derived, "The benchmark fixture must match the recorded extraction");
console.log(`Verified ${derived.snapshot.id} from ${trialId} ${derived.snapshot.contentHash}`);
