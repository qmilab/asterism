// Shared HTTP primitives for the @qmilab/asterism-server surfaces.
//
// Both front doors — the single-agent `serve` endpoint (`index.ts`) and the
// install-wide operator console (`console.ts`) — are default-deny and runtime-
// agnostic (web-standard `Request`/`Response`, so each handler is testable without
// binding a socket). The security-critical bits (bearer parsing, the constant-time
// token compare, the generic 401) live HERE, in ONE place, so the two surfaces can
// never drift on how they authenticate. Nothing here knows about agents, the kernel,
// or routing — it is pure request/response plumbing.

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The default interface every surface binds — loopback only. Local-first: an
 * endpoint is not reachable beyond this machine unless a host explicitly overrides
 * it. Shared by `serve` and the console so the default can never differ between them.
 */
export const DEFAULT_HOSTNAME = "127.0.0.1";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** A JSON response with the given status. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A JSON error response: `{ "error": message }` with the given status. */
export function fail(status: number, message: string): Response {
  return json(status, { error: message });
}

/**
 * The one response shape for any failed authentication. Generic by design — a
 * missing, empty, malformed, or wrong token are indistinguishable to the client, so
 * the endpoint never confirms whether a token was "close" or whether a path exists.
 * Carries `WWW-Authenticate: Bearer` per the HTTP spec for a 401.
 */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized." }), {
    status: 401,
    headers: { ...JSON_HEADERS, "www-authenticate": "Bearer" },
  });
}

/** Pull the token out of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  // Case-insensitive scheme, one or more spaces, then a token that starts non-blank.
  // A header with no token after the scheme (`Bearer `) yields null and so fails
  // like an absent one.
  const match = /^Bearer +(\S.*)$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Constant-time bearer check. The presented and expected tokens are SHA-256'd first
 * so the comparison runs over equal-length digests — `timingSafeEqual` requires that,
 * and hashing also keeps the comparison from leaking the token's length. A missing
 * header (`null`) short-circuits to a non-match. The hashing is not a substitute for
 * a strong token; it only makes the compare itself timing-safe.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Serialize one Server-Sent Event frame: a named event with a JSON data line. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Frame an async run-bearing operation as Server-Sent Events: the `produce`
 * callback emits `activity`/`result`/`error` frames as the operation unfolds;
 * this wraps it in the web-standard `ReadableStream`/`TextEncoder` plumbing,
 * guarantees the stream is closed, and turns any unexpected throw into a generic
 * `error` frame (never leaking an internal message, matching the buffered 500).
 * Runtime-neutral (Bun and Node 20+) like the rest of the surface.
 */
export function sseResponse(
  produce: (send: (event: string, data: unknown) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      };
      try {
        await produce(send);
      } catch {
        // The kernel drives a run to a terminal state itself and does not throw for
        // run failures, so a throw here is an unexpected internal error.
        send("error", { error: "Internal server error." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
