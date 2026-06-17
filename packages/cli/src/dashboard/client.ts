// The dashboard's HTTP client — the ONLY thing the TUI uses to reach the kernel.
//
// Thin by mandate (issue #44): the dashboard holds no behavior of its own. Every
// action a user takes in the TUI is one call here, and every call is one request to
// the install-wide operator console (packages/server `handleConsoleRequest`). There
// is no kernel access, no scoping decision, and no trust reasoning in this file or
// anywhere in `dashboard/` — those live behind the endpoint, exactly as they do for
// the CLI and `serve`.
//
// `fetch` is injectable so the client is testable WITHOUT a socket: a test passes a
// function that calls `handleConsoleRequest(deps, new Request(...))` directly, so the
// real routing + auth + kernel calls are exercised end-to-end in-process.

import type { Agent, Event, Memory, Run, ReviewableProposal, TrustLevel } from "@qmilab/asterism-core";

/** A `fetch`-shaped function. The default is the runtime's global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One agent on the roster — identity, autonomy, and lightweight activity badges. */
export interface RosterEntry {
  name: string;
  role: string;
  soulRef: string;
  trustLevel: TrustLevel;
  createdAt: string;
  lastRunAt?: string;
  pendingConfirmations: number;
}

/** A settled confirm/resume — the same shape `serve` returns. */
export interface RunResult {
  run: Run;
  status: string;
  output?: string;
  actions?: readonly { capability: string; effect: string; decision: string }[];
  error?: string;
}

/** The proposals a reflect call surfaced (transient — nothing is persisted yet). */
export interface ReflectResult {
  runId?: string;
  proposals: ReviewableProposal[];
  ignored: number;
}

/** Filters for an events read, mirroring the endpoint's query params. */
export interface EventQuery {
  sinceId?: string;
  limit?: number;
  type?: string;
  runId?: string;
}

/**
 * A non-2xx response from the console, surfaced to the TUI as a typed error so it can
 * show the server's message (e.g. "Run is done, not awaiting confirmation.") and any
 * firewall findings without inventing its own copy.
 */
export class DashboardError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly findings?: readonly { rule: string }[],
  ) {
    super(message);
    this.name = "DashboardError";
  }
}

export class DashboardClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    // Normalize away a trailing slash so path joins never double up.
    this.base = baseUrl.replace(/\/+$/, "");
  }

  /** All agents on the install, with trust level and activity badges. */
  async listAgents(): Promise<RosterEntry[]> {
    const body = await this.get("/agents");
    return (body as { agents: RosterEntry[] }).agents;
  }

  /** One agent's runs, oldest-first. */
  async getRuns(agent: string): Promise<Run[]> {
    const body = await this.get(`/agents/${enc(agent)}/runs`);
    return (body as { runs: Run[] }).runs;
  }

  /** One agent's event timeline, with optional tail filters. */
  async getEvents(agent: string, query: EventQuery = {}): Promise<Event[]> {
    const params = new URLSearchParams();
    if (query.sinceId !== undefined) params.set("since", query.sinceId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.type !== undefined) params.set("type", query.type);
    if (query.runId !== undefined) params.set("run", query.runId);
    const qs = params.toString();
    const body = await this.get(`/agents/${enc(agent)}/events${qs ? `?${qs}` : ""}`);
    return (body as { events: Event[] }).events;
  }

  /** One agent's memories (optionally filtered by review state / type). */
  async getMemory(
    agent: string,
    query: { reviewState?: string; type?: string } = {},
  ): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (query.reviewState !== undefined) params.set("reviewState", query.reviewState);
    if (query.type !== undefined) params.set("type", query.type);
    const qs = params.toString();
    const body = await this.get(`/agents/${enc(agent)}/memory${qs ? `?${qs}` : ""}`);
    return (body as { memories: Memory[] }).memories;
  }

  /** Dial an agent's autonomy level; returns the updated agent. */
  async setTrust(agent: string, level: TrustLevel): Promise<Agent> {
    const body = await this.send("PUT", `/agents/${enc(agent)}/trust`, { level });
    return (body as { agent: Agent }).agent;
  }

  /** Approve a paused destructive action and let the run finish. */
  async confirmRun(agent: string, runId: string): Promise<RunResult> {
    return (await this.send(
      "POST",
      `/agents/${enc(agent)}/runs/${enc(runId)}/confirm`,
    )) as RunResult;
  }

  /** Refuse a paused destructive action; the run ends without it. */
  async declineRun(agent: string, runId: string): Promise<{ run: Run; status: string }> {
    return (await this.send(
      "POST",
      `/agents/${enc(agent)}/runs/${enc(runId)}/decline`,
    )) as { run: Run; status: string };
  }

  /** Propose reviewable memories from a run (default: the latest with output). */
  async reflect(agent: string, runId?: string): Promise<ReflectResult> {
    const body = await this.send(
      "POST",
      `/agents/${enc(agent)}/reflect`,
      runId !== undefined ? { runId } : {},
    );
    return body as ReflectResult;
  }

  /** Persist an accepted (or edited) proposed memory. */
  async saveMemory(
    agent: string,
    memory: { memoryType: string; content: string; confidence?: number; sourceRunId?: string },
  ): Promise<Memory> {
    const body = await this.send("POST", `/agents/${enc(agent)}/memory`, memory);
    return (body as { memory: Memory }).memory;
  }

  // --- transport ----------------------------------------------------------

  private get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  private send(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, body);
  }

  /**
   * One authenticated request. Adds the bearer token, sends/parses JSON, and turns a
   * non-2xx response into a {@link DashboardError} carrying the server's message (and
   * any firewall findings), so the caller never has to read a raw Response.
   */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    const text = await res.text();
    const parsed: unknown = text.length > 0 ? safeJson(text) : undefined;
    if (!res.ok) {
      const err = parsed as { error?: string; findings?: { rule: string }[] } | undefined;
      throw new DashboardError(
        res.status,
        err?.error ?? `Request failed (${res.status}).`,
        err?.findings,
      );
    }
    return parsed;
  }
}

/** Encode one path segment (an agent name or run id) for safe interpolation. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Parse JSON, or return undefined for a non-JSON body (never throw at the transport). */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
