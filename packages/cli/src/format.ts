// Pure output formatting. Takes kernel entities, returns the strings the CLI
// prints — no I/O, no store, trivially testable. Nothing here ever renders a
// secret value (the kernel never hands one out to these surfaces anyway).

import type { Event, Memory } from "@qmilab/asterism-core";

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
