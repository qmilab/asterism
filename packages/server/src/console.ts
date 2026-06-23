// @qmilab/asterism-server — the install-wide operator console.
//
// This is the SECOND HTTP surface in the package, distinct from `serve` (index.ts).
// `serve` is one-agent-per-process by mandate; the console is the OPERATOR's own
// console over ALL of their agents, the surface the `asterism dashboard` TUI is a
// thin client of. The two are not in tension with "separate lives": no AGENT can
// reach the console, and no agent's scoped data ever crosses into another's view —
// every read/write here is still issued through the agent-scoped repositories, one
// agent at a time. It is exactly the install-wide reach the CLI already has
// (`list`, a bare `confirm <run>`), exposed over the same authenticated door.
//
// Thin by the same mandate as `serve`: each handler parses the request, calls ONE
// kernel operation, and serializes the result. Trust enforcement, the destructive-
// action gate, the memory firewall, and run orchestration all live in the kernel —
// the console adds none of it. `resumeRun` / `declineRun` / `proposeReviewableMemories`
// / `recordMemory` are the kernel calls; the surface only routes to them, so the
// dashboard inherits the CLI's exact guarantees.
//
// Default-deny like `serve`: every request must carry the bearer token before any
// routing, so the door leaks nothing about which agents exist to an unauthenticated
// caller. The token is a per-server operator secret (resolved by the host), never an
// agent credential, and never appears in a response or an error.
//
// Runtime-agnostic: `handleConsoleRequest` is written against the web-standard
// `Request`/`Response` and is unit-testable without a socket. `serveConsole` is the
// only runtime-specific seam — `Bun.serve` under Bun, `node:http` off it — reusing
// the exact binding path as `serve`.

import { bearerToken, fail, json, tokenMatches, unauthorized } from "./http.js";

import {
  acceptProposedMemory,
  declineRun,
  MemoryFirewallError,
  proposeReviewableMemories,
  rejectProposedMemory,
  resumeRun,
} from "@qmilab/asterism-core";
import {
  MEMORY_TYPES,
  REVIEW_STATES,
  TRUST_LEVELS,
  validateEnum,
} from "@qmilab/asterism-core";
import type {
  Agent,
  AsterismStore,
  Capability,
  ExecuteRunOptions,
  ExecuteRunResult,
  MemoryQuery,
  MemoryType,
  RecallProvider,
  ReflectionProvider,
  ReviewState,
  RuntimeAdapter,
  TailOptions,
  TrustLevel,
} from "@qmilab/asterism-core";

import { DEFAULT_HOSTNAME } from "./http.js";
import type { RunningServer } from "./index.js";

/**
 * Everything the console surface needs, injectable so the handler is testable
 * without a socket. The store and token are resolved once at startup by the host
 * (the CLI). Because the console spans agents, the substrate seams are FACTORIES
 * keyed by agent name — the host resolves each agent's own model — and the package
 * stays model-free, receiving only what the adapter / reflection boundaries allow.
 */
export interface ConsoleDeps {
  /** The open kernel store. */
  store: AsterismStore;
  /**
   * The bearer token every request must present as `Authorization: Bearer <token>`.
   * Required (default-deny). A per-server operator secret, never an agent credential,
   * and never echoed in a response or error.
   */
  authToken: string;
  /**
   * Reads a file's text (soul + skill bodies); forwarded to `resumeRun`. Absent ⇒
   * souls resolve to built-ins only and skills are framed by name.
   */
  readFile?: (path: string) => string;
  /**
   * Builds the capabilities to expose to a resumed run, given the agent's confined
   * workspace — the same factory the CLI/`serve` use, so tool exposure cannot differ
   * by surface. Absent ⇒ an empty tool set.
   */
  capabilities?: (workspaceDir: string) => readonly Capability[];
  /**
   * Build the run substrate for an agent (to confirm/resume a paused run). Keyed by
   * agent name so each agent's own model pin is honored. May be async (the host wraps
   * an opted-in agent's adapter in its cognition provider, which loads lazily), so the
   * call site awaits it. Absent (or returning no adapter) ⇒ confirm returns 503 — the
   * read/management endpoints still work.
   */
  makeAdapter?: (
    agentName: string,
  ) =>
    | { adapter?: RuntimeAdapter; reason?: string }
    | Promise<{ adapter?: RuntimeAdapter; reason?: string }>;
  /**
   * Build the reflection provider for an agent (to propose reviewable memories).
   * Keyed by agent name, same as {@link makeAdapter}. Absent (or no provider) ⇒
   * the reflect endpoint returns 503.
   */
  makeReflectionProvider?: (agentName: string) => { provider?: ReflectionProvider; reason?: string };
  /**
   * Resolve an agent's opt-in recall provider for a resumed run, keyed by agent name
   * like {@link makeAdapter}. Unlike the others it returns `{}` (no provider, no
   * reason) when the agent has NOT opted in — that agent uses the kernel's built-in
   * lexical ranker. A `reason` means the agent opted in but the provider could not be
   * built (no endpoint), and confirm refuses with it (mirrors the model 503). Absent
   * ⇒ every resume uses the built-in ranker. Async because building may lazily load
   * the opt-in package.
   */
  makeRecall?: (agentName: string) => Promise<{ provider?: RecallProvider; reason?: string }>;
}

/** Resolve an agent by name within the install, or undefined. Scoped reads follow. */
function findAgent(deps: ConsoleDeps, name: string): Agent | undefined {
  return deps.store.agents.list().find((a) => a.name === name);
}

/** Parse a request's JSON body, or signal a malformed body to the caller. */
async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * The wire body for a settled run — the same shape `serve` returns, so a client can
 * read either surface identically. References only: `actions` carries capability
 * keys and effects, never an action's args.
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

/** GET /agents — the operator's roster: identity + trust + lightweight badges. */
function listAgents(deps: ConsoleDeps): Response {
  const agents = deps.store.agents.list().map((agent) => {
    // One scoped read per agent yields both the last-active time (oldest-first list,
    // so the last row is newest) and the pending-confirmation badge. The registry is
    // an enumeration of identities, not cross-agent data — each agent's runs stay
    // scoped to it.
    const runs = deps.store.runs.list(agent.id);
    const last = runs.at(-1);
    const pendingConfirmations = runs.filter((r) => r.status === "awaiting_confirmation").length;
    return {
      name: agent.name,
      role: agent.role,
      soulRef: agent.soulRef,
      trustLevel: agent.trustLevel,
      createdAt: agent.createdAt,
      ...(last ? { lastRunAt: last.startedAt } : {}),
      pendingConfirmations,
    };
  });
  return json(200, { agents });
}

/** GET /agents/:agent/runs — the agent's runs, oldest-first (scoped by the repo). */
function listRuns(deps: ConsoleDeps, agent: Agent): Response {
  return json(200, { runs: deps.store.runs.list(agent.id) });
}

/** GET /agents/:agent/events — the agent's event log, with the same tail params as `serve`. */
function listEvents(deps: ConsoleDeps, agent: Agent, url: URL): Response {
  const options: TailOptions = {};
  // An absent param is `null`; an empty one (`?type=`) is `""`. Treat both as "not
  // given" so an empty value means "no filter", matching `serve` and the CLI.
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw) {
    if (!/^\d+$/.test(limitRaw)) return fail(400, "limit must be a non-negative integer.");
    options.limit = Number(limitRaw);
  }
  const type = url.searchParams.get("type");
  if (type) options.type = type;
  const run = url.searchParams.get("run");
  if (run) options.runId = run;
  const since = url.searchParams.get("since");
  if (since) options.sinceId = since;
  return json(200, { events: deps.store.events.tail(agent.id, options) });
}

/** GET /agents/:agent/memory — the agent's memories, optionally filtered by type / review state. */
function listMemory(deps: ConsoleDeps, agent: Agent, url: URL): Response {
  const query: MemoryQuery = {};
  const typeRaw = url.searchParams.get("type");
  if (typeRaw) {
    if (!(MEMORY_TYPES as readonly string[]).includes(typeRaw)) {
      return fail(400, `Unknown memory type "${typeRaw}".`);
    }
    query.memoryType = typeRaw as MemoryType;
  }
  const reviewRaw = url.searchParams.get("reviewState");
  if (reviewRaw) {
    if (!(REVIEW_STATES as readonly string[]).includes(reviewRaw)) {
      return fail(400, `Unknown review state "${reviewRaw}".`);
    }
    query.reviewState = reviewRaw as ReviewState;
  }
  return json(200, { memories: deps.store.memories.list(agent.id, query) });
}

/** PUT /agents/:agent/trust — set the agent's autonomy level; body { level }. */
async function setTrust(deps: ConsoleDeps, agent: Agent, req: Request): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, "Request body must be JSON.");
  const level = (parsed.body as { level?: unknown } | null)?.level;
  if (typeof level !== "string" || !(TRUST_LEVELS as readonly string[]).includes(level)) {
    return fail(400, `Request body must be { "level": one of ${TRUST_LEVELS.join(" | ")} }.`);
  }
  // The kernel owns the change (and records `agent.trust_changed`); this only routes.
  const updated = deps.store.setTrust(agent.id, level as TrustLevel);
  return json(200, { agent: updated });
}

/**
 * POST /agents/:agent/reflect — propose reviewable memories from a run; body
 * { runId? } (default: the agent's latest run with output). The shared kernel
 * pipeline (`proposeReviewableMemories`) selects the run, calls the provider, applies
 * the reflection-only type filter, and screens each proposal — so the dashboard and
 * the CLI's `reflect --review` can never drift. NOTHING is persisted here; accepting
 * a proposal is a separate POST to `…/memory`.
 */
async function reflect(deps: ConsoleDeps, agent: Agent, req: Request): Promise<Response> {
  const made = deps.makeReflectionProvider?.(agent.name);
  if (!made?.provider) {
    return fail(503, made?.reason ?? "No model is configured, so reflection cannot run.");
  }
  // Body is optional — an absent or empty body means "latest run with output".
  let runId: string | undefined;
  const text = (await req.text()).trim();
  if (text.length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Request body must be JSON.");
    }
    const raw = (body as { runId?: unknown } | null)?.runId;
    if (raw !== undefined && typeof raw !== "string") {
      return fail(400, 'If given, "runId" must be a string.');
    }
    if (typeof raw === "string") runId = raw;
  }

  let result;
  try {
    result = await proposeReviewableMemories(deps.store, agent, made.provider, {
      ...(runId !== undefined ? { runId } : {}),
    });
  } catch {
    // The provider drives a hosted model; a failure there is an upstream problem, not
    // a bug in this surface. Generic message — never leak the model's error verbatim.
    return fail(502, "Reflection failed.");
  }
  if (result.kind === "no_run") {
    return json(200, { proposals: [], ignored: 0 });
  }
  return json(200, { runId: result.runId, proposals: result.proposals, ignored: result.ignored });
}

/**
 * POST /agents/:agent/memory — persist an accepted (or edited) memory; body
 * { memoryType, content, confidence?, sourceRunId? }. This is the accept step of
 * review: the memory firewall RE-SCREENS here (the real hard gate) and a poisoned
 * write is refused with 422 regardless of the operator's approval.
 */
async function saveMemory(deps: ConsoleDeps, agent: Agent, req: Request): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, "Request body must be JSON.");
  const body = parsed.body as Record<string, unknown> | null;
  const memoryType = body?.memoryType;
  const content = body?.content;
  if (typeof memoryType !== "string" || !(MEMORY_TYPES as readonly string[]).includes(memoryType)) {
    return fail(400, `"memoryType" must be one of ${MEMORY_TYPES.join(", ")}.`);
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return fail(400, '"content" must be a non-empty string.');
  }
  const confidence = body?.confidence;
  if (confidence !== undefined && typeof confidence !== "number") {
    return fail(400, 'If given, "confidence" must be a number.');
  }
  const sourceRunId = body?.sourceRunId;
  if (sourceRunId !== undefined && typeof sourceRunId !== "string") {
    return fail(400, 'If given, "sourceRunId" must be a string.');
  }

  try {
    const memory = deps.store.recordMemory(agent.id, {
      memoryType: memoryType as MemoryType,
      content: content.trim(),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(sourceRunId !== undefined ? { sourceRunId } : {}),
      reviewState: "accepted",
      status: "active",
    });
    return json(201, { memory });
  } catch (err) {
    if (err instanceof MemoryFirewallError) {
      // 422: well-formed request, but the firewall refused the content. The findings
      // name what tripped a rule — never the blocked content itself.
      return json(422, { error: "Blocked by the memory firewall.", findings: err.findings });
    }
    throw err; // anything else is an unexpected internal error → the outer 500.
  }
}

/**
 * POST /agents/:agent/memory/:id/accept — accept a queued PROPOSED memory, optionally
 * editing it; body { content? }. The human's ratification that turns an inert proposal
 * (queued by a scheduled `reflect --propose`) into an active + accepted memory. The shared
 * kernel helper transitions it in place, or — for an edit — re-screens the new content
 * through the memory firewall (the real gate) and supersedes the original. 404 if no such
 * memory for this agent; 409 if it is not awaiting review (already accepted/rejected); 422
 * if an edit is poisoned. Same helpers back `reflect --review`, so CLI and dashboard agree.
 */
async function acceptMemory(
  deps: ConsoleDeps,
  agent: Agent,
  id: string,
  req: Request,
): Promise<Response> {
  // Body is optional — an absent or empty body means "accept unchanged".
  let content: string | undefined;
  const text = (await req.text()).trim();
  if (text.length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Request body must be JSON.");
    }
    const raw = (body as { content?: unknown } | null)?.content;
    if (raw !== undefined && typeof raw !== "string") {
      return fail(400, 'If given, "content" must be a string.');
    }
    if (typeof raw === "string") {
      // A blank edit is NOT "accept unchanged" — that would silently activate the original a
      // caller was trying to clear. Reject it like the CLI/dashboard do; to discard a
      // proposal, call the reject endpoint.
      if (raw.trim().length === 0) {
        return fail(400, 'If given, "content" must be a non-empty string (use …/reject to discard).');
      }
      content = raw;
    }
  }

  try {
    const outcome = acceptProposedMemory(deps.store, agent, id, content);
    if (outcome.kind === "not_found") return fail(404, "No such proposed memory for this agent.");
    if (outcome.kind === "not_proposed") {
      return fail(409, "Memory is not awaiting review.");
    }
    return json(200, { memory: outcome.memory });
  } catch (err) {
    if (err instanceof MemoryFirewallError) {
      // 422: well-formed request, but the firewall refused the edited content. Findings
      // name what tripped a rule — never the blocked content itself.
      return json(422, { error: "Blocked by the memory firewall.", findings: err.findings });
    }
    throw err; // anything else is an unexpected internal error → the outer 500.
  }
}

/**
 * POST /agents/:agent/memory/:id/reject — reject a queued PROPOSED memory: transition it
 * `proposed → rejected` so it leaves the review queue. It was never active, so nothing it
 * framed changes. 404 if no such memory for this agent; 409 if it is not awaiting review.
 */
function rejectMemory(deps: ConsoleDeps, agent: Agent, id: string): Response {
  const outcome = rejectProposedMemory(deps.store, agent, id);
  if (outcome.kind === "not_found") return fail(404, "No such proposed memory for this agent.");
  if (outcome.kind === "not_proposed") {
    return fail(409, "Memory is not awaiting review.");
  }
  return json(200, { memory: outcome.memory });
}

/** The substrate-side host concerns a resume forwards to the kernel, for one agent. */
function runOptions(
  deps: ConsoleDeps,
  agent: Agent,
  adapter: RuntimeAdapter,
  recall?: RecallProvider,
): ExecuteRunOptions {
  const capabilities = deps.capabilities?.(agent.workspaceDir);
  return {
    adapter,
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(recall ? { recall } : {}),
  };
}

/**
 * POST /agents/:agent/runs/:run/confirm — clear a gate pause: re-enter the run with
 * only the action it stopped on approved. The kernel's `resumeRun` owns the grant
 * (bounded to this run, recorded as `run.resumed`); a different destructive action
 * pauses it again. Buffered (no SSE here — the dashboard re-reads the timeline).
 */
async function confirmRun(deps: ConsoleDeps, agent: Agent, runId: string): Promise<Response> {
  const made = await deps.makeAdapter?.(agent.name);
  if (!made?.adapter) {
    return fail(503, made?.reason ?? "No model is configured, so runs cannot resume.");
  }
  // Resolve the agent's opt-in recall provider (built-in lexical ranker when unset).
  // An opted-in-but-unconfigured provider refuses the resume, visibly — the same
  // stance the model 503 above takes — rather than silently keyword-ranking.
  const recall = await deps.makeRecall?.(agent.name);
  if (recall?.reason !== undefined) {
    return fail(503, recall.reason);
  }
  const outcome = await resumeRun(
    deps.store,
    agent,
    runId,
    runOptions(deps, agent, made.adapter, recall?.provider),
  );
  if (outcome.kind === "not_found") return fail(404, "No such run for this agent.");
  if (outcome.kind === "not_paused") {
    return json(409, {
      error: `Run is ${outcome.run.status}, not awaiting confirmation.`,
      status: outcome.run.status,
      run: outcome.run,
    });
  }
  return json(200, runResultBody(outcome.result));
}

/**
 * POST /agents/:agent/runs/:run/decline — refuse a gate pause: the run ends `failed`
 * and the destructive action never runs. The counterpart to confirm; `declineRun`
 * claims the run first, so it races safely against a concurrent confirm (exactly one
 * wins). No model needed — nothing re-enters the loop.
 */
function declineRunEndpoint(deps: ConsoleDeps, agent: Agent, runId: string): Response {
  const outcome = declineRun(deps.store, agent, runId);
  if (outcome.kind === "not_found") return fail(404, "No such run for this agent.");
  if (outcome.kind === "not_paused") {
    return json(409, {
      error: `Run is ${outcome.run.status}, not awaiting confirmation.`,
      status: outcome.run.status,
      run: outcome.run,
    });
  }
  return json(200, { run: outcome.run, status: outcome.run.status });
}

/**
 * Route and handle one console request. Pure over {@link ConsoleDeps} — no socket —
 * so a test can hand it a `new Request(...)`. Default-deny before any routing.
 *
 * Shapes:
 *   GET  /agents                          roster
 *   GET  /agents/:a/runs                  list runs
 *   GET  /agents/:a/events                tail events
 *   GET  /agents/:a/memory                list memory
 *   POST /agents/:a/memory                persist an accepted memory
 *   POST /agents/:a/memory/:m/accept      accept a queued proposed memory
 *   POST /agents/:a/memory/:m/reject      reject a queued proposed memory
 *   PUT  /agents/:a/trust                 set autonomy level
 *   POST /agents/:a/reflect               propose reviewable memories
 *   POST /agents/:a/runs/:r/confirm       resume a paused run
 *   POST /agents/:a/runs/:r/decline       refuse a paused run
 */
export async function handleConsoleRequest(deps: ConsoleDeps, req: Request): Promise<Response> {
  try {
    // Default-deny, before routing: an unauthenticated request gets the same 401
    // whatever it asks for, so the door never reveals which agents exist.
    if (!tokenMatches(bearerToken(req), deps.authToken)) return unauthorized();

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments[0] !== "agents") return fail(404, "Not found.");

    // GET /agents — the roster (the only single-segment route).
    if (segments.length === 1) {
      if (req.method === "GET") return listAgents(deps);
      return fail(405, "Method not allowed.");
    }

    // Everything else is rooted at /agents/:agent — resolve the agent once. A
    // malformed percent-encoding can never name an agent, so it 404s like a miss.
    let agentName: string;
    try {
      agentName = decodeURIComponent(segments[1]!);
    } catch {
      return fail(404, "Not found.");
    }
    const agent = findAgent(deps, agentName);
    if (!agent) return fail(404, `No agent named "${agentName}".`);

    // The 5-segment routes: /agents/:a/runs/:r/<confirm|decline> and
    // /agents/:a/memory/:m/<accept|reject>.
    if (segments.length === 5) {
      let id: string;
      try {
        id = decodeURIComponent(segments[3]!);
      } catch {
        return fail(404, "Not found.");
      }
      const action = segments[4];
      if (segments[2] === "runs") {
        if (action === "confirm") {
          if (req.method === "POST") return confirmRun(deps, agent, id);
          return fail(405, "Method not allowed.");
        }
        if (action === "decline") {
          if (req.method === "POST") return declineRunEndpoint(deps, agent, id);
          return fail(405, "Method not allowed.");
        }
        return fail(404, "Not found.");
      }
      if (segments[2] === "memory") {
        if (action === "accept") {
          if (req.method === "POST") return acceptMemory(deps, agent, id, req);
          return fail(405, "Method not allowed.");
        }
        if (action === "reject") {
          if (req.method === "POST") return rejectMemory(deps, agent, id);
          return fail(405, "Method not allowed.");
        }
        return fail(404, "Not found.");
      }
      return fail(404, "Not found.");
    }

    if (segments.length !== 3) return fail(404, "Not found.");
    const resource = segments[2]!;

    if (resource === "runs") {
      if (req.method === "GET") return listRuns(deps, agent);
      return fail(405, "Method not allowed.");
    }
    if (resource === "events") {
      if (req.method === "GET") return listEvents(deps, agent, url);
      return fail(405, "Method not allowed.");
    }
    if (resource === "memory") {
      if (req.method === "GET") return listMemory(deps, agent, url);
      if (req.method === "POST") return saveMemory(deps, agent, req);
      return fail(405, "Method not allowed.");
    }
    if (resource === "trust") {
      if (req.method === "PUT") return setTrust(deps, agent, req);
      return fail(405, "Method not allowed.");
    }
    if (resource === "reflect") {
      if (req.method === "POST") return reflect(deps, agent, req);
      return fail(405, "Method not allowed.");
    }
    return fail(404, "Not found.");
  } catch {
    // Backstop: a driver error or unexpected throw must not reach the client verbatim
    // — answer with a generic 500, never an internal message or stack.
    return fail(500, "Internal server error.");
  }
}

/** The default port `asterism dashboard --headless` binds — distinct from `serve`'s. */
export const DEFAULT_CONSOLE_PORT = 4832;

/** Options for {@link serveConsole}: the handler's deps plus where to bind. */
export interface ServeConsoleOptions extends ConsoleDeps {
  /** Port to bind. Default {@link DEFAULT_CONSOLE_PORT}. Pass 0 for an OS-assigned free port. */
  port?: number;
  /** Hostname to bind. Default 127.0.0.1 — loopback only unless overridden. */
  hostname?: string;
}

/**
 * Bind the console endpoint and start listening. The single runtime seam: under Bun
 * it binds with `Bun.serve`; off Bun (Node 20+) it binds with `node:http` via the
 * same `serveNode` `serve` uses. Everything else routes through the runtime-agnostic
 * {@link handleConsoleRequest}. Returns a handle with the resolved port/host (useful
 * when binding port 0, as the self-hosted dashboard does) and a `stop()`.
 */
export async function serveConsole(options: ServeConsoleOptions): Promise<RunningServer> {
  const { port, hostname, ...deps } = options;
  const boundHost = hostname ?? DEFAULT_HOSTNAME;
  const boundPort = port ?? DEFAULT_CONSOLE_PORT;
  const handler = (req: Request): Promise<Response> => handleConsoleRequest(deps, req);

  if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
    const server = Bun.serve({ port: boundPort, hostname: boundHost, fetch: handler });
    const resolvedPort = server.port ?? boundPort;
    return {
      port: resolvedPort,
      hostname: boundHost,
      url: `http://${boundHost}:${resolvedPort}`,
      stop: () => server.stop(),
    };
  }

  const { serveNode } = await import("./serve-node.js");
  return serveNode({ port: boundPort, hostname: boundHost }, handler);
}
