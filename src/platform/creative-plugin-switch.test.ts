import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeHost, CreativePermission, CreativePluginFactory, CreativeSession } from "../contracts/creative-host";
import { openCreativeHost } from "./creative-host";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const id = "test.versioned", toolId = `${id}.run`;
function fixture(version: string, options: {
  healthCheck?: () => Promise<{ ok: boolean; message?: string }>;
  beforeExecute?: () => Promise<void>; inputType?: "string" | "number";
  permissions?: CreativePermission[]; toolVersion?: string; invalidRegistration?: boolean;
} = {}): CreativePluginFactory {
  return { id, version, create: () => {
    const rights = options.permissions ?? [], type = options.inputType ?? "string";
    const tool = {
      manifest: { id: toolId, version: options.toolVersion ?? version, namespace: id, pluginId: id,
        name: "Versioned tool", description: "Host integration fixture", category: "test", projectSchemaVersions: ["1.1.0"],
        inputSchema: { $id: "https://example.test/versioned-input", type: "object", required: ["value"], additionalProperties: false, properties: { value: { type } } },
        outputSchema: { type: "object", required: ["implementation", "value"], properties: { implementation: { const: version }, value: { type } } },
        execution: { deterministic: true, stateful: false, destructive: false, cost: "low" as const, idempotent: true, permissions: rights } },
      execute: async (input: unknown) => {
        await options.beforeExecute?.();
        return { ok: true, output: { implementation: version, value: (input as { value: unknown }).value }, diagnostics: [] };
      },
    };
    const tools = [tool];
    if (options.invalidRegistration) tools.push({ ...tool, manifest: { ...tool.manifest, id: "test.other.wrong-namespace" } });
    return { manifest: { id, version, name: "Versioned plugin", description: "Host integration fixture",
      projectSchemaVersions: ["1.1.0"], permissions: rights, toolIds: tools.map(t => t.manifest.id) }, tools, healthCheck: options.healthCheck };
  } };
}
let counter = 0;
const invoke = (s: CreativeSession, version: string, value: string | number = "value", idempotencyKey?: string) => s.invoke({
  toolId, toolVersion: version, input: { value }, runId: "switch-test", callId: `call-${++counter}`, ...(idempotencyKey ? { idempotencyKey } : {}),
});
const session = (host: CreativeHost, permissions: CreativePermission[] = []) => host.createSession({ projectId: "p", toolIds: [toolId], permissions });

test("host switches exact implementations/schemas, preserves versioned retries, rolls back and reopens with an explicit lock choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-switch-")); let host: CreativeHost | undefined, executions = 0;
  const first = fixture("1.0.0", { beforeExecute: async () => { executions++; } });
  const second = fixture("2.0.0", { inputType: "number", beforeExecute: async () => { executions++; } });
  try {
    host = await openCreativeHost({ directory: root, plugins: [first] }); let s = session(host);
    const old = await invoke(s, "1.0.0", "original", "once"); assert.equal(old.ok, true);
    assert.ok(host.plugins.install(second).ok);
    assert.equal((await s.manifest(toolId))!.version, "1.0.0", "Installation alone cannot publish a candidate");
    assert.equal(host.plugins.install(second).diagnostics[0].code, "PLUGIN_ALREADY_INSTALLED");
    assert.throws(() => host!.plugins.install(fixture("3.0.0", { toolVersion: "1.0.0" })), /distinct tool version/);
    assert.ok((await host.plugins.activate(id, "2.0.0")).ok);
    assert.equal((await s.discover()).tools[0].version, "2.0.0");
    assert.equal((await invoke(s, "1.0.0")).diagnostics[0].code, "HOST_TOOL_VERSION_MISMATCH");
    assert.equal((await invoke(s, "2.0.0", "invalid")).diagnostics[0].code, "TOOL_INPUT_INVALID");
    const upgraded = await invoke(s, "2.0.0", 42, "once");
    assert.deepEqual(upgraded.output, { implementation: "2.0.0", value: 42 }); assert.equal(executions, 2);
    assert.ok((await host.plugins.activate(id, "1.0.0")).ok);
    assert.deepEqual((await invoke(s, "1.0.0", "original", "once")).output, old.output); assert.equal(executions, 2);
    assert.ok((await host.plugins.activate(id, "2.0.0")).ok);
    const lock = host.plugins.exportLock(); assert.equal(lock.plugins[id], "2.0.0");
    await host.close(); host = await openCreativeHost({ directory: root, plugins: [second] }); s = session(host);
    assert.deepEqual(host.plugins.exportLock(), lock);
    assert.deepEqual((await invoke(s, "2.0.0", 42, "once")).output, upgraded.output); assert.equal(executions, 2);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed health checks and partial registry publication preserve the old catalogue, pin and usable tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-fail-")); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root, limits: { maxTimeoutMs: 200 }, plugins: [fixture("1.0.0")] }); const s = session(host);
    const before = await s.discover(), lock = host.plugins.exportLock();
    for (const [candidate, code] of [
      [fixture("2.0.0", { healthCheck: async () => ({ ok: false, message: "Seeded failed upgrade" }) }), "PLUGIN_HEALTH_CHECK_FAILED"],
      [fixture("3.0.0", { invalidRegistration: true }), "PLUGIN_ENABLE_FAILED"],
      [fixture("4.0.0", { healthCheck: () => new Promise(() => {}) }), "PLUGIN_HEALTH_CHECK_FAILED"],
    ] as const) {
      assert.ok(host.plugins.install(candidate).ok);
      const result = await host.plugins.activate(id, candidate.version);
      assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, code);
      if (candidate.version === "4.0.0") assert.match(result.diagnostics[0].message, /timed out/);
      assert.deepEqual(await s.discover(), before); assert.deepEqual(host.plugins.exportLock(), lock);
      assert.equal((await invoke(s, "1.0.0")).ok, true); assert.equal(host.status().state, "ready");
      assert.equal(host.plugins.list().find(p => p.version === "1.0.0")!.pinned, true);
    }
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("host rejects incompatible upgrades and upgrades that break an enabled dependent", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-dependencies-")); let host: CreativeHost | undefined;
  const dependent: CreativePluginFactory = { id: "test.dependent", version: "1.0.0", create: () => ({
    manifest: { id: "test.dependent", version: "1.0.0", name: "Dependent", description: "Requires version one",
      dependencies: [{ pluginId: id, versionRange: "^1.0.0" }], toolIds: [], projectSchemaVersions: ["1.1.0"] }, tools: [],
  }) };
  try {
    host = await openCreativeHost({ directory: root, plugins: [fixture("1.0.0"), dependent] }); const s = session(host), lock = host.plugins.exportLock();
    const incompatible = fixture("3.0.0");
    const factory: CreativePluginFactory = { ...incompatible, create: services => {
      const plugin = incompatible.create(services); return { ...plugin, manifest: { ...plugin.manifest, projectSchemaVersions: ["9.0.0"] } };
    } };
    for (const [candidate, code] of [[fixture("2.0.0"), "PLUGIN_BREAKS_DEPENDENT"], [factory, "PLUGIN_SCHEMA_INCOMPATIBLE"]] as const) {
      assert.ok(host.plugins.install(candidate).ok);
      const result = await host.plugins.activate(id, candidate.version);
      assert.equal(result.ok, false); assert.ok(result.diagnostics.some(d => d.code === code));
      assert.deepEqual(host.plugins.exportLock(), lock); assert.equal((await invoke(s, "1.0.0")).ok, true);
    }
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("an upgrade cannot expand existing session grants or invoke administrative changes from inside a tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-grants-")); let host: CreativeHost | undefined;
  try {
    host = await openCreativeHost({ directory: root, plugins: [fixture("1.0.0")] }); const restricted = session(host);
    host.plugins.install(fixture("2.0.0", { permissions: ["project.write"] }));
    assert.ok((await host.plugins.activate(id, "2.0.0")).ok);
    assert.equal((await restricted.discover()).total, 0); assert.equal(await restricted.manifest(toolId), undefined);
    assert.equal((await invoke(restricted, "2.0.0")).diagnostics[0].code, "HOST_TOOL_DENIED");
    assert.equal((await invoke(session(host, ["project.write"]), "2.0.0")).ok, true);
    host.plugins.install(fixture("3.0.0", { beforeExecute: async () => { await host!.plugins.activate(id, "1.0.0"); } }));
    assert.ok((await host.plugins.activate(id, "3.0.0")).ok);
    assert.equal((await invoke(restricted, "3.0.0")).diagnostics[0].code, "HOST_PLUGIN_ADMIN_SCOPE");
    assert.equal(host.plugins.exportLock().plugins[id], "3.0.0");
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("switching removes obsolete manifests and does not grant newly introduced tool IDs to existing sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-catalogue-")); let host: CreativeHost | undefined;
  const withExtra = (version: string, extraId: string): CreativePluginFactory => {
    const base = fixture(version);
    return { ...base, create: services => {
      const plugin = base.create(services), tool = plugin.tools[0], inputSchema = { ...tool.manifest.inputSchema };
      delete inputSchema.$id;
      return { ...plugin, manifest: { ...plugin.manifest, toolIds: [toolId, extraId] },
        tools: [tool, { ...tool, manifest: { ...tool.manifest, id: extraId, inputSchema } }] };
    } };
  };
  const legacy = `${id}.legacy`, added = `${id}.added`;
  try {
    host = await openCreativeHost({ directory: root, plugins: [withExtra("1.0.0", legacy)] });
    const s = host.createSession({ projectId: "p", toolIds: [toolId, legacy] });
    assert.ok(await s.manifest(legacy));
    host.plugins.install(withExtra("2.0.0", added)); assert.ok((await host.plugins.activate(id, "2.0.0")).ok);
    assert.equal(await s.manifest(legacy), undefined); assert.equal(await s.manifest(added), undefined);
    assert.deepEqual((await s.discover()).tools.map(t => t.id), [toolId]);
    for (const requested of [legacy, added]) {
      const result = await s.invoke({ toolId: requested, toolVersion: "2.0.0", input: { value: "test" }, runId: "catalogue", callId: requested });
      assert.equal(result.diagnostics[0].code, "HOST_TOOL_DENIED");
    }
    const granted = host.createSession({ projectId: "p", toolIds: [added] });
    const result = await granted.invoke({ toolId: added, toolVersion: "2.0.0", input: { value: "test" }, runId: "catalogue", callId: "granted" });
    assert.deepEqual(result.output, { implementation: "2.0.0", value: "test" });
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("switch admission waits for real timed-out work, blocks concurrent changes and resumes the same session", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-drain-")); let host: CreativeHost | undefined;
  const entered = deferred(), finish = deferred(), health = deferred(), healthy = deferred(); let transition: Promise<unknown> | undefined;
  try {
    host = await openCreativeHost({ directory: root, limits: { maxTimeoutMs: 100 }, plugins: [fixture("1.0.0", {
      beforeExecute: async () => { entered.resolve(); await finish.promise; },
    })] }); const s = session(host);
    host.plugins.install(fixture("2.0.0", { healthCheck: async () => { health.resolve(); await healthy.promise; return { ok: true }; } }));
    const old = invoke(s, "1.0.0"); await entered.promise;
    assert.equal((await old).diagnostics[0].code, "TOOL_TIMEOUT");
    let completed = false; transition = host.plugins.activate(id, "2.0.0").then(result => { assert.ok(result.ok); completed = true; });
    assert.equal(host.status().state, "switching");
    assert.equal((await invoke(s, "1.0.0")).diagnostics[0].code, "HOST_PLUGIN_SWITCHING");
    await assert.rejects(() => host!.plugins.activate(id, "1.0.0"), /transition/);
    assert.throws(() => host!.plugins.install(fixture("3.0.0")), /transition/);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    finish.resolve(); await health.promise;
    await assert.rejects(() => s.discover(), /transition/);
    healthy.resolve(); await transition;
    assert.equal((await invoke(s, "2.0.0")).ok, true);
  } finally { finish.resolve(); healthy.resolve(); await transition?.catch(() => undefined); await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("closing during candidate preflight drains the transition and never reopens admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-plugin-close-")); let host: CreativeHost | undefined;
  const entered = deferred(), finish = deferred(); let transition: Promise<unknown> | undefined;
  try {
    host = await openCreativeHost({ directory: root, plugins: [fixture("1.0.0")] }); const s = session(host);
    host.plugins.install(fixture("2.0.0", { healthCheck: async () => { entered.resolve(); await finish.promise; return { ok: true }; } }));
    transition = host.plugins.activate(id, "2.0.0"); await entered.promise;
    let closed = false; const closing = host.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    finish.resolve(); await transition; await closing;
    assert.equal(host.status().state, "closed"); assert.equal((await invoke(s, "2.0.0")).diagnostics[0].code, "HOST_CLOSED");
  } finally { finish.resolve(); await transition?.catch(() => undefined); await host?.close(); await rm(root, { recursive: true, force: true }); }
});
