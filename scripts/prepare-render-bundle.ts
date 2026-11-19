import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepareRenderBundle } from "../src/renderers/remotion/prepared-render-bundle";

const { values } = parseArgs({ options: { output: { type: "string" }, "entry-point": { type: "string", default: "src/index.ts" } } });
if (!values.output) throw new Error("Supply --output with a new directory for the prepared bundle");
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
console.log(JSON.stringify(await prepareRenderBundle(values["entry-point"], output)));
