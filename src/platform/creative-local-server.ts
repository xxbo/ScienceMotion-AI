import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { CreativeLocalConfig } from "../contracts/creative-client";
import { CREATIVE_CLIENT_PROTOCOL, CREATIVE_CLIENT_JOB_PROTOCOL } from "../contracts/creative-client";
import { openCreativeHost } from "./creative-host";
import { assertFiniteJson } from "./project-creative-edits";
import { CreativeTransportError, serveCreativeStdio, type CreativeTraceSink } from "./creative-stdio";
import { checkRenderWorkerResources, renderWorkerPolicy } from "./render-worker";
import { creativeJobPolicy } from "./creative-job-input";
import { approvedAssetImports } from "./approved-asset-imports";

function bounded(value: unknown, fallback: number, maximum: number): number {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 256 || n > maximum) throw new Error("Invalid transport byte limit");
  return n;
}
export async function readCreativeLocalConfig(path: string): Promise<CreativeLocalConfig> {
  if ((await stat(path)).size > 64 * 1024) throw new Error("Launch configuration exceeds 64 KiB");
  const value = JSON.parse(await readFile(path, "utf8")) as CreativeLocalConfig;
  assertFiniteJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== "1.0.0" ||
      Object.keys(value).some(k => !["schemaVersion", "protocolVersion", "directory", "traceFile", "grant", "assetImports", "limits", "renderWorker", "renderJobs", "maxRequestBytes", "maxTraceBytes", "metadata"].includes(k)) ||
      typeof value.directory !== "string" || !value.directory.trim() || typeof value.traceFile !== "string" || !value.traceFile.trim())
    throw new Error("Invalid local launch configuration");
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) throw new Error("Invalid launch metadata");
  if (value.renderWorker !== undefined) checkRenderWorkerResources(renderWorkerPolicy(value.renderWorker));
  if (value.protocolVersion !== undefined && ![CREATIVE_CLIENT_PROTOCOL, CREATIVE_CLIENT_JOB_PROTOCOL].includes(value.protocolVersion)) throw new Error("Unsupported local protocol");
  if (value.renderJobs !== undefined) creativeJobPolicy(value.renderJobs);
  return { ...value, directory: resolve(dirname(path), value.directory), traceFile: resolve(dirname(path), value.traceFile),
    ...(value.assetImports === undefined ? {} : { assetImports: approvedAssetImports(value.assetImports, dirname(path)) }),
    maxRequestBytes: bounded(value.maxRequestBytes, 1024 * 1024, 1024 * 1024),
    maxTraceBytes: bounded(value.maxTraceBytes, 64 * 1024 * 1024, 128 * 1024 * 1024) };
}
export async function runCreativeLocalServer(configPath: string, streams: { input: Readable; output: Writable; signal?: AbortSignal }): Promise<boolean> {
  const config = await readCreativeLocalConfig(resolve(configPath));
  await mkdir(dirname(config.traceFile), { recursive: true, mode: 0o700 });
  const file = await open(config.traceFile, "wx", 0o600);
  let bytes = 0, sequence = 0;
  const trace: CreativeTraceSink = { record: async (kind, data) => {
    const line = JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), kind, data }) + "\n";
    if (bytes + Buffer.byteLength(line) > config.maxTraceBytes!) throw new CreativeTransportError("TRANSPORT_TRACE_LIMIT", "Trace byte limit reached");
    try { await file.writeFile(line); await file.sync(); bytes += Buffer.byteLength(line); }
    catch { throw new CreativeTransportError("TRANSPORT_TRACE_FAILED", "Could not persist transport evidence"); }
  } };
  let host: Awaited<ReturnType<typeof openCreativeHost>> | undefined;
  try {
    host = await openCreativeHost({ directory: config.directory, assetImports: config.assetImports,
      limits: config.limits, renderWorker: config.renderWorker, renderJobs: config.renderJobs });
    const session = host.createSession(config.grant);
    const abort = () => { session.revoke(); streams.input.destroy(); };
    streams.signal?.addEventListener("abort", abort, { once: true });
    try {
      await trace.record("session", { protocolVersion: config.protocolVersion ?? CREATIVE_CLIENT_PROTOCOL, grant: config.grant,
        renderExecution: config.renderWorker === undefined ? { mode: "in-process" } : { mode: "local-process", policy: renderWorkerPolicy(config.renderWorker) },
        plugins: host.plugins.exportLock(), metadata: config.metadata ?? {}, metadataSource: "operator-supplied; not provider-attested" });
      if (streams.signal?.aborted) abort();
      const completed = await serveCreativeStdio({ ...streams, session, trace, protocolVersion: config.protocolVersion, maxRequestBytes: config.maxRequestBytes!, close: async () => { session.revoke(); await host!.close(); } });
      return completed && !streams.signal?.aborted;
    } finally { streams.signal?.removeEventListener("abort", abort); }
  } finally { try { await host?.close(); } finally { await file.close(); } }
}
