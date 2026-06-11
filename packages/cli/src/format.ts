// Pure output formatting. Takes kernel entities, returns the strings the CLI
// prints — no I/O, no store, trivially testable. Nothing here ever renders a
// secret value (the kernel never hands one out to these surfaces anyway).

import type {
  ActionRecord,
  Agent,
  Event,
  Memory,
  Run,
  RunEvent,
} from "@qmilab/asterism-core";

/** First 8 chars of a UUID — enough to recognize, short enough to scan. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

/** One row of the `list` roster: an agent and when it last ran (if ever). */
export interface AgentRosterEntry {
  agent: Agent;
  /** Start time of the agent's most recent run; absent if it has never run. */
  lastRunAt?: string;
}

/**
 * Render the agent roster for `list`. The headline carries the two facts that
 * matter at a glance — who exists and how much each may do on its own — with the
 * role and last-active time beneath. This is the registry, not agent-scoped data,
 * so it takes no agent name.
 */
export function formatAgentList(entries: readonly AgentRosterEntry[]): string {
  if (entries.length === 0) {
    return "No agents yet. Create one with: asterism new <name>";
  }
  const lines: string[] = [`Agents (${entries.length}):`, ""];
  for (const { agent, lastRunAt } of entries) {
    lines.push(`• ${agent.name} · ${agent.trustLevel}`);
    if (agent.role) lines.push(`  role: ${agent.role}`);
    lines.push(`  ${lastRunAt ? `last run ${lastRunAt}` : "never run"}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Render an agent's run history for `runs`. Oldest first, matching the store. */
export function formatRunList(
  runs: readonly Run[],
  agentName: string,
): string {
  if (runs.length === 0) {
    return `${agentName} has no runs yet.`;
  }
  const lines: string[] = [`Runs for ${agentName} (${runs.length}):`, ""];
  for (const r of runs) {
    lines.push(`• ${shortId(r.id)} · ${r.status}`);
    lines.push(`  ${r.input}`);
    const finished = r.finishedAt ? ` · finished ${r.finishedAt}` : "";
    lines.push(`  started ${r.startedAt}${finished}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Render an agent's scoped memory for `memory inspect`. */
export function formatMemoryList(
  memories: readonly Memory[],
  agentName: string,
): string {
  if (memories.length === 0) {
    return `${agentName} has no memories yet.`;
  }
  const lines: string[] = [`Memory for ${agentName} (${memories.length}):`, ""];
  for (const m of memories) {
    const archived = m.status === "archived" ? " · archived" : "";
    lines.push(
      `• ${m.memoryType} · ${m.reviewState}${archived} · confidence ${m.confidence}`,
    );
    lines.push(`  ${m.content}`);
    const source = m.sourceRunId ? ` · from run ${shortId(m.sourceRunId)}` : "";
    lines.push(`  ${m.createdAt}${source}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render one run lifecycle event as a concise activity line for live display, or
 * `undefined` for the bookkeeping events not worth surfacing (turn/message
 * boundaries). Only the tool executions — the run's visible *actions* — are
 * shown as they happen; the authoritative taken/withheld/paused classification
 * arrives afterward via {@link formatActionSummary}. Payloads are references-only
 * (tool name, error flag) by the adapter contract — never transcript text.
 */
export function formatRunActivity(event: RunEvent): string | undefined {
  const payload = (event.payload ?? {}) as { tool?: unknown; isError?: unknown };
  const tool = typeof payload.tool === "string" ? payload.tool : "tool";
  switch (event.type) {
    case "tool_execution_start":
      return `  → ${tool}`;
    case "tool_execution_end":
      return payload.isError === true ? `  ✗ ${tool}` : `  ✓ ${tool}`;
    default:
      return undefined;
  }
}

/** Glyph per gate decision for the action summary. */
const ACTION_GLYPH: Readonly<Record<ActionRecord["decision"], string>> = {
  executed: "✓",
  withheld: "⊘",
  paused: "⏸",
};

/**
 * Render the post-run action summary — what the agent did (executed), withheld
 * under `propose`, or paused on awaiting confirmation, in order. This is the
 * after-the-fact notification a `notify`/`autonomous` run ends with ("notify
 * finally notifies"). References only: each line is the capability key plus its
 * classified effect, never an argument value. Returns the lines to print; the
 * caller picks the sink (stderr, so the agent's own output on stdout stays
 * clean and pipeable). Empty input ⇒ no lines.
 */
export function formatActionSummary(actions: readonly ActionRecord[]): string[] {
  if (actions.length === 0) return [];
  const counts: Record<ActionRecord["decision"], number> = {
    executed: 0,
    withheld: 0,
    paused: 0,
  };
  for (const a of actions) counts[a.decision]++;
  const tally = (["executed", "withheld", "paused"] as const)
    .filter((d) => counts[d] > 0)
    .map((d) => `${counts[d]} ${d}`)
    .join(", ");
  const lines = [`Actions (${tally}):`];
  for (const a of actions) {
    lines.push(`  ${ACTION_GLYPH[a.decision]} ${a.decision.padEnd(8)} ${a.capability} (${a.effect})`);
  }
  return lines;
}

/** Render an agent's event log for `events tail`. */
export function formatEventList(
  events: readonly Event[],
  agentName: string,
): string {
  if (events.length === 0) {
    return `${agentName} has no recorded activity yet.`;
  }
  const lines: string[] = [`Activity for ${agentName} (${events.length}):`, ""];
  for (const e of events) {
    const run = e.runId ? `  run=${shortId(e.runId)}` : "";
    lines.push(`${e.createdAt}  ${e.type}${run}`);
    const payload = summarizePayload(e.payload);
    if (payload && payload !== "{}") lines.push(`  ${payload}`);
  }
  return lines.join("\n").trimEnd();
}
