import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import type { CreativeSession } from "../contracts/creative-host";
import { runCreativeLocalServer } from "./creative-local-server";
import { CreativeTransportError, serveCreativeStdio } from "./creative-stdio";

function output() {
  const chunks: Buffer[] = [];
  return { stream: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
    messages: () => Buffer.concat(chunks).toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}
const request = (id: string, method: string, params: unknown = {}, extra = {}) => ({ id, method, params, ...extra });
const invoke = (id: string, toolId: string, input: unknown = {}, extra = {}) => request(id, "invoke", {
  toolId, toolVersion: "1.0.0", input, runId: "wire-test", callId: id, ...extra,
});
const wire = (requests: unknown[]) => requests.map(r => JSON.stringify(r) + "\n").join("");

test("real stdio session creates/replays/snapshots, rejects authority injection and preserves state after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-stdio-"));
  try {
    const config = { schemaVersion: "1.0.0", directory: "workspace", traceFile: "first.jsonl",
      grant: { projectId: "bound", toolIds: ["project.create", "project.inspect", "project.snapshot.save"], permissions: ["project.read", "project.write", "snapshot.write"] },
      metadata: { actor: "test-fixture; not a real AI trial" } };
    const configFile = join(root, "config.json"); await writeFile(configFile, JSON.stringify(config));
    const requests = [
      request("discover", "discover"), request("manifest", "manifest", { toolId: "project.create" }),
      invoke("create", "project.create", { name: "中文初稿", episodeId: "approved" }, { idempotencyKey: "create-once" }),
      invoke("replay", "project.create", { name: "中文初稿", episodeId: "approved" }, { idempotencyKey: "create-once" }),
      invoke("snapshot", "project.snapshot.save", { snapshotId: "baseline", revisionId: "revision-initial" }),
      request("authority", "discover", {}, { grant: { permissions: ["project.delete"] } }),
      request("admin", "plugins.activate", { pluginId: "builtin.workspace", version: "99.0.0" }),
      request("foreign", "invoke", { ...invoke("x", "project.inspect").params as object, projectId: "other" }),
      invoke("wrong-version", "project.inspect", {}, { toolVersion: "2.0.0" }),
      invoke("inspect", "project.inspect", {}, { }),
      request("close", "close"), invoke("after-close", "project.create", { name: "Must not execute", episodeId: "bad" }),
    ];
    (requests[2] as Record<string, unknown>).note = "创建中文初稿，验证 UTF-8 分块输入。";
    const bytes = Buffer.from(wire(requests)), chunks = Array.from({ length: Math.ceil(bytes.length / 13) }, (_, i) => bytes.subarray(i * 13, (i + 1) * 13));
    const first = output(); assert.equal(await runCreativeLocalServer(configFile, { input: Readable.from(chunks), output: first.stream }), true);
    const messages = first.messages(), result = (id: string) => messages.find(m => m.id === id);
    assert.equal(messages[0].type, "ready"); assert.equal(messages[0].projectId, "bound");
    assert.equal(result("discover").result.total, 3); assert.equal(result("manifest").result.version, "1.0.0");
    assert.equal(result("create").result.ok, true); assert.deepEqual(result("replay").result.output, result("create").result.output);
    assert.equal(result("snapshot").result.ok, true);
    assert.equal(result("authority").error.code, "TRANSPORT_REQUEST_INVALID");
    assert.equal(result("admin").error.code, "TRANSPORT_METHOD_UNKNOWN");
    assert.equal(result("foreign").error.code, "TRANSPORT_REQUEST_INVALID");
    assert.equal(result("wrong-version").result.diagnostics[0].code, "HOST_TOOL_VERSION_MISMATCH");
    assert.equal(result("inspect").result.output.project.name, "中文初稿"); assert.equal(result("inspect").result.output.revisions.length, 1);
    assert.equal(result("after-close"), undefined);
    const traceText = await readFile(join(root, "first.jsonl"), "utf8"), trace = traceText.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(trace.map(r => r.sequence), trace.map((_, i) => i + 1));
    assert.deepEqual(trace[0].data.grant, config.grant);
    assert.ok(trace.some(r => r.kind === "request" && JSON.parse(r.data.text).note?.includes("UTF-8")));
    await assert.rejects(() => runCreativeLocalServer(configFile, { input: Readable.from([]), output: output().stream }), /EEXIST/);
    assert.equal(await readFile(join(root, "first.jsonl"), "utf8"), traceText, "A new session cannot overwrite trial evidence");
    await writeFile(configFile, JSON.stringify({ ...config, traceFile: "second.jsonl", grant: { ...config.grant, permissions: ["project.read"] } }));
    const second = output();
    assert.equal(await runCreativeLocalServer(configFile, { input: Readable.from([wire([
      request("discover", "discover"), invoke("denied", "project.create", { name: "Denied", episodeId: "bad" }, { runId: "wire-reopen" }),
      invoke("inspect", "project.inspect", {}, { runId: "wire-reopen" }), request("close", "close"),
    ])]), output: second.stream }), true);
    const after = second.messages(); assert.equal(after.find(m => m.id === "discover").result.total, 1);
    assert.equal(after.find(m => m.id === "denied").result.ok, false);
    assert.equal(after.find(m => m.id === "inspect").result.output.project.name, "中文初稿");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stdio imports a project-approved PNG from a config-relative path and replays one revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-stdio-png-"));
  try {
    const path = join(root, "config.json"), source = "approved.png";
    const image = new PNG({ width: 2, height: 2 });
    image.data.fill(255);
    await writeFile(join(root, source), PNG.sync.write(image));
    await writeFile(path, JSON.stringify({ schemaVersion: "1.0.0", directory: "workspace", traceFile: "png.jsonl",
      assetImports: [{ projectId: "p", sourceId: "approved", path: source }],
      grant: { projectId: "p", permissions: ["project.read", "project.write", "artifact.write"],
        toolIds: ["project.create", "assets.import", "project.inspect"] } }));
    const io = output(), params = { sourceId: "approved", assetId: "picture" }, replay = { idempotencyKey: "import-once" };
    assert.equal(await runCreativeLocalServer(path, { input: Readable.from([wire([
      invoke("create", "project.create", { name: "Assets", episodeId: "png" }),
      invoke("import", "assets.import", params, replay), invoke("replay", "assets.import", params, replay),
      invoke("inspect", "project.inspect"), request("close", "close"),
    ])]), output: io.stream }), true);
    const messages = io.messages();
    const imported = messages.find(m => m.id === "import").result;
    assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
    assert.deepEqual(messages.find(m => m.id === "replay").result.output, imported.output);
    const project = messages.find(m => m.id === "inspect").result.output;
    assert.deepEqual(project.assets, [imported.output.asset]);
    assert.equal(project.revisions.length, 2);
    assert.doesNotMatch(await readFile(join(root, "png.jsonl"), "utf8"), /approved\.png/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fakeSession(counter: { calls: number }): CreativeSession {
  return { projectId: "p", discover: async () => ({ tools: [], total: 0, limit: 50, offset: 0 }), manifest: async () => undefined,
    jobs: { submit: async () => { throw new Error("Unexpected job call"); }, get: async () => undefined,
      list: async () => ({ jobs: [], total: 0, offset: 0, limit: 50 }), cancel: async () => { throw new Error("Unexpected job call"); } },
    invoke: async () => { counter.calls++; return { ok: true, output: { mutation: counter.calls }, diagnostics: [] }; }, revoke() {} };
}
test("malformed requests cannot mutate, while framing/UTF-8/byte-limit errors close the transport", async () => {
  for (const [tail, code] of [
    [Buffer.from("x".repeat(300)), "TRANSPORT_REQUEST_TOO_LARGE"],
    [Buffer.from([0xc3, 10]), "TRANSPORT_INVALID_UTF8"],
    [Buffer.from(JSON.stringify(invoke("partial", "project.create"))), "TRANSPORT_TRUNCATED_REQUEST"],
  ] as const) {
    const counter = { calls: 0 }, collected = output(); let closed = false;
    const prefix = Buffer.from("not-json\n" + wire([request("first", "manifest", { toolId: "project.inspect" })]));
    const ok = await serveCreativeStdio({ session: fakeSession(counter), input: Readable.from([prefix, tail]), output: collected.stream,
      trace: { record: async () => {} }, maxRequestBytes: 256, close: async () => { closed = true; } });
    assert.equal(ok, false); assert.equal(counter.calls, 0); assert.equal(closed, true);
    const messages = collected.messages(); assert.equal(messages[1].error.code, "TRANSPORT_PARSE_ERROR");
    assert.equal(messages.at(-1).error.code, code); assert.equal(messages.at(-1).id, null);
  }
});

test("trace failure before dispatch prevents effects; failure after dispatch reports uncertainty and stops later calls", async () => {
  for (const phase of ["before", "after"]) {
    const counter = { calls: 0 }, collected = output(); let closed = false;
    const ok = await serveCreativeStdio({ session: fakeSession(counter), input: Readable.from([wire([invoke("one", "project.create"), invoke("two", "project.create")])]),
      output: collected.stream, maxRequestBytes: 1024, close: async () => { closed = true; }, trace: { record: async (kind, data) => {
        if ((phase === "before" && kind === "request") || (phase === "after" && kind === "response" && (data as { id?: string }).id === "one"))
          throw new CreativeTransportError("TRANSPORT_TRACE_FAILED", "seeded trace write failure");
      } } });
    assert.equal(ok, false); assert.equal(closed, true); assert.equal(counter.calls, phase === "before" ? 0 : 1);
    const fatal = collected.messages().at(-1); assert.equal(fatal.error.code, "TRANSPORT_TRACE_FAILED");
    assert.equal(fatal.error.outcomeUnknown === true, phase === "after");
  }
});

test("output disconnect after an invocation drains without executing a queued second request", async () => {
  let writes = 0, closed = false; const counter = { calls: 0 };
  const broken = new Writable({ write(_chunk, _encoding, done) { done(++writes > 1 ? new Error("closed pipe") : undefined); } });
  assert.equal(await serveCreativeStdio({ session: fakeSession(counter), input: Readable.from([wire([invoke("one", "project.create"), invoke("two", "project.create")])]),
    output: broken, maxRequestBytes: 1024, trace: { record: async () => {} }, close: async () => { closed = true; } }), false);
  assert.equal(closed, true); assert.equal(counter.calls, 1);
});

test("CLI is a clean JSON-lines process and closes its filesystem host on normal EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-stdio-cli-"));
  try {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ schemaVersion: "1.0.0", directory: "workspace", traceFile: "cli.jsonl", grant: { projectId: "p" } }));
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/creative-host-server.ts", "--config", path], {
      input: wire([request("discover", "discover")]), encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, "");
    const messages = child.stdout.trim().split("\n").map(line => JSON.parse(line)); assert.equal(messages.length, 2);
    assert.equal(messages[0].protocolVersion, "1.0.0"); assert.equal(messages[1].result.total, 0);
    await assert.rejects(() => readFile(join(root, "workspace", "host.lock")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an already-aborted local client closes without accepting project calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "science-stdio-abort-"));
  try {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ schemaVersion: "1.0.0", directory: "workspace", traceFile: "abort.jsonl", grant: { projectId: "p", toolIds: ["project.create"], permissions: ["project.write"] } }));
    const controller = new AbortController(); controller.abort(); const collected = output();
    assert.equal(await runCreativeLocalServer(path, { input: Readable.from([wire([invoke("create", "project.create", { name: "No", episodeId: "no" })])]), output: collected.stream, signal: controller.signal }), false);
    const records = (await readFile(join(root, "abort.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.filter(r => r.kind === "request").length, 0);
    await assert.rejects(() => readFile(join(root, "workspace", "host.lock")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
