import { resolve } from "node:path";
import { openCreativeHost } from "../src/platform/creative-host";

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: npx tsx scripts/creative-host-smoke.ts <local-data-directory>");
  const host = await openCreativeHost({ directory: resolve(directory) });
  try {
    const session = host.createSession({ projectId: "host-smoke", permissions: ["project.read", "project.write", "artifact.read", "snapshot.write"],
      toolIds: ["project.create", "project.inspect", "project.patch.apply", "project.snapshot.save"] });
    console.log("Authorized tools:", (await session.discover()).tools.map((m) => `${m.id}@${m.version}`));
    for (const [toolId, input, callId] of [
      ["project.create", { name: "Host smoke", episodeId: "approved-content" }, "create"],
      ["project.patch.apply", { schemaVersion: "1.3.0", projectId: "host-smoke", baseRevisionId: "revision-initial", patches: [
        { op: "add-scene", scene: { id: "scene-main", name: "Independent visual data", durationFrames: 120, rootNodeIds: [] } },
        { op: "add-shot", sequenceId: "sequence-main", shot: { id: "shot-main", name: "Main", sceneId: "scene-main", startFrame: 0, durationFrames: 120 } },
      ] }, "edit"],
    ] as const) {
      const result = await session.invoke({ toolId, toolVersion: "1.0.0", input, runId: "smoke", callId, idempotencyKey: callId });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      console.log(toolId, result.output);
    }
    const result = await session.invoke({ toolId: "project.inspect", toolVersion: "1.0.0", input: {}, runId: "smoke-inspect", callId: new Date().toISOString() });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    console.log("Project:", result.output);
  } finally { await host.close(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
