// Pure output formatting. Takes kernel entities, returns the strings the CLI
// prints — no I/O, no store, trivially testable. Nothing here ever renders a
// secret value (the kernel never hands one out to these surfaces anyway).

import type { Agent, Event, Memory, Run } from "@qmilab/asterism-core";

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
