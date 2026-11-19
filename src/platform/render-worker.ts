import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, statfsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayoutFrameMeasurement } from "../contracts/layout-inspection";
import type { ProjectGraphLayoutRequest, ProjectGraphPreviewRequest, ProjectGraphRenderOutput, ProjectGraphSnapshotRenderer, ProjectGraphVideoRequest, RenderWorkerResourceUsage } from "../contracts/renderer";
import type { RenderWorkerEvent, RenderWorkerJob, RenderWorkerOperation, RenderWorkerPolicy, RenderWorkerReceipt, RenderWorkerRequest, RenderWorkerResourceBudget } from "../contracts/render-worker";
import { assertFiniteJson } from "./project-creative-edits";

export class RenderWorkerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RenderWorkerError"; }
}
const fail = (code: string, message: string): never => { throw new RenderWorkerError(code, message); };
const supervisor = fileURLToPath(new URL("./render-worker-supervisor.py", import.meta.url));
const defaults = { timeoutMs: 30000, maxConcurrentJobs: 1, maxOutputBytes: 32 * 1024 * 1024, maxOldSpaceMb: 1024, killGraceMs: 150 };
const budgetBounds: Record<keyof RenderWorkerResourceBudget, [number, number]> = {
  // With a 100 ms CPU bandwidth period, 10 millicores is Linux's 1 ms minimum quota.
  cpuMillicores: [10, Math.floor(Number.MAX_SAFE_INTEGER / 100)],
  cpuTimeMs: [1, Math.floor(Number.MAX_SAFE_INTEGER / 1000)],
  memoryBytes: [1, Number.MAX_SAFE_INTEGER],
  temporaryBytes: [1, Number.MAX_SAFE_INTEGER],
};
const absolutePath = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && !path.includes("\0");

export function renderWorkerPolicy(value: Partial<RenderWorkerPolicy> = {}): Readonly<RenderWorkerPolicy> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !["resourceBudget", "cgroupParent", "temporaryVolumes", "preparedBundle"].includes(k) && !Object.hasOwn(defaults, k)))
    fail("RENDER_WORKER_CONFIG", "Unknown render worker policy field");
  const { resourceBudget, cgroupParent, temporaryVolumes, preparedBundle, ...worker } = value;
  const policy = { ...defaults, ...worker, ...(preparedBundle === undefined ? {} : { preparedBundle: validatePreparedBundle(preparedBundle) }) };
  const bounds: Record<keyof typeof defaults, [number, number]> = {
    timeoutMs: [1, 300000], maxConcurrentJobs: [1, 4], maxOutputBytes: [1024, 64 * 1024 * 1024], maxOldSpaceMb: [128, 4096], killGraceMs: [0, 1000],
  };
  for (const key of Object.keys(bounds) as (keyof typeof defaults)[])
    if (!Number.isSafeInteger(policy[key]) || policy[key] < bounds[key][0] || policy[key] > bounds[key][1]) fail("RENDER_WORKER_CONFIG", `Invalid ${key}`);
  if (cgroupParent !== undefined && !absolutePath(cgroupParent))
    fail("RENDER_WORKER_CONFIG", "cgroupParent must be an absolute cgroup v2 path");
  if (temporaryVolumes !== undefined && (!Array.isArray(temporaryVolumes) || temporaryVolumes.length < policy.maxConcurrentJobs ||
      temporaryVolumes.length > 4 || !Array.from(temporaryVolumes).every(absolutePath) ||
      new Set(temporaryVolumes.map(path => resolve(path))).size !== temporaryVolumes.length))
    fail("RENDER_WORKER_CONFIG", "temporaryVolumes must supply distinct absolute paths for every worker slot");
  if (resourceBudget !== undefined) {
    if (!resourceBudget || typeof resourceBudget !== "object" || Array.isArray(resourceBudget) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(resourceBudget)) ||
        !Object.keys(resourceBudget).length || Object.keys(resourceBudget).some(key => !Object.hasOwn(budgetBounds, key)))
      fail("RENDER_WORKER_CONFIG", "resourceBudget must specify at least one documented limit");
    for (const key of Object.keys(resourceBudget) as (keyof RenderWorkerResourceBudget)[]) {
      const amount = resourceBudget[key], [minimum, maximum] = budgetBounds[key];
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < minimum || amount > maximum)
        fail("RENDER_WORKER_CONFIG", `Invalid resourceBudget.${key}`);
    }
    const needsCgroup = resourceBudget.cpuMillicores !== undefined || resourceBudget.cpuTimeMs !== undefined || resourceBudget.memoryBytes !== undefined;
    if (needsCgroup && !cgroupParent)
      fail("RENDER_WORKER_RESOURCE_UNAVAILABLE", "CPU and memory budgets require a delegated cgroupParent");
    if (resourceBudget.temporaryBytes !== undefined && !temporaryVolumes)
      fail("RENDER_WORKER_RESOURCE_UNAVAILABLE", "temporaryBytes requires dedicated ext4 temporaryVolumes");
    if (!needsCgroup && cgroupParent !== undefined) fail("RENDER_WORKER_CONFIG", "cgroupParent requires a CPU or memory budget");
    if (temporaryVolumes !== undefined && resourceBudget.temporaryBytes === undefined)
      fail("RENDER_WORKER_CONFIG", "temporaryVolumes requires resourceBudget.temporaryBytes");
    return Object.freeze({ ...policy, resourceBudget: Object.freeze({ ...resourceBudget }), ...(cgroupParent ? { cgroupParent } : {}),
      ...(temporaryVolumes ? { temporaryVolumes: Object.freeze([...temporaryVolumes]) } : {}) });
  }
  if (cgroupParent !== undefined) fail("RENDER_WORKER_CONFIG", "cgroupParent requires resourceBudget");
  if (temporaryVolumes !== undefined) fail("RENDER_WORKER_CONFIG", "temporaryVolumes requires resourceBudget.temporaryBytes");
  return Object.freeze(policy);
}

function validatePreparedBundle(value: NonNullable<RenderWorkerPolicy["preparedBundle"]>) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, "directory") || !Object.hasOwn(value, "sha256") ||
      !absolutePath(value.directory) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))
    fail("RENDER_WORKER_CONFIG", "preparedBundle requires an absolute directory and a SHA-256 identity");
  return Object.freeze({ directory: resolve(value.directory), sha256: value.sha256 });
}

function resourceConfiguration({ cgroupParent, resourceBudget, temporaryVolumes, maxOutputBytes }: Readonly<RenderWorkerPolicy>) {
  return JSON.stringify({ cgroupParent, resourceBudget, temporaryVolumes, maxOutputBytes });
}

/** Verify delegation and the selected controls before opening persistent host state. */
export function checkRenderWorkerResources(policy: Readonly<RenderWorkerPolicy>): void {
  if (!policy.resourceBudget) return;
  if (process.platform !== "linux") fail("RENDER_WORKER_RESOURCE_UNAVAILABLE", "Render resource budgets require Linux");
  if (policy.cgroupParent) {
    let type: number | undefined;
    try { type = statfsSync(policy.cgroupParent).type; } catch { /* Missing or inaccessible parent. */ }
    if (type !== 0x63677270) // CGROUP2_SUPER_MAGIC
      fail("RENDER_WORKER_RESOURCE_UNAVAILABLE", "cgroupParent must be accessible on a Linux cgroup v2 filesystem");
  }
  const result = spawnSync("python3", [supervisor, "--check-resources", resourceConfiguration(policy)], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4096,
  });
  if (result.status !== 0) fail("RENDER_WORKER_RESOURCE_UNAVAILABLE",
    `Could not enforce the render resource budget: ${(result.error?.message || result.stderr || "resource preflight failed").trim().slice(0, 512)}`);
}

const resourceFailureCodes = new Set(["RENDER_WORKER_CPU_TIME_LIMIT", "RENDER_WORKER_MEMORY_LIMIT",
  "RENDER_WORKER_TEMPORARY_LIMIT", "RENDER_WORKER_BUSY", "RENDER_WORKER_OUTPUT_INVALID",
  "RENDER_WORKER_RESOURCE_UNAVAILABLE", "RENDER_WORKER_RESOURCE_ACCOUNTING", "RENDER_WORKER_CLEANUP"]);
function readResourceReport(raw: string, exitCode: number | null, budget: RenderWorkerResourceBudget): {
  usage?: RenderWorkerResourceUsage; failure?: RenderWorkerError;
} {
  try {
    const report = JSON.parse(raw);
    if (!report || typeof report !== "object" || Array.isArray(report) ||
        Object.keys(report).some(key => key !== "usage" && key !== "failure") || raw.length > 4096) throw new Error();
    const { usage, failure } = report;
    if (failure !== undefined && (!resourceFailureCodes.has(failure?.code) ||
        typeof failure.message !== "string" || !failure.message || failure.message.length > 1024)) throw new Error();
    if (usage !== undefined || (exitCode === 0 && !failure)) {
      const fields = [
        ...(budget.cpuMillicores !== undefined || budget.cpuTimeMs !== undefined ? ["cpuUsageUsec"] : []),
        ...(budget.cpuMillicores !== undefined ? ["cpuThrottledPeriods"] : []),
        ...(budget.memoryBytes !== undefined ? ["memoryOomEvents", "memoryOomKills"] : []),
        ...(budget.temporaryBytes !== undefined ? ["temporaryCapacityBytes", "temporaryMinimumAvailableBytes", "temporaryMinimumAvailableInodes"] : []),
      ];
      if (!usage || typeof usage !== "object" || Array.isArray(usage) ||
          (!failure && Object.keys(usage).length !== fields.length) ||
          Object.keys(usage).some(key => !fields.includes(key) || typeof usage[key] !== "string" || !/^\d{1,20}$/.test(usage[key]))) throw new Error();
      Object.freeze(usage);
    }
    return { usage, failure: failure ? new RenderWorkerError(failure.code, failure.message) : undefined };
  } catch {
    return { failure: new RenderWorkerError("RENDER_WORKER_CLEANUP", "Render worker exited without a valid resource cleanup report") };
  }
}

export interface RenderWorkerOptions {
  policy?: Partial<RenderWorkerPolicy>;
  entryPoint?: string;
  onEvent?: (event: RenderWorkerEvent) => void;
  /** Trusted embedding/test configuration, never taken from AI tool arguments. */
  workerScript?: string;
  temporaryDirectory?: string;
}
type ActiveJob = { cancel(): void; done: Promise<unknown> };
/** One disposable Linux guardian/renderer per job. No persistent queue or third-party sandbox. */
export class LocalRenderWorker implements ProjectGraphSnapshotRenderer {
  readonly id = "remotion.project-graph"; readonly version = "1.0.0";
  readonly policy: Readonly<RenderWorkerPolicy>;
  private readonly jobs = new Set<ActiveJob>();
  private closed = false;
  constructor(private readonly options: RenderWorkerOptions = {}) {
    this.policy = renderWorkerPolicy(options.policy);
    checkRenderWorkerResources(this.policy);
    if (process.platform !== "linux") fail("RENDER_WORKER_PLATFORM", "Render workers require Linux subreaper support and Python 3");
  }
  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs]; jobs.forEach(job => job.cancel());
    await Promise.allSettled(jobs.map(job => job.done));
  }
  status() { return { closed: this.closed, activeJobs: this.jobs.size }; }
  renderPreview(request: ProjectGraphPreviewRequest) { return this.render("preview", request); }
  renderVideo(request: ProjectGraphVideoRequest) { return this.render("video", request); }
  async measureLayout(request: ProjectGraphLayoutRequest): Promise<LayoutFrameMeasurement[]> {
    const result = await this.run("layout", request);
    try { const frames: unknown = JSON.parse(result.bytes.toString("utf8")); if (!Array.isArray(frames)) throw new Error(); return frames; }
    catch { return fail("RENDER_WORKER_OUTPUT_INVALID", "Worker returned invalid layout JSON"); }
  }
  private async render(operation: "preview" | "video", request: RenderWorkerRequest): Promise<ProjectGraphRenderOutput> {
    const result = await this.run(operation, request);
    return { bytes: result.bytes, mediaType: operation === "preview" ? "image/png" : "video/mp4", extension: operation === "preview" ? "png" : "mp4",
      rendererId: this.id, rendererVersion: this.version, execution: result.execution };
  }
  private run(operation: RenderWorkerOperation, request: RenderWorkerRequest) {
    if (this.closed) return Promise.reject(new RenderWorkerError("RENDER_WORKER_CLOSED", "Render worker is closed"));
    if (request.signal?.aborted) return Promise.reject(new RenderWorkerError("RENDER_WORKER_CANCELLED", "Render was cancelled before admission"));
    if (this.jobs.size >= this.policy.maxConcurrentJobs) return Promise.reject(new RenderWorkerError("RENDER_WORKER_BUSY", "Render worker capacity is occupied; no implicit queue"));
    const { signal, onProgress, ...fields } = request;
    const provided = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as typeof fields;
    const jobId = randomUUID(), started = performance.now();
    const preparedBundle = this.policy.preparedBundle;
    const job: RenderWorkerJob = { protocolVersion: "1.0.0", jobId, operation, entryPoint: resolve(this.options.entryPoint ?? "src/index.ts"),
      ...(preparedBundle ? { preparedBundle } : {}), maxOutputBytes: this.policy.maxOutputBytes, request: provided };
    let text: string, data: RenderWorkerJob["request"];
    try { assertFiniteJson(job); text = JSON.stringify(job); if (Buffer.byteLength(text) > 12 * 1024 * 1024) fail("RENDER_WORKER_INPUT_LIMIT", "Worker request exceeds 12 MiB"); data = JSON.parse(text).request; }
    catch (error) { return Promise.reject(error); }
    let child: ChildProcess | undefined, directory: string | undefined, failure: RenderWorkerError | undefined;
    let timer: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined, exited = false, ready = false;
    let childClosed: Promise<number | null> | undefined;
    let receipt: RenderWorkerReceipt | undefined;
    let resourceUsage: RenderWorkerResourceUsage | undefined;
    const { resourceBudget } = this.policy;
    const notify = (state: RenderWorkerEvent["state"], extra: Partial<RenderWorkerEvent> = {}) => {
      try { this.options.onEvent?.({ jobId, operation, projectId: data.project.project.id, snapshotHash: data.snapshotHash,
        state, processId: child?.pid, elapsedMs: Math.round(performance.now() - started), ...extra }); } catch { /* Observers cannot change the job outcome. */ }
    };
    const stopGuardian = (force: boolean) => {
      if (!child?.pid || exited) return;
      // Never SIGKILL the guardian: it must survive to kill/reap detached descendants.
      try { process.kill(child.pid, force ? "SIGUSR1" : "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new RenderWorkerError("RENDER_WORKER_CLEANUP", "Could not signal the owned worker guardian"); }
    };
    const stop = (error: RenderWorkerError) => {
      if (failure) return; failure = error;
      if (!exited && child?.pid) {
        stopGuardian(false); escalation = setTimeout(() => stopGuardian(true), this.policy.killGraceMs);
      }
    };
    const accountResourceFailure = (error: RenderWorkerError) => {
      // A renderer error from a dying descendant can precede confirmation of OOM.
      const acceptedStop = failure?.code === "RENDER_WORKER_CANCELLED" || failure?.code === "RENDER_WORKER_TIMEOUT";
      if (error.code === "RENDER_WORKER_TEMPORARY_LIMIT" && failure?.code === error.code) return;
      if (!acceptedStop || error.code === "RENDER_WORKER_CLEANUP") failure = error;
    };
    const cancel = () => stop(new RenderWorkerError("RENDER_WORKER_CANCELLED", "Render was cancelled"));
    const active: ActiveJob = { cancel, done: Promise.resolve() };
    this.jobs.add(active); // Reserve synchronously, including job setup and output verification.
    const execute = async () => {
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => stop(new RenderWorkerError("RENDER_WORKER_TIMEOUT", "Render worker exceeded its wall-clock deadline")), this.policy.timeoutMs);
      try {
        if (signal?.aborted) cancel();
        if (failure) throw failure;
        directory = await mkdtemp(join(this.options.temporaryDirectory ?? tmpdir(), "sciencemotion-worker-"));
        await writeFile(join(directory, "request.json"), text, { flag: "wx", mode: 0o600 });
        if (failure) throw failure;
        child = spawn("python3", [supervisor, process.execPath,
          this.options.workerScript ?? fileURLToPath(new URL("../renderers/remotion/render-worker-entry.ts", import.meta.url)), directory,
          String(this.policy.maxOldSpaceMb), String(this.policy.killGraceMs), String(process.pid),
          ...(resourceBudget ? [resourceConfiguration(this.policy)] : [])], {
          detached: true, stdio: ["ignore", resourceBudget ? "pipe" : "ignore", "ignore", "ipc"],
          env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
        });
        let report = "";
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { report = (report + chunk).slice(0, 4097); });
        childClosed = new Promise<number | null>(resolveExit => child!.once("close", resolveExit));
        notify("starting");
        child.on("error", () => stop(new RenderWorkerError("RENDER_WORKER_START_FAILED", "Could not start render worker")));
        child.on("exit", () => { exited = true; }); // Guardian exits only after reaping the complete child tree.
        child.on("message", (message: unknown) => {
          if (failure) return; // A late success cannot replace cancellation/timeout.
          try {
            assertFiniteJson(message);
            if (!message || typeof message !== "object" || Array.isArray(message) || Buffer.byteLength(JSON.stringify(message)) > 8192) throw new Error();
            const m = message as Record<string, unknown>;
            if (m.protocolVersion !== "1.0.0" || m.jobId !== jobId || receipt) throw new Error();
            if (m.type === "ready" && !ready) { ready = true; notify("running"); return; }
            if (!ready) throw new Error();
            if (m.type === "progress") {
              if (!["bundling", "selecting", "rendering", "encoding"].includes(m.phase as string) ||
                  (m.fraction !== undefined && (typeof m.fraction !== "number" || m.fraction < 0 || m.fraction > 1))) throw new Error();
              const progress = { phase: m.phase, ...(m.fraction === undefined ? {} : { fraction: m.fraction }) } as NonNullable<RenderWorkerEvent["progress"]>;
              notify("running", { progress }); try { onProgress?.(progress); } catch { /* Observational only. */ }
              return;
            }
            if (m.type === "error" && typeof m.message === "string") {
              const code = m.code === "RENDER_WORKER_OUTPUT_LIMIT" ||
                (m.code === "RENDER_WORKER_BUNDLE_INVALID" && preparedBundle !== undefined) ||
                (m.code === "RENDER_WORKER_TEMPORARY_LIMIT" && resourceBudget?.temporaryBytes !== undefined) ? m.code : "RENDER_WORKER_EXECUTION_FAILED";
              stop(new RenderWorkerError(code, m.message.slice(0, 2048))); return;
            }
            if (m.type !== "result" || m.operation !== operation || m.projectId !== data.project.project.id || m.revisionId !== data.revisionId || m.snapshotHash !== data.snapshotHash ||
                m.rendererId !== this.id || m.rendererVersion !== this.version || !Number.isSafeInteger(m.bytes) || (m.bytes as number) < 1 ||
                typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error();
            if ((m.bytes as number) > this.policy.maxOutputBytes) { stop(new RenderWorkerError("RENDER_WORKER_OUTPUT_LIMIT", "Worker output exceeds its byte limit")); return; }
            receipt = m as unknown as RenderWorkerReceipt;
          } catch { stop(new RenderWorkerError("RENDER_WORKER_PROTOCOL", "Worker sent invalid, duplicate or mismatched evidence")); }
        });
        const code = await childClosed;
        exited = true;
        // These handlers are installed before the guardian can claim resources.
        const stoppedBeforeSetup = child.signalCode && ["SIGTERM", "SIGINT", "SIGUSR1"].includes(child.signalCode);
        if (resourceBudget && child.pid && (report || !stoppedBeforeSetup)) {
          const resources = readResourceReport(report, code, resourceBudget);
          resourceUsage = resources.usage;
          if (resources.failure) accountResourceFailure(resources.failure);
        }
        if (failure) throw failure;
        if (code !== 0 || !receipt) throw new RenderWorkerError("RENDER_WORKER_EXIT", "Worker exited without a successful result");
        const file = await open(join(directory, "output.bin"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== receipt.bytes || stat.size > this.policy.maxOutputBytes) fail("RENDER_WORKER_OUTPUT_INVALID", "Worker output is not the declared bounded regular file");
          bytes = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) fail("RENDER_WORKER_OUTPUT_INVALID", "Worker output was truncated"); offset += read.bytesRead; }
          if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256)
            fail("RENDER_WORKER_OUTPUT_INVALID", "Worker output size/hash differs from its receipt");
        } finally { await file.close(); }
        if (failure) throw failure;
        return { bytes, execution: { kind: "local-process" as const, protocolVersion: "1.0.0" as const, jobId, processId: child.pid!,
          elapsedMs: Math.round(performance.now() - started), ...(resourceUsage ? { resourceUsage } : {}) } };
      } catch (error) {
        failure ??= error instanceof RenderWorkerError ? error : new RenderWorkerError("RENDER_WORKER_OUTPUT_INVALID", error instanceof Error ? error.message : "Worker failed");
        throw failure;
      } finally {
        if (!exited) { stopGuardian(true); await childClosed; exited = true; }
        try { if (directory) await rm(directory, { recursive: true, force: true }); }
        catch { failure = new RenderWorkerError("RENDER_WORKER_CLEANUP", "Could not remove the worker's temporary files"); }
        // Cancellation/deadlines remain live through cleanup, before returning verified bytes.
        clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener("abort", cancel);
        this.jobs.delete(active);
        notify(failure ? failure.code === "RENDER_WORKER_CANCELLED" ? "cancelled" : failure.code === "RENDER_WORKER_TIMEOUT" ? "timed-out" : "failed" : "completed",
          { ...(failure ? { code: failure.code } : {}), ...(resourceUsage ? { resourceUsage } : {}) });
        if (failure) throw failure;
      }
    };
    active.done = execute(); return active.done as Promise<{ bytes: Buffer; execution: NonNullable<ProjectGraphRenderOutput["execution"]> }>;
  }
}
