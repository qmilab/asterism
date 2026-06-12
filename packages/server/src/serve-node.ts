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
function writeWebResponse(res: ServerResponse, web: Response): void {
  const headers: Record<string, string> = {};
  web.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(web.status, headers);

  if (web.body === null) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(web.body as ReadableStream<Uint8Array>);
  // If the CLIENT hangs up (closes an SSE connection early), stop pulling from the
  // source stream. This is per-connection cleanup only; it does not affect shutdown.
  res.on("close", () => body.destroy());
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
  const server = createServer((req, res) => {
    void (async () => {
      try {
        writeWebResponse(res, await handler(toWebRequest(req, opts.hostname)));
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
        // Graceful shutdown. `close()` stops accepting new connections and resolves
        // only once every ACTIVE request has finished. That covers BOTH buffered
        // runs and SSE runs: an SSE response's lifetime is bounded by its run
        // settling — the producer always ends with `controller.close()` — so it
        // drains like any other request rather than being force-closed while its
        // `executeRun` is still writing. The caller (the CLI) tears down the store
        // only after stop() resolves, so a run is never persisting into a closing
        // database. `closeIdleConnections()` drops idle keep-alive sockets that
        // would otherwise hold close() open. (A genuinely hung run blocks graceful
        // stop, as it would a buffered one; the CLI's second interrupt forces exit.)
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeIdleConnections?.();
          }),
      });
    });
  });
}
