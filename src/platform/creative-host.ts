import Ajv, { type ValidateFunction } from "ajv";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentToolPlugin } from "../contracts/agent-plugin";
import type { CreativeHost, CreativeHostLimits, CreativePluginFactory } from "../contracts/creative-host";
import { FileSystemArtifactStore } from "./artifact-store";
import { FileSystemArtifactReferenceStore, LocalArtifactLifecycleManager } from "./artifact-lifecycle";
import { FileSystemProjectWorkspace } from "./filesystem-project-workspace";
import { FileSystemToolExecutionStore } from "./filesystem-tool-execution-store";
import { InMemoryPluginManager } from "./plugin-manager";
import { InMemoryAgentToolRegistry, LocalAgentToolGateway } from "./tool-registry";
import { assembleCreativeHost, resolveCreativeLimits, type CreativeHostRuntime } from "./creative-host-core";
import { workspacePlugin } from "./workspace-tools";
import type { ProjectGraphRenderer } from "../contracts/renderer";
import { RemotionProjectGraphRenderer } from "../renderers/remotion/remotion-project-graph-renderer";
import projectSchema from "../../schemas/project.schema.json";
import patchSchema from "../../schemas/project-patch.schema.json";
import toolSchema from "../../schemas/tool-manifest.schema.json";
import pluginSchema from "../../schemas/plugin-manifest.schema.json";

export interface OpenCreativeHostOptions {
  /** Trusted application configuration only; tools/sessions never accept filesystem paths. */
  directory: string;
  plugins?: readonly CreativePluginFactory[];
  limits?: Partial<CreativeHostLimits>;
  renderer?: ProjectGraphRenderer;
  renderEntryPoint?: string;
}
function assertValid(validate: ValidateFunction, value: unknown, label: string): void {
  if (!validate(value)) throw new Error(`${label}: ${JSON.stringify(validate.errors)}`);
}

/** Assemble one local, exclusive-writer host using the delivered F storage and execution implementations. */
export async function openCreativeHost(options: OpenCreativeHostOptions): Promise<CreativeHost> {
  const limits = resolveCreativeLimits(options.limits);
  if (typeof options.directory !== "string" || !options.directory.trim()) throw new Error("Host directory is required");
  const directory = resolve(options.directory);
  const factories = [workspacePlugin, ...(options.plugins ?? [])].map((f) => ({ id: f.id, version: f.version, create: f.create.bind(f) }));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateProject = ajv.compile(projectSchema);
  const validatePatch = ajv.compile(patchSchema);
  const validateTool = ajv.compile(toolSchema);
  const validatePlugin = ajv.compile(pluginSchema);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Locks the whole composition, including the artifact directories. No automatic stale-lock theft.
  const rootLock = await open(join(directory, "host.lock"), "wx", 0o600);
  let workspace: FileSystemProjectWorkspace | undefined;
  let executions: FileSystemToolExecutionStore | undefined;
  let closed: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    if (!closed) closed = (async () => {
      const errors: unknown[] = [];
      for (const resource of [executions, workspace]) if (resource) {
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
    const projects = workspace, evidence = executions;
    const registry = new InMemoryAgentToolRegistry();
    const manager = new InMemoryPluginManager(registry, { projectSchemaVersion: "1.1.0", healthCheckTimeoutMs: Math.min(limits.maxTimeoutMs, 5000) });
    const renderer = options.renderer ?? new RemotionProjectGraphRenderer(options.renderEntryPoint ?? resolve("src/index.ts"));
    const runtime: CreativeHostRuntime = {
      projects, artifacts,
      renderPreview: (request) => renderer.renderPreview(request),
      renderVideo: (request) => renderer.renderVideo(request),
      references: (id) => references.list({ artifactId: id }),
      retain: async (ref) => {
        if (ref.ownerType !== "tool-run") throw new Error("Unsupported host retention owner");
        await lifecycle.attach({ ...ref, ownerType: "tool-run" });
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
    return await assembleCreativeHost(runtime, factories, { limits });
  } catch (error) {
    try { await closeResources(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Host startup/recovery failed"); }
    throw error;
  }
}
