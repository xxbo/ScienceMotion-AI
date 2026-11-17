import type { Readable, Writable } from "node:stream";
import type { CreativeSession } from "../contracts/creative-host";
import { CREATIVE_CLIENT_PROTOCOL, type CreativeClientRequest, type CreativeClientResponse } from "../contracts/creative-client";
import { assertFiniteJson } from "./project-creative-edits";

export interface CreativeTraceSink { record(kind: string, data: unknown): Promise<void> }
export class CreativeTransportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function object(value: unknown, keys?: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (keys && Object.keys(value).some(key => !keys.includes(key))))
    throw new CreativeTransportError("TRANSPORT_REQUEST_INVALID", "Expected an object with only the documented fields");
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || value.includes("\0"))
    throw new CreativeTransportError("TRANSPORT_REQUEST_INVALID", "Request/tool identity must be a bounded non-empty string");
}
export function parseCreativeRequest(value: unknown): CreativeClientRequest {
  assertFiniteJson(value); object(value, ["id", "method", "params", "note"]); identity(value.id);
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 2048))
    throw new CreativeTransportError("TRANSPORT_REQUEST_INVALID", "The optional decision note must be at most 2048 characters");
  object(value.params);
  switch (value.method) {
    case "discover": break; // The host validates and filters the complete search query.
    case "manifest": object(value.params, ["toolId"]); identity(value.params.toolId); break;
    case "invoke":
      object(value.params, ["toolId", "toolVersion", "input", "runId", "callId", "idempotencyKey"]);
      for (const key of ["toolId", "toolVersion", "runId", "callId"]) identity(value.params[key]);
      if (!("input" in value.params)) throw new CreativeTransportError("TRANSPORT_REQUEST_INVALID", "Invocation input is required");
      break;
    case "close": object(value.params, []); break;
    default: throw new CreativeTransportError("TRANSPORT_METHOD_UNKNOWN", "Supported methods: discover, manifest, invoke, close");
  }
  return structuredClone(value) as CreativeClientRequest;
}

/** Bound bytes before decoding or parsing; a partial final frame is never executed. */
export async function* creativeRequestLines(input: Readable, maximum: number): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); let pending: Buffer[] = [], size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      size += end - offset;
      if (size > maximum) throw new CreativeTransportError("TRANSPORT_REQUEST_TOO_LARGE", "Request exceeds the configured byte limit");
      pending.push(bytes.subarray(offset, end));
      if (newline < 0) break;
      let line: string;
      try { line = decoder.decode(Buffer.concat(pending, size)); }
      catch { throw new CreativeTransportError("TRANSPORT_INVALID_UTF8", "Request is not valid UTF-8"); }
      pending = []; size = 0; offset = newline + 1;
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }
  if (size) throw new CreativeTransportError("TRANSPORT_TRUNCATED_REQUEST", "End of input before the terminating newline");
}
function writeLine(output: Writable, value: unknown): Promise<void> {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > 10 * 1024 * 1024) return Promise.reject(new CreativeTransportError("TRANSPORT_REPLY_TOO_LARGE", "Reply exceeds the transport limit"));
  return new Promise((resolve, reject) => {
    const error = (reason: Error) => { output.off("error", error); reject(reason); };
    output.once("error", error);
    output.write(line, (reason) => { if (reason) reject(reason); else { output.off("error", error); resolve(); } });
  });
}
const errorResponse = (id: string | null, code: string, message: string, fatal = false, outcomeUnknown = false): CreativeClientResponse =>
  ({ id, ok: false, error: { code, message, ...(fatal ? { fatal: true } : {}), ...(outcomeUnknown ? { outcomeUnknown: true } : {}) } });

/** Sequential dispatch provides backpressure. Only a pre-bound session is reachable from the wire. */
export async function serveCreativeStdio(options: {
  session: CreativeSession; input: Readable; output: Writable; trace: CreativeTraceSink;
  maxRequestBytes: number; close(): Promise<void>;
}): Promise<boolean> {
  const { session, input, output, trace } = options;
  let currentId: string | null = null, effectsPossible = false;
  const emit = async (value: unknown) => { await trace.record("response", value); await writeLine(output, value); };
  try {
    await emit({ type: "ready", protocolVersion: CREATIVE_CLIENT_PROTOCOL, projectId: session.projectId,
      methods: ["discover", "manifest", "invoke", "close"], maxRequestBytes: options.maxRequestBytes });
    for await (const line of creativeRequestLines(input, options.maxRequestBytes)) {
      currentId = null; effectsPossible = false;
      // Preserve the exact UTF-8 request text, including client-provided decision summaries.
      await trace.record("request", { text: line });
      let request: CreativeClientRequest;
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { throw new CreativeTransportError("TRANSPORT_PARSE_ERROR", "Expected one JSON request per line"); }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { id?: unknown }).id === "string")
          currentId = (parsed as { id: string }).id.slice(0, 128);
        request = parseCreativeRequest(parsed); currentId = request.id;
      } catch (error) {
        await emit(errorResponse(currentId, error instanceof CreativeTransportError ? error.code : "TRANSPORT_REQUEST_INVALID", error instanceof CreativeTransportError ? error.message : "Request must contain finite JSON data"));
        currentId = null;
        continue;
      }
      let response: CreativeClientResponse;
      try {
        let result: unknown;
        switch (request.method) {
          case "discover": result = await session.discover(request.params); break;
          case "manifest": result = (await session.manifest(request.params.toolId)) ?? null; break;
          case "invoke": effectsPossible = true; result = await session.invoke(request.params); break;
          case "close": await options.close(); result = { closed: true }; break;
        }
        response = { id: request.id, ok: true, result };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "TRANSPORT_DISPATCH_FAILED";
        response = errorResponse(request.id, code, error instanceof Error ? error.message : "Dispatch failed", false, effectsPossible);
      }
      await emit(response); effectsPossible = false;
      if (request.method === "close") return response.ok;
      currentId = null;
    }
    return true;
  } catch (error) {
    const code = error instanceof CreativeTransportError ? error.code : "TRANSPORT_IO_FAILED";
    // A lost trace/output write after invocation is not evidence of a rolled-back project mutation.
    try { await writeLine(output, errorResponse(currentId, code, "Transport stopped; consult persisted execution evidence before retrying an admitted invocation", true, effectsPossible)); } catch { /* Disconnected output cannot receive an acknowledgement. */ }
    return false;
  } finally { await options.close(); }
}
