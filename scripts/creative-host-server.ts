import { runCreativeLocalServer } from "../src/platform/creative-local-server";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--config") {
  process.stderr.write("Usage: tsx scripts/creative-host-server.ts --config <trusted-launch-config.json>\n"); process.exitCode = 1;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (!await runCreativeLocalServer(args[1], { input: process.stdin, output: process.stdout, signal: controller.signal })) process.exitCode = 1;
  } catch (error) { process.stderr.write(`Creative Host startup/shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
