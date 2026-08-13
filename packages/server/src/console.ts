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
// COLLABORATION (Phase 3 · #112) is the one place this surface spans two agents, and it
// changes none of the above. `performHandoff` / `performArtifactExchange` /
// `performSummaryExchange` / `performSetBrief` / `performEndBrief` / `performArtifactFetch`
// each own their permission read, their projection, and their audit; the routes below
// resolve two agents and call one of them. The connection — created by an explicit operator
// request — remains the whole permission, and no endpoint here can widen what a mode
// crosses, because each kernel op returns a type with nowhere to put more (design note §19).
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
  performArtifactExchange,
  performArtifactFetch,
  performEndBrief,
  performHandoff,
  performSetBrief,
  performSummaryExchange,
  proposeReviewableMemories,
  rejectProposedMemory,
  resumeRun,
} from "@qmilab/asterism-core";
import {
  CONNECTION_MODES,
  MEMORY_TYPES,
  REVIEW_STATES,
  TRUST_LEVELS,
  validateEnum,
} from "@qmilab/asterism-core";
import type {
  Action,
  Agent,
  ArtifactFetchHost,
  OutboundHost,
  AsterismStore,
  Brief,
  Capability,
  Connection,
  ConnectionMode,
  ConnectionStatus,
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
  /**
   * The filesystem side of `artifact fetch` — the ONLY collaboration op that moves file
   * bytes across an agent boundary. Host-supplied for the same reason the CLI's is: the
   * kernel decides *whether* bytes may cross and *which* bytes, and the host performs the
   * confined read/write. Absent ⇒ the fetch endpoint returns 503; every other endpoint
   * still works.
   */
  fetchHost?: ArtifactFetchHost;
  /**
   * How this surface makes an outbound call for an agent's bound endpoints — its
   * credential-bearing capabilities. Host-supplied for the same reason {@link fetchHost}
   * is, and forwarded to the kernel untouched, so a run resumed from the dashboard calls
   * a bound endpoint under the identical rules the CLI applies. Absent ⇒ those tools are
   * still exposed but report themselves unavailable.
   */
  outboundHost?: OutboundHost;
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
    ...(deps.outboundHost ? { outboundHost: deps.outboundHost } : {}),
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

// --- collaboration (Phase 3 · #112) ----------------------------------------
//
// The only routes here that name two agents. Three properties are worth stating once, at
// the top, because every handler below relies on them rather than re-establishing them:
//
//   1. THE CALLER IS THE SUBJECT. Every Phase-3 operation is directional (design note D1) —
//      `connect A B`, `handoff A B`, `summary A B`, `brief A B`, `fetch A B` — so every
//      route is rooted at the CALLER and names the callee in the path. There is no
//      operation here whose subject is the pair symmetrically (D31).
//   2. THE MODE COMES FROM THE VERB. `handoff` → `handoff`, `artifact`/`fetch` →
//      `artifact-only`, `summary` → `read-summary`, `brief` → `shared-brief`. A surface
//      never picks a mode, and the kernel's permission read is keyed on it, so a channel
//      in one mode can never authorize another mode's verb.
//   3. THE PROJECTION IS AUDITED HERE AS A KEY SET, not inherited from the result type.
//      Each kernel op already returns a type with nowhere to put more than its mode allows
//      — but the T2a review's lesson was that the leak hides in a NESTED entity, so every
//      body below is built field by field. Nothing is spread from a kernel result.

/** Every agent id in the install, mapped to its name — for projecting a cross-agent row. */
function agentNames(deps: ConsoleDeps): ReadonlyMap<string, string> {
  return new Map(deps.store.agents.list().map((a) => [a.id, a.name] as const));
}

/**
 * One connection, as the wire sees it. NAMES, not `fromAgentId`/`toAgentId`: an HTTP client
 * addresses agents by name, so an internal id would be a second vocabulary for the same
 * thing and unusable to the caller. `direction` is relative to the agent the route is rooted
 * at, which is what makes a participant-scoped listing readable without the client having to
 * compare ids it does not otherwise handle.
 */
function connectionBody(
  connection: Connection,
  viewer: Agent,
  names: ReadonlyMap<string, string>,
  delegated?: readonly string[],
): Record<string, unknown> {
  const outbound = connection.fromAgentId === viewer.id;
  return {
    id: connection.id,
    from: names.get(connection.fromAgentId) ?? connection.fromAgentId,
    to: names.get(connection.toAgentId) ?? connection.toAgentId,
    direction: outbound ? "outbound" : "inbound",
    mode: connection.mode,
    status: connection.status,
    createdAt: connection.createdAt,
    // Only on the one mode where the channel does not say what it reaches. A
    // `delegated-tool` channel grants nothing until a capability is named on it, so a body
    // carrying mode and status alone would describe an open channel that can do nothing —
    // the same defect the CLI listing avoids, and the same resolver behind both. Absent on
    // every other mode rather than an empty array, so a client cannot read "reaches
    // nothing" into a channel where the question does not arise.
    ...(delegated ? { delegated: [...delegated] } : {}),
  };
}

/**
 * What the kernel knows about which briefs are LIVE, resolved once per request.
 *
 * `framing` is the set that actually shapes this agent's runs right now — read from the
 * kernel through the live connection, never re-derived here. A brief can be `active` while
 * its channel is withdrawn, in which case it frames nothing, and a client that worked that
 * out for itself would disagree with the prompt. `channelStatus` is what lets a
 * not-framing row be explained from an OBSERVED status rather than an inference: the T3a
 * review found a listing printing "channel withdrawn" beside channels that were open,
 * because it inferred the reason from "active but not framing".
 */
interface BriefContext {
  framing: ReadonlySet<string>;
  channelStatus: ReadonlyMap<string, ConnectionStatus>;
}

function briefContext(deps: ConsoleDeps, agent: Agent): BriefContext {
  return {
    framing: new Set(deps.store.listActiveBriefsForAgent(agent.id).map((b) => b.id)),
    channelStatus: new Map(
      deps.store.listConnections(agent.id).map((c) => [c.id, c.status] as const),
    ),
  };
}

/**
 * One brief, as the wire sees it — the SAME key set from every endpoint that returns one
 * (set, end, list), so the noun does not change shape depending on how it was reached.
 * That costs two scoped reads on the write paths and buys an invariant a test can pin.
 */
function briefBody(
  brief: Brief,
  viewer: Agent,
  names: ReadonlyMap<string, string>,
  context: BriefContext,
): Record<string, unknown> {
  const outbound = brief.fromAgentId === viewer.id;
  return {
    id: brief.id,
    connectionId: brief.connectionId,
    from: names.get(brief.fromAgentId) ?? brief.fromAgentId,
    to: names.get(brief.toAgentId) ?? brief.toAgentId,
    direction: outbound ? "outbound" : "inbound",
    content: brief.content,
    status: brief.status,
    framing: context.framing.has(brief.id),
    ...(context.channelStatus.has(brief.connectionId)
      ? { channelStatus: context.channelStatus.get(brief.connectionId) }
      : {}),
    createdAt: brief.createdAt,
    ...(brief.endedAt !== undefined ? { endedAt: brief.endedAt } : {}),
  };
}

/**
 * The refusal when no channel authorizes what was asked. 409, not 403: the operator IS
 * authorized (they hold the console token) — what is missing is a channel between two
 * agents. A 403 would read as "your token is insufficient" and send someone chasing an auth
 * problem that does not exist, and a 404 would be wrong because both agents in the URL
 * exist. Says nothing about whether a channel in a DIFFERENT mode or direction exists: a
 * mode grants exactly its own form, and a refusal should not enumerate what else is open.
 */
function noChannel(from: Agent, to: Agent, mode: ConnectionMode): Response {
  return fail(409, `${from.name} has no open ${mode} channel to ${to.name}.`);
}

/** Read one required, non-blank string field from a JSON body. */
async function requiredText(
  req: Request,
  field: string,
): Promise<{ ok: true; value: string } | { ok: false; response: Response }> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return { ok: false, response: fail(400, "Request body must be JSON.") };
  const raw = (parsed.body as Record<string, unknown> | null)?.[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, response: fail(400, `"${field}" must be a non-empty string.`) };
  }
  // Verbatim, NOT trimmed: an exchange task and a brief are free-form operator text, and the
  // CLI takes its tail verbatim for the same reason. Only the blank check reads the trim.
  return { ok: true, value: raw };
}

/** GET /agents/:a/connections — every channel this agent is on, inbound and outbound. */
function listConnectionsEndpoint(deps: ConsoleDeps, agent: Agent): Response {
  // Every status, revoked included: this read is history, not permission (the permission
  // reads live in the kernel), and a withdrawn channel is the evidence a grant was taken
  // away. Participant-scoped by the repository, so it can only ever return channels this
  // agent is on.
  const names = agentNames(deps);
  return json(200, {
    connections: deps.store.listConnections(agent.id).map((c) =>
      connectionBody(
        c,
        agent,
        names,
        // Resolved through the kernel — the same query a delegated call is authorized
        // against — so this list cannot claim a reach the gate does not honour.
        c.mode === "delegated-tool"
          ? deps.store.listActiveDelegations(agent.id, c.id).map((d) => d.capability)
          : undefined,
      ),
    ),
  });
}

/**
 * POST /agents/:a/connections — grant a directional channel `:a → to`; body { to, mode }.
 *
 * `mode` is REQUIRED and never defaulted. The CLI defaults `--mode` to `handoff` as a typing
 * affordance; a default in a request body is a silent choice made on the caller's behalf, and
 * the choice here is which form of another agent's work may cross (design note D37).
 */
async function connect(deps: ConsoleDeps, agent: Agent, req: Request): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, "Request body must be JSON.");
  const body = parsed.body as Record<string, unknown> | null;
  const toName = body?.to;
  if (typeof toName !== "string" || toName.trim().length === 0) {
    return fail(400, '"to" must be the name of the agent to connect to.');
  }
  const mode = body?.mode;
  if (typeof mode !== "string" || !(CONNECTION_MODES as readonly string[]).includes(mode)) {
    return fail(400, `"mode" must be one of ${CONNECTION_MODES.join(" | ")}.`);
  }
  // Looked up VERBATIM. Agent names are unvalidated free text, so `"work "` and `"work"` are
  // two different agents — trimming here would silently connect to the neighbour rather than
  // to the agent the caller named, and would disagree with the callee segment in every other
  // route on this family, which decodes and matches exactly. A name is an identity, and a
  // surface does not get to normalize one.
  const to = findAgent(deps, toName);
  if (!to) return fail(404, `No agent named "${toName}".`);
  // A connection is for CROSS-agent collaboration, and the kernel enforces that by THROWING
  // on a self-connection — which the outer catch would report as a 500, an operator's typo
  // dressed as a server fault. Answered here as the 400 it is.
  if (to.id === agent.id) return fail(400, "An agent cannot connect to itself.");

  // Read before the write only to report WHICH of create/no-op happened: `createConnection`
  // is idempotent and returns the existing row, so without this a caller cannot tell a fresh
  // grant from a repeat. Not a check the write depends on — the kernel's partial unique index
  // is the backstop against a concurrent double-create.
  const existing = deps.store.connections.findActive(agent.id, to.id, mode as ConnectionMode);
  const connection = deps.store.createConnection(agent.id, to.id, mode as ConnectionMode);
  return json(existing ? 200 : 201, {
    connection: connectionBody(connection, agent, agentNames(deps)),
    created: existing === undefined,
  });
}

/**
 * DELETE /agents/:a/connections/:b?mode=<mode> — withdraw a granted channel.
 *
 * `mode` is required, and that is stricter than the CLI on purpose. The CLI INFERS the mode
 * when the pair has exactly one open channel, precisely because defaulting it "would be a
 * safety bug rather than a convenience" — an operator would be told there was nothing to
 * disconnect while a channel stayed open. Over HTTP the strictest form of that same rule is
 * to require it, so a client can never withdraw a channel it did not name; the pair's open
 * modes come back with the 400 so a client can offer the same choice the CLI does (D37).
 */
function disconnect(deps: ConsoleDeps, agent: Agent, to: Agent, url: URL): Response {
  const modeRaw = url.searchParams.get("mode");
  if (!modeRaw) {
    return json(400, {
      error: '"mode" is required — name the channel to withdraw.',
      open: deps.store.listActiveConnectionsForPair(agent.id, to.id).map((c) => c.mode),
    });
  }
  if (!(CONNECTION_MODES as readonly string[]).includes(modeRaw)) {
    return fail(400, `Unknown connection mode "${modeRaw}". Supported: ${CONNECTION_MODES.join(", ")}.`);
  }
  const revoked = deps.store.revokeConnection(agent.id, to.id, modeRaw as ConnectionMode);
  // "Never existed" and "already withdrawn" answer identically, exactly as the CLI reports
  // them: the fact the operator cares about is that the channel is not open, and which way
  // it got there is not this endpoint's to disclose.
  if (!revoked) return fail(409, `${agent.name} has no open ${modeRaw} channel to ${to.name}.`);
  return json(200, { connection: connectionBody(revoked, agent, agentNames(deps)) });
}

/**
 * Build the CALLEE's run substrate for a push exchange. Every host concern is resolved from
 * `to` — its adapter, its recall, its workspace capabilities — because the run is the
 * callee's in every dimension, which is the property `performHandoff` relies on for
 * invariants 1–5 to fall out by construction rather than by a special path.
 *
 * There is deliberately NO `confirm` hook. The console is non-interactive, so a callee run
 * that hits its own destructive gate parks at `awaiting_confirmation` and the operator
 * clears it through the EXISTING per-agent confirm endpoint — addressed by the `runId` the
 * exchange returns. That is the console's real confirmation flow, and it is reusable here
 * precisely because a push exchange produces a run to address (design note §19).
 */
async function calleeRunOptions(
  deps: ConsoleDeps,
  from: Agent,
  to: Agent,
  mode: ConnectionMode,
): Promise<{ ok: true; options: ExecuteRunOptions } | { ok: false; response: Response }> {
  // The connection is read FIRST, before any substrate is built — the settled T1 rule, and
  // it is about the diagnosis, not the cost: without it, an unarmed handoff on an install
  // with no model answers "no model is configured" (503) when the true and actionable answer
  // is "there is no channel" (409). The kernel op re-checks authoritatively a moment later,
  // so this read is never the gate — only the cheaper precondition, and the race backstop.
  if (!deps.store.connections.findActive(from.id, to.id, mode)) {
    return { ok: false, response: noChannel(from, to, mode) };
  }
  const made = await deps.makeAdapter?.(to.name);
  if (!made?.adapter) {
    return {
      ok: false,
      response: fail(503, made?.reason ?? "No model is configured, so runs cannot start."),
    };
  }
  // An opted-in-but-unconfigured recall provider refuses the exchange visibly, the same
  // stance the model 503 takes, rather than silently keyword-ranking the callee's memory.
  const recall = await deps.makeRecall?.(to.name);
  if (recall?.reason !== undefined) return { ok: false, response: fail(503, recall.reason) };
  return { ok: true, options: runOptions(deps, to, made.adapter, recall?.provider) };
}

/**
 * POST /agents/:a/connections/:b/handoff — `:a` asks `:b` to do a task; body { task }.
 *
 * The response carries the callee's `runId`, NOT its `Run` row. D2 lets the callee's final
 * output cross and it does — but the row is more than the output: it is the callee's
 * persisted record, and returning it would make HTTP the widest surface in the phase for no
 * gain (the CLI prints only the output, and `artifact-only` cannot return a row at all).
 * `harvest` is omitted for the same reason the console's `runResultBody` omits it: it
 * describes the CALLEE's own review pile, which is no business of the caller's channel.
 */
async function handoff(deps: ConsoleDeps, agent: Agent, to: Agent, req: Request): Promise<Response> {
  const task = await requiredText(req, "task");
  if (!task.ok) return task.response;
  const prepared = await calleeRunOptions(deps, agent, to, "handoff");
  if (!prepared.ok) return prepared.response;

  const outcome = await performHandoff(deps.store, agent, to, task.value, prepared.options);
  if (outcome.kind === "no_connection") return noChannel(agent, to, "handoff");
  if (outcome.kind === "withdrawn") {
    // The work RAN — in the callee's own workspace, under its own gate — and is not undone.
    // What was withheld is the CROSSING, so the body has the run's reference and its status
    // and nowhere to put the callee's text (the kernel's `withdrawn` variant has no field
    // for it either).
    return json(409, {
      error:
        `The handoff channel from ${agent.name} to ${to.name} was withdrawn while ${to.name} ` +
        `was working, so nothing crossed.`,
      runId: outcome.runId,
      status: outcome.status,
    });
  }
  const result = outcome.result;
  return json(200, {
    runId: result.run.id,
    status: result.status,
    output: result.output,
    actions: result.actions,
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
}

/**
 * POST /agents/:a/connections/:b/artifact — the `artifact-only` exchange; body { task }.
 *
 * What comes back is the references-only manifest of what the callee produced: paths, sizes,
 * whether each still exists. Not the bytes, and not the callee's words. Note what this
 * handler CANNOT do: `ArtifactExchangeResult` has no field carrying the callee's text, so
 * there is nothing here to leak by accident — the projection is the kernel's, and this only
 * names the keys.
 */
async function artifactExchange(
  deps: ConsoleDeps,
  agent: Agent,
  to: Agent,
  req: Request,
): Promise<Response> {
  const task = await requiredText(req, "task");
  if (!task.ok) return task.response;
  const prepared = await calleeRunOptions(deps, agent, to, "artifact-only");
  if (!prepared.ok) return prepared.response;

  const outcome = await performArtifactExchange(deps.store, agent, to, task.value, prepared.options);
  if (outcome.kind === "no_connection") return noChannel(agent, to, "artifact-only");
  if (outcome.kind === "withdrawn") {
    // Neither half of the crossing happened: no manifest (the filenames are themselves what
    // this mode controls) and no exchange record, so nothing became fetchable later either.
    return json(409, {
      error:
        `The artifact-only channel from ${agent.name} to ${to.name} was withdrawn while ` +
        `${to.name} was working, so nothing crossed.`,
      runId: outcome.runId,
      status: outcome.status,
    });
  }
  const result = outcome.result;
  // The manifest is returned on EVERY successful outcome, `awaiting_confirmation` included:
  // a file the callee wrote before it paused genuinely exists in its workspace, and reporting
  // "nothing produced" for work that landed would be false.
  return json(200, {
    runId: result.runId,
    status: result.status,
    actions: result.actions,
    artifacts: result.artifacts,
  });
}

/**
 * POST /agents/:a/connections/:b/summary — pull a curated extract of what `:b` already
 * knows; body { focus? }, optional.
 *
 * The one PULL: the callee runs nothing, so no adapter is resolved and no recall is built.
 * Two visible consequences — the callee's trust level is irrelevant (trust governs what an
 * agent DOES), and this works on an install with no model configured at all.
 */
async function summaryExchange(
  deps: ConsoleDeps,
  agent: Agent,
  to: Agent,
  req: Request,
): Promise<Response> {
  // Body is optional — an absent or empty one means an unfocused pull.
  let focus: string | undefined;
  const text = (await req.text()).trim();
  if (text.length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Request body must be JSON.");
    }
    const raw = (body as { focus?: unknown } | null)?.focus;
    if (raw !== undefined && typeof raw !== "string") {
      return fail(400, 'If given, "focus" must be a string.');
    }
    if (typeof raw === "string" && raw.trim().length > 0) focus = raw;
  }

  const outcome = performSummaryExchange(deps.store, agent, to, focus !== undefined ? { focus } : {});
  if (outcome.kind === "no_connection") return noChannel(agent, to, "read-summary");
  const summary = outcome.result;
  // Field by field rather than a spread. `MemorySummary` has nowhere to put a memory row
  // today — no id, no confidence, no review state — and naming the keys is what keeps that
  // true if the type ever grows one: a new field would have to be added here deliberately.
  return json(200, {
    ...(summary.focus !== undefined ? { focus: summary.focus } : {}),
    eligible: summary.eligible,
    included: summary.included,
    withheld: summary.withheld,
    items: summary.items,
  });
}

/**
 * PUT /agents/:a/connections/:b/brief — set (or replace) the standing brief on a
 * `shared-brief` channel; body { content }.
 *
 * The phase's only A→B crossing of content: operator-authored text that enters the CALLEE's
 * framing and shapes every subsequent run of both agents. The memory firewall screens it at
 * the kernel's write boundary, so a refusal is an OUTCOME here (422 + the rules that fired),
 * never the blocked text.
 */
async function setBrief(deps: ConsoleDeps, agent: Agent, to: Agent, req: Request): Promise<Response> {
  const content = await requiredText(req, "content");
  if (!content.ok) return content.response;

  const outcome = performSetBrief(deps.store, agent, to, content.value);
  if (outcome.kind === "no_connection") return noChannel(agent, to, "shared-brief");
  if (outcome.kind === "blocked") {
    // 422: well-formed request, refused content. The findings name the RULES that fired —
    // never echo what was refused, the same discipline the event payload follows. This text
    // would have entered another agent's system prompt.
    return json(422, { error: "Blocked by the memory firewall.", findings: outcome.findings });
  }
  return json(200, {
    brief: briefBody(outcome.brief, agent, agentNames(deps), briefContext(deps, agent)),
    replaced: outcome.replaced,
  });
}

/**
 * DELETE /agents/:a/connections/:b/brief — end the standing brief, so it stops framing
 * either agent's runs from their next run onward. The channel itself stays open.
 *
 * `not_set` is deliberately distinct from `no_connection`: "the channel is open but carries
 * no brief" and "there is no channel" are different facts, and collapsing them would tell an
 * operator their brief is gone when the channel it lived on was the thing that was missing.
 */
function endBrief(deps: ConsoleDeps, agent: Agent, to: Agent): Response {
  const outcome = performEndBrief(deps.store, agent, to);
  if (outcome.kind === "no_connection") return noChannel(agent, to, "shared-brief");
  if (outcome.kind === "not_set") {
    return fail(409, `The shared-brief channel from ${agent.name} to ${to.name} carries no brief.`);
  }
  return json(200, {
    brief: briefBody(outcome.brief, agent, agentNames(deps), briefContext(deps, agent)),
  });
}

/** GET /agents/:a/briefs — every brief this agent participates in, in any status. */
function listBriefsEndpoint(deps: ConsoleDeps, agent: Agent): Response {
  const names = agentNames(deps);
  const context = briefContext(deps, agent);
  return json(200, {
    briefs: deps.store.listBriefs(agent.id).map((b) => briefBody(b, agent, names, context)),
  });
}

/** A caller's echo of the plan it was shown — the evidence it read one. */
interface FetchEcho {
  sizeBytes: number;
  overwrites: boolean;
}

/**
 * POST /agents/:a/connections/:b/fetch — materialize an exchanged artifact into `:a`'s
 * workspace, under `:a`'s own destructive-action gate; body { path, confirm? }.
 *
 * THE ONE OP WITH NO RUN TO CONFIRM AGAINST, and the reason this endpoint has a protocol
 * rather than a body. `performArtifactFetch` is deliberately not a run — no model call, no
 * framing, nothing to resume, nothing parked — so the console's confirm endpoint, which
 * addresses a run PARKED at `awaiting_confirmation`, has nothing to address. And decision
 * D15 closes the easy escape: a fetch confirms at every trust level with `autoApprove`
 * empty, so a surface cannot simply answer the kernel's confirmation `true`.
 *
 * So the confirmation is TWO REQUESTS, and the second must name what the first reported:
 *
 *   POST { path }                                  → 409 + plan { path, sizeBytes, overwrites }
 *   POST { path, confirm: { sizeBytes, overwrites } } → 200, the bytes land
 *
 * BE PRECISE ABOUT WHAT THE ECHO BUYS, because the tempting claim is wrong. It is NOT proof
 * the caller read a fresh plan: `sizeBytes` is already in the manifest the `artifact`
 * exchange handed them, so a caller holding that manifest can name it without ever asking
 * for a plan. What the echo does guarantee is narrower and is the half that matters:
 *
 *   - **No unacknowledged overwrite.** `overwrites` is the one fact in the plan the caller
 *     cannot already know — it describes THEIR OWN workspace at this instant, and it can
 *     change between two requests. Guess it wrong and the fetch is refused and the true
 *     plan returned. So no fetch can silently replace a file the operator did not
 *     acknowledge, which is the risk D12 exists for.
 *   - **Nothing crosses without an explicit, per-fetch confirmation.** Unconditional: no
 *     `confirm` field, no bytes. And because nothing is persisted, it can never decay into
 *     standing — every fetch is confirmed on its own or not at all (D15).
 *
 * It is the idiom the kernel already uses one layer down
 * (`ArtifactMaterializeRequest.expect`), and it is STATELESS: no ticket, no nonce, nothing
 * parked at the surface, because parking a confirmation here would re-create exactly what
 * the kernel refused to park. A stronger binding would need surface state, and that trade
 * was declined deliberately rather than overlooked.
 *
 * Step 1 runs the REAL operation with a confirm callback that records the gate's own
 * invocation and answers no — so the plan describes the fetch step 2 would perform, rather
 * than a re-derivation that could disagree. Its visible consequence, accepted: a preview
 * emits `action.awaiting_confirmation` on the caller's log, exactly as a CLI operator
 * answering "n" does. A preview IS a fetch that was not confirmed.
 */
async function fetchArtifact(
  deps: ConsoleDeps,
  agent: Agent,
  to: Agent,
  req: Request,
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, "Request body must be JSON.");
  const body = parsed.body as Record<string, unknown> | null;
  const rawPath = body?.path;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return fail(400, '"path" must be the workspace-relative path shown in the manifest.');
  }
  // Passed through VERBATIM, with the trim above used only to reject a blank. The reference
  // is matched against what the kernel RECORDED, and the manifest reducer stores a path as
  // the observation gave it (its own `trim()` is a blank check, not a normalization) — so a
  // legitimate path with surrounding whitespace would stop matching its own record and a
  // genuinely exchanged artifact would report `not_exchanged`. [Codex review R2 P3.]
  const path = rawPath;

  let echo: FetchEcho | undefined;
  const rawConfirm = body?.confirm;
  if (rawConfirm !== undefined) {
    const c = rawConfirm as { sizeBytes?: unknown; overwrites?: unknown } | null;
    if (
      typeof c !== "object" ||
      c === null ||
      typeof c.sizeBytes !== "number" ||
      typeof c.overwrites !== "boolean"
    ) {
      return fail(
        400,
        'If given, "confirm" must echo the plan: { "sizeBytes": <number>, "overwrites": <boolean> }.',
      );
    }
    echo = { sizeBytes: c.sizeBytes, overwrites: c.overwrites };
  }

  if (!deps.fetchHost) {
    return fail(503, "This console cannot fetch artifacts — no filesystem host is configured.");
  }

  // The reference vocabulary is the kernel's (`file:<path>`); what an operator reads off a
  // manifest is the bare path, so the surface builds the reference exactly as the CLI does.
  // Only `file:` — a folder is a tree, not an artifact, and the kernel refuses one anyway.
  const ref = `file:${path}`;
  // What the gate was actually asked, captured from its own invocation rather than derived.
  let seen: FetchEcho | undefined;
  const confirm = (action: Action): boolean => {
    const args = action.args as { bytes?: unknown; overwrites?: unknown } | null;
    // A gate invocation we cannot read is one we cannot describe to a human, so it can never
    // be confirmed — and, just as important, it must not resolve to a SENTINEL a caller could
    // echo back. Fail closed and leave `seen` unset: the refusal below then reports the plan
    // from the kernel's own outcome and omits an overwrite fact nobody established.
    if (typeof args?.bytes !== "number" || typeof args.overwrites !== "boolean") return false;
    seen = { sizeBytes: args.bytes, overwrites: args.overwrites };
    if (!echo) return false;
    return echo.sizeBytes === seen.sizeBytes && echo.overwrites === seen.overwrites;
  };

  const outcome = await performArtifactFetch(deps.store, agent, to, ref, {
    host: deps.fetchHost,
    confirm,
  });

  switch (outcome.kind) {
    case "no_connection":
      return noChannel(agent, to, "artifact-only");
    case "not_exchanged":
      // Deliberately says nothing about whether the file exists in the callee's workspace:
      // only what CROSSED can be fetched, so a reference that never crossed must look
      // exactly like one that was never produced.
      return fail(409, `${to.name} has not handed ${agent.name} an artifact at '${path}'.`);
    case "unavailable":
      return fail(409, `Cannot fetch '${path}': ${outcome.reason}`);
    case "withheld":
      // `propose` never performs a side effect, so this is the successful outcome for that
      // trust level, not an error — the plan step, reported instead of taken.
      return json(200, {
        withheld: true,
        path: outcome.path,
        sizeBytes: outcome.sizeBytes,
        reason: `${agent.name} is at trust level propose, so nothing was written.`,
      });
    case "not_confirmed":
      // Either the plan was never echoed (step 1) or the echo did not match what the gate was
      // asked (the destination appeared or vanished in between). Both answer with the CURRENT
      // plan, so the caller confirms what is true now rather than what it was shown before.
      return json(409, {
        error: echo
          ? `The confirmation did not match the fetch — nothing was written. Re-confirm the plan below.`
          : `Fetching '${path}' needs your explicit confirmation. Repeat this request with "confirm" set to the plan below.`,
        plan: {
          path: outcome.path,
          sizeBytes: outcome.sizeBytes,
          ...(seen ? { overwrites: seen.overwrites } : {}),
        },
      });
    case "ok":
      return json(200, {
        ref: outcome.result.ref,
        path: outcome.result.path,
        bytes: outcome.result.bytes,
        overwrote: outcome.result.overwrote,
      });
  }
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
 *
 * Collaboration — the only routes naming two agents, all rooted at the CALLER (D31):
 *   GET    /agents/:a/connections         channels :a is on (both directions)
 *   POST   /agents/:a/connections         grant :a → to; body { to, mode }
 *   DELETE /agents/:a/connections/:b      withdraw a channel; ?mode=<mode> required
 *   POST   /agents/:a/connections/:b/handoff    body { task }
 *   POST   /agents/:a/connections/:b/artifact   body { task }
 *   POST   /agents/:a/connections/:b/summary    body { focus? }
 *   POST   /agents/:a/connections/:b/fetch      body { path, confirm? }
 *   PUT    /agents/:a/connections/:b/brief      body { content }
 *   DELETE /agents/:a/connections/:b/brief      end the standing brief
 *   GET    /agents/:a/briefs              standing briefs on :a's channels
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

    // The 4-segment route: /agents/:a/connections/:b — the CHANNEL itself, addressed as the
    // pair it is. Only DELETE lives here; granting is a POST to the collection above, so the
    // callee's name never has to be a valid path segment to open a channel.
    if (segments.length === 4) {
      if (segments[2] !== "connections") return fail(404, "Not found.");
      let calleeName: string;
      try {
        calleeName = decodeURIComponent(segments[3]!);
      } catch {
        return fail(404, "Not found.");
      }
      const to = findAgent(deps, calleeName);
      if (!to) return fail(404, `No agent named "${calleeName}".`);
      if (req.method === "DELETE") return disconnect(deps, agent, to, url);
      return fail(405, "Method not allowed.");
    }

    // The 5-segment routes: /agents/:a/runs/:r/<confirm|decline>,
    // /agents/:a/memory/:m/<accept|reject>, and /agents/:a/connections/:b/<verb>.
    if (segments.length === 5) {
      let id: string;
      try {
        id = decodeURIComponent(segments[3]!);
      } catch {
        return fail(404, "Not found.");
      }
      const action = segments[4];
      if (segments[2] === "connections") {
        // The callee is an AGENT NAME here, not an entity id — resolved once, so every verb
        // below refuses an unknown agent identically and none of them re-look-it-up.
        const to = findAgent(deps, id);
        if (!to) return fail(404, `No agent named "${id}".`);
        if (action === "handoff") {
          if (req.method === "POST") return handoff(deps, agent, to, req);
          return fail(405, "Method not allowed.");
        }
        if (action === "artifact") {
          if (req.method === "POST") return artifactExchange(deps, agent, to, req);
          return fail(405, "Method not allowed.");
        }
        if (action === "summary") {
          if (req.method === "POST") return summaryExchange(deps, agent, to, req);
          return fail(405, "Method not allowed.");
        }
        if (action === "fetch") {
          if (req.method === "POST") return fetchArtifact(deps, agent, to, req);
          return fail(405, "Method not allowed.");
        }
        if (action === "brief") {
          if (req.method === "PUT") return setBrief(deps, agent, to, req);
          if (req.method === "DELETE") return endBrief(deps, agent, to);
          return fail(405, "Method not allowed.");
        }
        return fail(404, "Not found.");
      }
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
    if (resource === "connections") {
      if (req.method === "GET") return listConnectionsEndpoint(deps, agent);
      if (req.method === "POST") return connect(deps, agent, req);
      return fail(405, "Method not allowed.");
    }
    if (resource === "briefs") {
      if (req.method === "GET") return listBriefsEndpoint(deps, agent);
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
 * it binds with `Bun.serve`; off Bun (Node 22+) it binds with `node:http` via the
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
