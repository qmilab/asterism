// Node-floor HTTP binding for the endpoint (Node 20+).
//
// The Bun path binds with `Bun.serve` (see `serve` in index.ts); off Bun this
// binds with `node:http` instead. Both wrap the SAME runtime-neutral
// `handleRequest`, which is written against the web-standard `Request`/`Response`
// — so the only job here is to bridge a Node `IncomingMessage`/`ServerResponse`
// to and from those web types. No routing, trust, or run logic lives here.
//
// Loaded lazily by `serve()` (a dynamic import on the off-Bun branch), so the Bun
// path never pulls `node:http`.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { RunningServer } from "./index.js";

// `duplex` is required when a Request carries a streamed body, but some
// `@types/node` 20.x releases omit it from `RequestInit`. Declare the field we set.
interface StreamRequestInit extends RequestInit {
  duplex?: "half";
}

/** Bridge a Node request into the web-standard `Request` that `handleRequest` expects. */
function toWebRequest(req: IncomingMessage, boundHost: string): Request {
  const method = req.method ?? "GET";
  // `handleRequest` does `new URL(req.url)`, so it needs an absolute URL. Prefer
  // the client's Host header; fall back to the interface we bound.
  const url = `http://${req.headers.host ?? boundHost}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }

  const init: StreamRequestInit = { method, headers };
  // GET/HEAD never carry a body; for the rest, stream the socket in so a large
  // body is not buffered into memory before the handler reads it.
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * Write a web-standard `Response` back over the Node `ServerResponse`, STREAMING
 * the body rather than buffering it. Streaming is load-bearing for SSE: each
 * `event:`/`data:` frame must flush to the client as the run produces it, not
 * after the run settles.
 */
function writeWebResponse(
  res: ServerResponse,
  web: Response,
  liveStreams: Set<ServerResponse>,
): void {
  const headers: Record<string, string> = {};
  web.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(web.status, headers);

  if (web.body === null) {
    res.end();
    return;
  }

  // A Server-Sent Events response is long-lived: it streams frames until the run
  // settles and never ends on its own. Track it so shutdown can force-close it —
  // a buffered response is NOT tracked, so it is left to drain (see `stop` below).
  const isStream = (headers["content-type"] ?? "").includes("text/event-stream");
  if (isStream) liveStreams.add(res);

  const body = Readable.fromWeb(web.body as ReadableStream<Uint8Array>);
  res.on("close", () => {
    liveStreams.delete(res);
    // If the client hangs up (closes an SSE connection), stop pulling from the
    // — possibly endless — source stream.
    body.destroy();
  });
  body.on("error", () => res.destroy());
  body.pipe(res);
}

/**
 * Bind the endpoint with `node:http` and start listening. Mirrors the Bun
 * `serve()` shape: resolves once listening, reporting the OS-assigned port (so
 * port 0 works) and a `stop()` that drains and shuts the socket down.
 */
export function serveNode(
  opts: { port: number; hostname: string },
  handler: (req: Request) => Promise<Response>,
): Promise<RunningServer> {
  // The SSE connections currently open. Only these are force-closed on shutdown;
  // in-flight buffered requests are left to finish.
  const liveStreams = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        writeWebResponse(res, await handler(toWebRequest(req, opts.hostname)), liveStreams);
      } catch {
        // `handleRequest` catches its own errors and answers with a Response, so a
        // throw here is a last-resort failure building the Request or writing the
        // head — answer with the same generic 500 the buffered path uses.
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: "Internal server error." }));
      }
    })();
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.hostname, () => {
      server.removeListener("error", reject);
      const boundPort = (server.address() as AddressInfo).port;
      resolve({
        port: boundPort,
        hostname: opts.hostname,
        url: `http://${opts.hostname}:${boundPort}`,
        // Graceful shutdown. `close()` stops accepting and resolves only once every
        // ACTIVE request has finished — so a buffered run/confirm in flight drains
        // and the caller (the CLI) tears down the store only after stop() resolves.
        // `closeIdleConnections()` drops idle keep-alive sockets that would
        // otherwise hold close() open, and the tracked SSE streams are force-closed
        // because they would never end on their own. In-flight buffered requests are
        // deliberately left untouched.
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeIdleConnections?.();
            for (const res of [...liveStreams]) res.destroy();
            liveStreams.clear();
          }),
      });
    });
  });
}
