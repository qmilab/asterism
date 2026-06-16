// @qmilab/asterism-server — a thin local HTTP endpoint over the kernel.
//
// Phase 0 endpoints, each scoped to ONE served agent:
//   POST /agents/:agent/runs              start a run; body { "input": "<task>" }
//                                         Accept: text/event-stream ⇒ live SSE activity
//   POST /agents/:agent/runs/:run/confirm approve a paused run and let it finish
//                                         (same Accept header streams the resume)
//   GET  /agents/:agent/runs              list the agent's runs
//   GET  /agents/:agent/events            read the agent's event log (tail params)
//
// Thin by mandate (CLAUDE.md): the handler parses the request, calls ONE kernel
// operation, and serializes the result. No trust reasoning, no scoping decisions,
// no run orchestration live here — `executeRun` / `resumeRun` and the agent-scoped
// repositories own all of that, so the HTTP surface inherits the CLI's exact
// guarantees.
//
// One agent per server. A server instance is bound to the single agent that
// `asterism serve <agent>` named; the `:agent` segment must match that name, and
// any other name is a 404. A process serving `personal` is therefore never a back
// door to `work` — the "separate lives" guarantee holds at the network edge too,
// not only in storage. (The REST path keeps `:agent` for forward-compatibility;
// in Phase 0 it is pinned to the served agent.)
//
// No interactive confirmation exists mid-run over HTTP, so a destructive action
// takes the safe default: it stays paused and the run returns
// `awaiting_confirmation` rather than executing unattended. The confirm endpoint is
// how that pause is cleared out of band — an explicit, separate request that
// re-enters the loop with only the capability it stopped on approved. The
// destructive-action gate fires at every trust level (golden rule 4); the kernel,
// not this surface, enforces it on the initial run and on every resume.
//
// The request handler is written against the web-standard `Request`/`Response`, so
// it is runtime-agnostic and testable without binding a socket. `serve()` is the
// only runtime-specific seam: it wraps `handleRequest` in `Bun.serve` under Bun
// and in `node:http` off Bun (Node 20+) — see `serve-node.ts`.

import { createHash, timingSafeEqual } from "node:crypto";

import { executeRun, resumeRun } from "@qmilab/asterism-core";
import type {
  Agent,
  AsterismStore,
  Capability,
  ExecuteRunOptions,
  ExecuteRunResult,
  ResumeOutcome,
  RuntimeAdapter,
  TailOptions,
} from "@qmilab/asterism-core";

/**
 * Everything the HTTP surface needs, injectable so the handler is testable
 * without a socket. The store and the served agent are resolved once at startup;
 * the surface that wires this (the CLI) supplies them along with the substrate.
 */
export interface ServerDeps {
  /** The open kernel store. */
  store: AsterismStore;
  /** The single agent this server serves (resolved at startup). */
  agent: Agent;
  /**
   * The bearer token every request must present as `Authorization: Bearer <token>`.
   * Required, with no unauthenticated mode — the surface is default-deny, so a server
   * cannot be stood up without one. The host (the CLI) resolves it from the
   * environment or a persisted per-server secret and injects it here; this surface
   * only verifies it. It is a per-server operator secret, never an agent credential,
   * and never appears in a response, the event log, or any error.
   */
  authToken: string;
  /**
   * The substrate for executing runs. Absent ⇒ `POST /runs` returns 503 (no model
   * configured); the read endpoints still work, so an install with no model can
   * still be inspected over HTTP.
   */
  adapter?: RuntimeAdapter;
  /** When `adapter` is absent, a client-facing explanation of what to configure. */
  adapterReason?: string;
  /**
   * Reads a file's text (soul + skill bodies); forwarded to `executeRun`. Absent ⇒
   * souls resolve to built-ins only and skills are framed by name.
   */
  readFile?: (path: string) => string;
  /**
   * Capabilities to expose to runs; forwarded to `executeRun` untouched, so the
   * kernel's trust profile + gate decide what each run may do with them. Absent ⇒
   * none (Phase 0 registers no capabilities). This mirrors the CLI's seam — a host
   * that wires capabilities must see identical tool exposure whether a run is
   * triggered by `asterism run` or over HTTP.
   */
  capabilities?: readonly Capability[];
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function fail(status: number, message: string): Response {
  return json(status, { error: message });
}

/**
 * The one response shape for any failed authentication. Generic by design — a
 * missing, empty, malformed, or wrong token are indistinguishable to the client, so
 * the endpoint never confirms whether a token was "close" or whether a path exists.
 * Carries `WWW-Authenticate: Bearer` per the HTTP spec for a 401.
 */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized." }), {
    status: 401,
    headers: { ...JSON_HEADERS, "www-authenticate": "Bearer" },
  });
}

/** Pull the token out of an `Authorization: Bearer <token>` header, or null. */
function bearerToken(req: Request): string | null {
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
function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** GET /agents/:agent/runs — the agent's runs, oldest-first (scoped by the repo). */
function listRuns(deps: ServerDeps): Response {
  return json(200, { runs: deps.store.runs.list(deps.agent.id) });
}

/** GET /agents/:agent/events — the agent's event log, with optional tail params. */
function listEvents(deps: ServerDeps, url: URL): Response {
  const options: TailOptions = {};

  // An absent param is `null`; an empty one (`?type=`) is `""`. Treat both as "not
  // given" so an empty value means "no filter" — matching the CLI, where a flag
  // with no value is dropped — rather than filtering on `type = ''` / an empty
  // cursor and silently returning nothing.
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw) {
    // A present, non-empty `limit` must be a non-negative integer or it is a
    // client error, never a silently-ignored garbage value.
    if (!/^\d+$/.test(limitRaw)) {
      return fail(400, "limit must be a non-negative integer.");
    }
    options.limit = Number(limitRaw);
  }
  const type = url.searchParams.get("type");
  if (type) options.type = type;
  // `run` filters to one run's events. Exact match (a full run id, as `GET /runs`
  // returns) and ANDed with the agent scope by `tail`, so an unknown or foreign run
  // id simply matches nothing — never another agent's log. This mirrors the CLI's
  // `--run`; the CLI additionally resolves a short-id prefix and reports a miss,
  // human affordances an API client does not need (it holds the full id already).
  const run = url.searchParams.get("run");
  if (run) options.runId = run;
  const since = url.searchParams.get("since");
  if (since) options.sinceId = since;

  return json(200, { events: deps.store.events.tail(deps.agent.id, options) });
}

/**
 * The wire body for a settled run — the shape EVERY run-bearing path returns, in
 * one place so the buffered and streamed paths (start AND confirm) can never drift.
 * References only: `actions` carries capability keys and effects, never an action's
 * args. `status` conveys done / failed / awaiting_confirmation.
 */
function runResultBody(result: ExecuteRunResult): Record<string, unknown> {
  return {
    run: result.run,
    status: result.status,
    output: result.output,
    actions: result.actions,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/**
 * The substrate-side host concerns the run-bearing endpoints forward to the kernel
 * — built once so `start` and `confirm` hand the run the SAME soul/skill reader and
 * tool catalog (no per-endpoint drift). The kernel still does the trust scoping and
 * gating; this only carries the host's seams.
 */
function runOptions(deps: ServerDeps, adapter: RuntimeAdapter): ExecuteRunOptions {
  return {
    adapter,
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
  };
}

/** POST /agents/:agent/runs — execute a run through the kernel; body { input }. */
async function startRun(deps: ServerDeps, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Request body must be JSON.");
  }
  const input = (body as { input?: unknown } | null)?.input;
  if (typeof input !== "string" || input.trim().length === 0) {
    return fail(400, 'Request body must be a JSON object with a non-empty "input" string.');
  }
  if (!deps.adapter) {
    // 503: the server is up and reads work, but it cannot run an agent until a
    // model is configured. The reason mirrors what `asterism run` would print.
    return fail(503, deps.adapterReason ?? "No model is configured, so runs cannot execute.");
  }
  // Capture the now-resolved adapter so it narrows inside the streaming closure
  // below (TS does not carry the `!deps.adapter` guard across a nested function).
  const adapter = deps.adapter;

  // A client that asks for an event stream watches the run live; everyone else
  // gets the single JSON blob after it settles. Same kernel call either way — the
  // run executes identically, only the wire framing differs.
  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return sseResponse(async (send) => {
      const result = await executeRun(deps.store, deps.agent, input, {
        ...runOptions(deps, adapter),
        onEvent: (runEvent) => send("activity", runEvent),
      });
      send("result", runResultBody(result));
    });
  }

  // The kernel owns the run. No `confirm` is supplied: over HTTP a destructive
  // action takes the safe default and the run returns `awaiting_confirmation`
  // rather than executing without a human — cleared later via the confirm endpoint.
  const result = await executeRun(deps.store, deps.agent, input, runOptions(deps, adapter));

  // 201: the run resource was created and executed.
  return json(201, runResultBody(result));
}

/**
 * POST /agents/:agent/runs/:run/confirm — clear a gate pause out of band. The run
 * the model could not finish unattended (it parked at `awaiting_confirmation` with
 * no one to confirm) is re-entered with only the capability it stopped on approved.
 * The gate is not weakened: `resumeRun` grants per-capability, scoped to this one
 * run, and records the grant; a different destructive action pauses the run again.
 *
 * Buffered: 200 with the settled run, 404 for an unknown run, 409 for a run that
 * is not awaiting confirmation, 503 when no model is configured. Streaming (Accept:
 * text/event-stream) frames the resume live, then a terminal `result` (or `error`).
 */
async function confirmRun(deps: ServerDeps, req: Request, runId: string): Promise<Response> {
  if (!deps.adapter) {
    return fail(503, deps.adapterReason ?? "No model is configured, so runs cannot resume.");
  }
  const adapter = deps.adapter;

  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return sseResponse(async (send) => {
      const outcome = await resumeRun(deps.store, deps.agent, runId, {
        ...runOptions(deps, adapter),
        onEvent: (runEvent) => send("activity", runEvent),
      });
      if (outcome.kind === "resumed") {
        send("result", runResultBody(outcome.result));
      } else {
        // SSE carries the refusal as a frame — the response status is already 200.
        send("error", confirmRefusal(outcome));
      }
    });
  }

  const outcome = await resumeRun(deps.store, deps.agent, runId, runOptions(deps, adapter));
  if (outcome.kind === "not_found") {
    return fail(404, "No such run for this agent.");
  }
  if (outcome.kind === "not_paused") {
    // 409 Conflict: the run exists but is not awaiting confirmation, so there is
    // nothing to confirm. The current status is returned so the client can see why.
    return json(409, { ...confirmRefusal(outcome), run: outcome.run });
  }
  return json(200, runResultBody(outcome.result));
}

/** The error body for a confirm that could not resume (unknown / not-paused run). */
function confirmRefusal(
  outcome: Exclude<ResumeOutcome, { kind: "resumed" }>,
): { error: string; status?: string } {
  if (outcome.kind === "not_found") return { error: "No such run for this agent." };
  return {
    error: `Run is ${outcome.run.status}, not awaiting confirmation.`,
    status: outcome.run.status,
  };
}

/** Serialize one Server-Sent Event frame: a named event with a JSON data line. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Frame an async run-bearing operation as Server-Sent Events: the `produce`
 * callback emits `activity`/`result`/`error` frames as the operation unfolds;
 * this wraps it in the web-standard `ReadableStream`/`TextEncoder` plumbing,
 * guarantees the stream is closed, and turns any unexpected throw into a generic
 * `error` frame (never leaking an internal message, matching the buffered 500).
 * Shared by the start and confirm endpoints so their streaming framing is
 * identical, and runtime-neutral (Bun and Node 20+) like the rest of
 * `handleRequest`.
 */
function sseResponse(
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

/**
 * Route and handle one request. Pure over {@link ServerDeps} — no socket, no
 * Bun — so it can be unit-tested by handing it a `new Request(...)`. Unknown
 * paths 404, the wrong agent 404s, and a known path with the wrong method 405s.
 */
export async function handleRequest(deps: ServerDeps, req: Request): Promise<Response> {
  try {
    // Default-deny, before any routing: an unauthenticated request gets the same
    // 401 whatever it asks for, so the endpoint never reveals which paths exist or
    // which agent it serves. Every path is behind the token — there are no
    // unauthenticated reads, and SSE (an `Accept` header on these same routes)
    // authenticates identically because it passes through here too.
    if (!tokenMatches(bearerToken(req), deps.authToken)) {
      return unauthorized();
    }

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);

    // The shapes we serve, all rooted at /agents/:agent:
    //   /agents/:agent/runs            (GET list, POST start)
    //   /agents/:agent/events          (GET tail)
    //   /agents/:agent/runs/:run/confirm  (POST resume a paused run)
    if (segments[0] !== "agents" || (segments.length !== 3 && segments.length !== 5)) {
      return fail(404, "Not found.");
    }
    // A malformed percent-encoding (e.g. `/agents/%/runs`) makes decodeURIComponent
    // throw. Such a name can never match the served agent, so treat it as the same
    // 404 rather than letting it escape as an unhandled error.
    let agentName: string;
    try {
      agentName = decodeURIComponent(segments[1]!);
    } catch {
      return fail(404, `This endpoint serves only the agent "${deps.agent.name}".`);
    }

    // One agent per server: any name but the served one is not found here. This is
    // the network-edge expression of "no shared state across agents" — a server
    // bound to one agent can never address another's runs or events.
    if (agentName !== deps.agent.name) {
      return fail(404, `This endpoint serves only the agent "${deps.agent.name}".`);
    }

    // /agents/:agent/runs/:run/confirm — the only 5-segment route.
    if (segments.length === 5) {
      if (segments[2] !== "runs" || segments[4] !== "confirm") {
        return fail(404, "Not found.");
      }
      let runId: string;
      try {
        runId = decodeURIComponent(segments[3]!);
      } catch {
        return fail(404, "Not found.");
      }
      if (req.method === "POST") return confirmRun(deps, req, runId);
      return fail(405, "Method not allowed.");
    }

    const resource = segments[2]!;
    if (resource === "runs") {
      if (req.method === "GET") return listRuns(deps);
      if (req.method === "POST") return startRun(deps, req);
      return fail(405, "Method not allowed.");
    }
    if (resource === "events") {
      if (req.method === "GET") return listEvents(deps, url);
      return fail(405, "Method not allowed.");
    }
    return fail(404, "Not found.");
  } catch {
    // Backstop: nothing the kernel raises (a driver error, an unexpected throw)
    // should reach the client verbatim — a message or stack could leak internal
    // detail. Answer with a generic 500 instead of Bun's default error page.
    return fail(500, "Internal server error.");
  }
}

/** Options for {@link serve}: the handler's deps plus where to bind. */
export interface ServeOptions extends ServerDeps {
  /**
   * Port to bind. Default {@link DEFAULT_PORT}. Pass 0 for an OS-assigned free
   * port (read the actual port back from the returned handle).
   */
  port?: number;
  /**
   * Hostname to bind. Default 127.0.0.1 — local-first; the endpoint is not
   * exposed beyond the loopback interface unless you say so.
   */
  hostname?: string;
}

/** The default port `asterism serve` binds when `--port` is not given. */
export const DEFAULT_PORT = 4831;
/** The default interface `asterism serve` binds — loopback only. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

/** A bound, running server: where it is reachable and how to stop it. */
export interface RunningServer {
  port: number;
  hostname: string;
  /** The base URL the endpoints hang off (e.g. http://127.0.0.1:4831). */
  url: string;
  /**
   * Stop accepting connections and shut the server down. Returns a promise that
   * resolves once in-flight requests have drained, so a caller can await it before
   * tearing down resources (e.g. closing the store) the handler still depends on.
   */
  stop: () => void | Promise<void>;
}

/**
 * Bind the HTTP endpoint and start listening. The single runtime seam in the
 * package: under Bun it binds with `Bun.serve`; off Bun (Node 20+) it binds with
 * `node:http` via {@link serveNode}. Everything else routes through the
 * runtime-agnostic {@link handleRequest}. Returns a handle with the resolved
 * port/host (useful when binding port 0) and a `stop()`.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const { port, hostname, ...deps } = options;
  const boundHost = hostname ?? DEFAULT_HOSTNAME;
  const boundPort = port ?? DEFAULT_PORT;
  const handler = (req: Request): Promise<Response> => handleRequest(deps, req);

  if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
    const server = Bun.serve({ port: boundPort, hostname: boundHost, fetch: handler });
    // `server.port` is the source of truth (it reflects the OS-assigned port when 0
    // was requested); fall back only if the runtime leaves it unset.
    const resolvedPort = server.port ?? boundPort;
    return {
      port: resolvedPort,
      hostname: boundHost,
      url: `http://${boundHost}:${resolvedPort}`,
      // Bun's drain promise: in-flight requests finish before teardown.
      stop: () => server.stop(),
    };
  }

  // Off Bun: bind with node:http. Imported lazily so the Bun path never loads it.
  const { serveNode } = await import("./serve-node.js");
  return serveNode({ port: boundPort, hostname: boundHost }, handler);
}
