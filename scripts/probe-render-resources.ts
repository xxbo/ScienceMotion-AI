import { parseArgs } from "node:util";
import { probeRenderResources } from "../src/platform/render-resource-capabilities";

const { values } = parseArgs({ options: {
  "cgroup-parent": { type: "string" },
  "temporary-volume": { type: "string" },
  require: { type: "boolean" },
}, allowPositionals: false });
const report = await probeRenderResources({ cgroupParent: values["cgroup-parent"], temporaryVolume: values["temporary-volume"] });
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (values.require && (report.cgroup.verification.state !== "verified" || report.storage.state !== "verified")) process.exitCode = 1;
