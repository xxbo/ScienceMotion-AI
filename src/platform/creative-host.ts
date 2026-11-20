import Ajv, { type ValidateFunction } from "ajv";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentToolPlugin } from "../contracts/agent-plugin";
import type { CreativeAssetImport, CreativeHost, CreativeHostLimits, CreativePluginFactory } from "../contracts/creative-host";
import { FileSystemArtifactStore } from "./artifact-store";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { FileSystemProjectWorkspace } from "./filesystem-project-workspace";
import { FileSystemToolExecutionStore } from "./filesystem-tool-execution-store";
import { InMemoryPluginManager } from "./plugin-manager";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";
import { assembleCreativeHost, CreativeHostError, resolveCreativeLimits, type CreativeHostRuntime } from "./creative-host-core";
import { workspacePlugin } from "./workspace-tools";
import type { ProjectGraphRenderRequest, ProjectGraphSnapshotRenderer } from "../contracts/renderer";
import { RemotionProjectGraphRenderer } from "../renderers/remotion/remotion-project-graph-renderer";
import { LocalRenderWorker, RenderWorkerError, renderWorkerPolicy } from "./render-worker";
import type { RenderWorkerEvent, RenderWorkerPolicy } from "../contracts/render-worker";
import type { CreativeJobPolicy } from "../contracts/creative-jobs";
import { FileSystemRenderJobStore } from "./filesystem-render-job-store";
import { creativeJobPolicy } from "./creative-job-input";
import { approvedAssetImports, readApprovedPng } from "./approved-asset-imports";
import { loadRenderPngAssets } from "./png-render-inputs";
import { PngInputError } from "./png-input";
import projectSchema from "../../schemas/project.schema.json";
import patchSchema from "../../schemas/project-patch.schema.json";
import toolSchema from "../../schemas/tool-manifest.schema.json";
import pluginSchema from "../../schemas/plugin-manifest.schema.json";

export interface OpenCreativeHostOptions {
  /** Trusted application configuration only; tools/sessions never accept filesystem paths. */
  directory: string;
  assetImports?: readonly CreativeAssetImport[];
  plugins?: readonly CreativePluginFactory[];
  limits?: Partial<CreativeHostLimits>;
  renderer?: ProjectGraphSnapshotRenderer;
  renderEntryPoint?: string;
  /** Opt-in disposable render processes; custom renderer injection and this option are mutually exclusive. */
  renderWorker?: Partial<RenderWorkerPolicy>;
  renderJobs?: Partial<CreativeJobPolicy>;
  onRenderWorkerEvent?: (event: RenderWorkerEvent) => void;
}
function assertValid(validate: ValidateFunction, value: unknown, label: string): void {
  if (!validate(value)) throw new Error(`${label}: ${JSON.stringify(validate.errors)}`);
}

/** Assemble one local, exclusive-writer host using the delivered F storage and execution implementations. */
export async function openCreativeHost(options: OpenCreativeHostOptions): Promise<CreativeHost> {
  const limits = resolveCreativeLimits(options.limits);
  const assetImports = approvedAssetImports(options.assetImports);
  const jobPolicy = creativeJobPolicy(options.renderJobs);
  if (options.renderWorker !== undefined && options.renderer) throw new Error("Choose a custom renderer or renderWorker, not both");
  const workerPolicy = options.renderWorker === undefined ? undefined : renderWorkerPolicy(options.renderWorker);
  if (workerPolicy && jobPolicy.maxConcurrentJobs > workerPolicy.maxConcurrentJobs)
    throw new CreativeHostError("HOST_JOB_CONFIG", "Background job concurrency exceeds the configured worker capacity");
  if (typeof options.directory !== "string" || !options.directory.trim()) throw new Error("Host directory is required");
  const directory = resolve(options.directory);
  const factories = [workspacePlugin, ...(options.plugins ?? [])].map((f) => ({ id: f.id, version: f.version, create: f.create.bind(f) }));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateProject = ajv.compile(projectSchema);
  const validatePatch = ajv.compile(patchSchema);
  const validateTool = ajv.compile(toolSchema);
  const validatePlugin = ajv.compile(pluginSchema);
  const ownedRenderer = workerPolicy ? new LocalRenderWorker({ entryPoint: options.renderEntryPoint,
    policy: { ...workerPolicy, maxOutputBytes: Math.min(workerPolicy.maxOutputBytes, limits.maxArtifactBytes) }, onEvent: options.onRenderWorkerEvent }) : undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Locks the whole composition, including the artifact directories. No automatic stale-lock theft.
  const rootLock = await open(join(directory, "host.lock"), "wx", 0o600);
  let workspace: FileSystemProjectWorkspace | undefined;
  let executions: FileSystemToolExecutionStore | undefined;
  let jobs: FileSystemRenderJobStore | undefined;
  let closed: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    if (!closed) closed = (async () => {
      const errors: unknown[] = [];
      for (const resource of [ownedRenderer, jobs, executions, workspace]) if (resource) {
        try { await resource.close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Persistent host close failed; host.lock retained for explicit recovery");
      await rootLock.close(); await rm(join(directory, "host.lock"));
    })();
    return closed;
  };
  try {
    await rootLock.writeFile(JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() })); await rootLock.sync();
    const artifacts = new FileSystemArtifactStore(join(directory, "artifacts"));
    const references = new FileSystemArtifactReferenceStore(join(directory, "references"));
    const lifecycle = new LocalArtifactLifecycleManager(artifacts, references);
    // Project/reference recovery completes before plugins can run. Execution reopening retains uncertainty.
    workspace = await FileSystemProjectWorkspace.open(join(directory, "projects"), lifecycle);
    executions = await FileSystemToolExecutionStore.open(join(directory, "executions"));
    jobs = await FileSystemRenderJobStore.open(join(directory, "jobs"));
    const projects = workspace, evidence = executions;
    const registry = new InMemoryAgentToolRegistry();
    const manager = new InMemoryPluginManager(registry, { projectSchemaVersion: "1.1.0", healthCheckTimeoutMs: Math.min(limits.maxTimeoutMs, 5000) });
    const renderer = options.renderer ?? ownedRenderer ?? new RemotionProjectGraphRenderer(options.renderEntryPoint ?? resolve("src/index.ts"));
    const rendering = async <Request extends ProjectGraphRenderRequest, T>(request: Request, work: (input: Request) => Promise<T>): Promise<T> => {
      try {
        const imageAssets = await loadRenderPngAssets(request, artifacts);
        return await work(imageAssets ? { ...request, imageAssets } : request);
      } catch (error) {
        if (error instanceof RenderWorkerError || error instanceof PngInputError) throw new CreativeHostError(error.code, error.message);
        throw error;
      }
    };
    const runtime: CreativeHostRuntime = {
      projects, artifacts, jobs, rendererIdentity: { id: renderer.id, version: renderer.version },
      readApprovedPng: (projectId, sourceId) => {
        const source = assetImports.find(source => source.projectId === projectId && source.sourceId === sourceId);
        if (!source) throw new CreativeHostError("HOST_ASSET_IMPORT_DENIED", "No approved PNG source with this ID in the project");
        return readApprovedPng(source, limits.maxArtifactBytes);
      },
      renderPreview: (request) => rendering(request, input => renderer.renderPreview(input)),
      renderVideo: (request) => rendering(request, input => renderer.renderVideo(input)),
      ...(renderer.measureLayout ? { measureLayout: (request: Parameters<NonNullable<typeof renderer.measureLayout>>[0]) =>
        rendering(request, input => renderer.measureLayout!(input)) } : {}),
      references: (id) => references.list({ artifactId: id }),
      retain: async (ref) => {
        if (ref.ownerType !== "tool-run" && ref.ownerType !== "render-job") throw new Error("Unsupported host retention owner");
        await lifecycle.attach(ref);
      },
      releaseJobOutputs: async (ownerId) => {
        await lifecycle.releaseOwner({ ownerType: "render-job", ownerId }, "host-output");
        // A retry can observe a missing reference after a previous unlink without a directory sync.
        await references.syncDirectory();
      },
      listExecutions: (id) => evidence.list(id),
      validateProject: (document) => assertValid(validateProject, document, "Project Schema"),
      validatePatch: (patch) => assertValid(validatePatch, patch, "Patch Schema"),
      validatePlugin: (plugin) => {
        assertValid(validatePlugin, plugin.manifest, "Plugin Manifest");
        for (const tool of plugin.tools) {
          assertValid(validateTool, tool.manifest, "Tool Manifest");
          // Compile standalone schemas now, not on the first agent call.
          const validator = new Ajv({ allErrors: true, strict: false });
          validator.compile(tool.manifest.inputSchema); validator.compile(tool.manifest.outputSchema);
        }
      },
      configurePlugins: async (plugins: AgentToolPlugin[]) => {
        for (const plugin of plugins) {
          const installed = manager.install(plugin); if (!installed.ok) throw new Error(JSON.stringify(installed.diagnostics));
          const pin = manager.pin(plugin.manifest.id, plugin.manifest.version); if (!pin.ok) throw new Error(JSON.stringify(pin.diagnostics));
        }
        // Only order exact host-selected plugins. This is not version solving or downloading code.
        const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
        const active = new Set<string>(), visiting = new Set<string>();
        const activate = async (id: string): Promise<void> => {
          if (active.has(id)) return;
          if (visiting.has(id)) throw new Error("Host plugin dependency cycle");
          visiting.add(id); const plugin = byId.get(id)!;
          for (const dep of plugin.manifest.dependencies ?? []) {
            if (byId.has(dep.pluginId)) await activate(dep.pluginId);
            else if (!dep.optional) throw new Error(`Missing selected dependency: ${dep.pluginId}`);
          }
          const result = await manager.activate(id, plugin.manifest.version);
          if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
          visiting.delete(id); active.add(id);
        };
        for (const id of byId.keys()) await activate(id);
        return registry;
      },
      plugins: {
        install: (plugin) => manager.install(plugin),
        list: () => manager.list(),
        exportLock: () => manager.exportLock(),
        activate: async (pluginId, version) => {
          const previous = manager.getStatus(pluginId);
          const unpinned = manager.unpin(pluginId);
          if (!unpinned.ok) return unpinned;
          const result = await manager.activate(pluginId, version);
          // The host serializes transitions; no other administrator can change this pin mid-switch.
          const pin = result.ok ? manager.pin(pluginId, version)
            : previous?.pinned ? manager.pin(pluginId, previous.version) : undefined;
          if (pin && !pin.ok) throw new Error(`Could not restore plugin pin: ${JSON.stringify(pin.diagnostics)}`);
          return { ...result, status: manager.getStatus(pluginId, version) ?? result.status };
        },
      },
      gateway: (grant, policy) => new LocalAgentToolGateway(registry, {
        executionStore: evidence, allowedPermissions: grant.permissions,
        allowDestructive: grant.allowDestructive === true, allowHighCost: grant.allowHighCost === true,
        maxAttempts: policy.maxAttempts, maxConcurrentCalls: policy.maxConcurrentCalls,
        defaultToolConcurrency: policy.defaultToolConcurrency, maxTimeoutMs: policy.maxTimeoutMs,
        artifactStore: artifacts,
        // The host wrapper retains authorized results using unambiguous JSON-tuple owners.
        // Do not also attach the legacy Gateway colon-separated owners.
      }),
      close: closeResources,
    };
    return await assembleCreativeHost(runtime, factories, { limits, renderJobs: jobPolicy });
  } catch (error) {
    try { await closeResources(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Host startup/recovery failed"); }
    throw error;
  }
}
