import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Remotion collects a source URL each frame. Serve verified bytes once per render over loopback. */
export async function serveRenderWavSources(files: ReadonlyMap<string, Buffer>) {
  const token = randomUUID();
  const paths = new Map([...files].map(([id, bytes]) => [`/${token}/${id.slice(7)}.wav`, bytes]));
  const server = createServer((request, response) => {
    const bytes = paths.get(request.url ?? "");
    if (!bytes || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const { port } = server.address() as AddressInfo;
  return {
    url: (id: string) => `http://127.0.0.1:${port}/${token}/${id.slice(7)}.wav`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
