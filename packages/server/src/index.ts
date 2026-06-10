// @qmilab/asterism-server — a thin local HTTP endpoint over the kernel.
//
// Phase 0 endpoints, each scoped to ONE served agent:
//   POST /agents/:agent/runs    start a run; body { "input": "<task>" }
//   GET  /agents/:agent/runs    list the agent's runs
//   GET  /agents/:agent/events  read the agent's event log (with tail params)
//
// Thin by mandate (CLAUDE.md): the handler parses the request, calls ONE kernel
// operation, and serializes the result. No trust reasoning, no scoping decisions,
// no run orchestration live here — `executeRun` and the agent-scoped repositories
// own all of that, so the HTTP surface inherits the CLI's exact guarantees.
//
// One agent per server. A server instance is bound to the single agent that
// `asterism serve <agent>` named; the `:agent` segment must match that name, and
// any other name is a 404. A process serving `personal` is therefore never a back
// door to `work` — the "separate lives" guarantee holds at the network edge too,
// not only in storage. (The REST path keeps `:agent` for forward-compatibility;
// in Phase 0 it is pinned to the served agent.)
//
// No interactive confirmation exists over HTTP, so a destructive action takes the
// safe default: it stays paused and the run returns `awaiting_confirmation` rather
// than executing unattended. The destructive-action gate fires at every trust
// level (golden rule 4); the kernel, not this surface, enforces it.
//
// The request handler is written against the web-standard `Request`/`Response`, so
// it is runtime-agnostic and testable without binding a socket; `serve()` is the
// only Bun-specific line (it wraps `handleRequest` in `Bun.serve`).

import { executeRun } from "@qmilab/asterism-core";
import type {
  Agent,
  AsterismStore,
  Capability,
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
  const since = url.searchParams.get("since");
  if (since) options.sinceId = since;

  return json(200, { events: deps.store.events.tail(deps.agent.id, options) });
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

  // The kernel owns the run. No `confirm` is supplied: over HTTP a destructive
  // action takes the safe default and the run returns `awaiting_confirmation`
  // rather than executing without a human.
  const result = await executeRun(deps.store, deps.agent, input, {
    adapter: deps.adapter,
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
  });

  // 201: the run resource was created and executed. `status` conveys
  // done / failed / awaiting_confirmation; `output` is the agent's text.
  return json(201, {
    run: result.run,
    status: result.status,
    output: result.output,
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
}

/**
 * Route and handle one request. Pure over {@link ServerDeps} — no socket, no
 * Bun — so it can be unit-tested by handing it a `new Request(...)`. Unknown
 * paths 404, the wrong agent 404s, and a known path with the wrong method 405s.
 */
export async function handleRequest(deps: ServerDeps, req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);

    // The only shape we serve is /agents/:agent/(runs|events).
    if (segments.length !== 3 || segments[0] !== "agents") {
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
    const resource = segments[2]!;

    // One agent per server: any name but the served one is not found here. This is
    // the network-edge expression of "no shared state across agents" — a server
    // bound to one agent can never address another's runs or events.
    if (agentName !== deps.agent.name) {
      return fail(404, `This endpoint serves only the agent "${deps.agent.name}".`);
    }

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
 * Bind the HTTP endpoint with `Bun.serve` and start listening. The only
 * Bun-specific code in the package; everything else routes through the
 * runtime-agnostic {@link handleRequest}. Returns a handle with the resolved
 * port/host (useful when binding port 0) and a `stop()`.
 */
export function serve(options: ServeOptions): RunningServer {
  const { port, hostname, ...deps } = options;
  const boundHost = hostname ?? DEFAULT_HOSTNAME;
  const server = Bun.serve({
    port: port ?? DEFAULT_PORT,
    hostname: boundHost,
    fetch: (req) => handleRequest(deps, req),
  });
  // `server.port` is the source of truth (it reflects the OS-assigned port when 0
  // was requested); fall back only if the runtime leaves it unset.
  const boundPort = server.port ?? port ?? DEFAULT_PORT;
  return {
    port: boundPort,
    hostname: boundHost,
    url: `http://${boundHost}:${boundPort}`,
    // Return Bun's drain promise so callers can await a clean shutdown — in-flight
    // requests finish before the server is torn down.
    stop: () => server.stop(),
  };
}
