// Pure output formatting. Takes kernel entities, returns the strings the CLI
// prints — no I/O, no store, trivially testable. Nothing here ever renders a
// secret value (the kernel never hands one out to these surfaces anyway).

import type {
  ActionRecord,
  Agent,
  CapabilityGrant,
  Connection,
  Event,
  Memory,
  Objective,
  Run,
  RunEvent,
  TrustLevel,
  WorldFact,
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

/**
 * Render an agent's scoped memory for `memory inspect`. `filterNote` (e.g.
 * `type=semantic, review-state=proposed`) describes any active filter so the
 * header and the empty-result message tell the reader they are looking at a
 * narrowed view, not the whole memory — the difference between "nothing remembered"
 * and "nothing matches this filter".
 */
export function formatMemoryList(
  memories: readonly Memory[],
  agentName: string,
  filterNote?: string,
): string {
  if (memories.length === 0) {
    return filterNote
      ? `${agentName} has no memories matching ${filterNote}.`
      : `${agentName} has no memories yet.`;
  }
  const heading = filterNote
    ? `Memory for ${agentName} (${memories.length} matching ${filterNote}):`
    : `Memory for ${agentName} (${memories.length}):`;
  const lines: string[] = [heading, ""];
  for (const m of memories) {
    const archived = m.status === "archived" ? " · archived" : "";
    lines.push(
      `• ${m.memoryType} · ${m.reviewState}${archived} · confidence ${m.confidence}`,
    );
    lines.push(`  ${m.content}`);
    const source = m.sourceRunId ? ` · from run ${shortId(m.sourceRunId)}` : "";
    lines.push(`  recorded ${m.createdAt}${source}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render an agent's standing objectives for `objective list`. Only `active` AND `accepted`
 * objectives frame runs, so those come first (oldest-first), then any reflection-PROPOSED
 * ones awaiting review (inert until accepted), then completed / dropped / rejected ones as
 * history; the count line names how many actually frame, and how many are proposed. A
 * non-accepted review state is shown on the line so a proposed objective never reads as one
 * that frames. Each line leads with the short id so `objective done`/`drop` (and
 * `reflect --review`) can reference it. Only ever one agent's own objectives — `agentId`-scoped.
 */
export function formatObjectiveList(
  objectives: readonly Objective[],
  agentName: string,
): string {
  if (objectives.length === 0) {
    return `${agentName} has no objectives yet. Declare one with: asterism objective add ${agentName} "<text>"`;
  }
  // Framing set first (active + accepted), then proposals awaiting review, then history —
  // a stable partition of the already oldest-first list, deterministic within each group.
  const framing = objectives.filter((o) => o.status === "active" && o.reviewState === "accepted");
  const proposed = objectives.filter((o) => o.reviewState === "proposed");
  const seen = new Set([...framing, ...proposed]);
  const history = objectives.filter((o) => !seen.has(o));
  const header =
    `Objectives for ${agentName} (${objectives.length}, ${framing.length} active` +
    `${proposed.length > 0 ? `, ${proposed.length} proposed` : ""}):`;
  const lines: string[] = [header, ""];
  for (const o of [...framing, ...proposed, ...history]) {
    // Surface a non-accepted review state (proposed / rejected) so it never reads as framing.
    const review = o.reviewState !== "accepted" ? ` · ${o.reviewState}` : "";
    lines.push(`• ${shortId(o.id)} · ${o.status}${review}`);
    lines.push(`  ${o.content}`);
    lines.push(`  declared ${o.createdAt}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render an agent's WORLD-FACTS — its working notes — for `notes inspect`. These are
 * the agent's OWN unverified record (it wrote them mid-run, no human review), so the
 * header says so plainly; never present them as verified state.
 *
 * Grouped by SUBJECT (world-model.md §12 coexistence): a subject can hold an `accepted`
 * note AND a coexisting `proposed` UPDATE awaiting review. An accepted note shows its
 * framed value; a coexisting proposal is shown as a pending update beneath it (the accepted
 * value keeps framing until the operator accepts). A brand-new `proposed` note (no accepted
 * row yet) is flagged as awaiting review — it does NOT frame until accepted. The header
 * count is DISTINCT subjects (the cap basis), and the `cap` (when given) is shown so an
 * operator can see how full the agent's notes are. Subjects appear oldest-first (the order
 * the kernel returns rows in).
 */
export function formatWorldFactList(
  facts: readonly WorldFact[],
  agentName: string,
  cap?: number,
): string {
  if (facts.length === 0) {
    return `${agentName} has no working notes yet. The agent records its own as it runs; you can set one with: asterism notes set ${agentName} "<subject>" "<value>"`;
  }
  // Pair each subject's accepted note with any coexisting proposed update. The input is
  // oldest-first, so a Map keyed by subject preserves first-seen (oldest) subject order.
  const bySubject = new Map<string, { accepted?: WorldFact; proposed?: WorldFact }>();
  for (const f of facts) {
    let entry = bySubject.get(f.subject);
    if (entry === undefined) {
      entry = {};
      bySubject.set(f.subject, entry);
    }
    if (f.reviewState === "accepted") entry.accepted = f;
    else if (f.reviewState === "proposed") entry.proposed = f;
    // (No `rejected` rows exist — reject discards — so nothing else to bucket.)
  }
  const fill = cap !== undefined ? ` of ${cap}` : "";
  const lines: string[] = [
    `Working notes for ${agentName} (${bySubject.size}${fill}) — the agent's own unverified record, not facts:`,
    "",
  ];
  for (const [subject, { accepted, proposed }] of bySubject) {
    if (accepted) {
      // The framed value. A coexisting proposal is a pending UPDATE shown beneath it — the
      // accepted value still frames until the operator accepts (accept applies, reject keeps).
      lines.push(`• ${subject}: ${accepted.value}`);
      if (proposed) {
        lines.push(
          `  ⟳ pending update → ${proposed.value} — awaiting your review (accept to apply, reject to keep the current value)`,
        );
      }
      lines.push(`  updated ${accepted.updatedAt}`);
    } else if (proposed) {
      // A brand-new proposal with no accepted note yet — inert until accepted.
      lines.push(`• ${subject}: ${proposed.value}  ⟳ awaiting your review — not yet framing runs`);
      lines.push(`  updated ${proposed.updatedAt}`);
    }
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render an agent's connections for `connections <agent>` — the explicit, permissioned
 * channels it is on. A connection is directional, so each line shows which way it runs
 * relative to THIS agent: `→ other` is OUTBOUND (this agent may hand off to `other`), `←
 * other` is INBOUND (`other` may hand off to this agent). The other agent is named via
 * `nameById` (an id→name lookup the caller builds from the registry); an id with no entry
 * (an agent removed since) falls back to a short id so a row is never blank. Each line
 * leads with the mode and status, then the short connection id. Only ever the connections
 * this agent participates in — the store scopes the list to a participant.
 */
export function formatConnectionList(
  connections: readonly Connection[],
  agent: Agent,
  nameById: ReadonlyMap<string, string>,
): string {
  if (connections.length === 0) {
    return `${agent.name} has no connections yet. Open one with: asterism connect ${agent.name} <other> --mode handoff`;
  }
  const lines: string[] = [`Connections for ${agent.name} (${connections.length}):`, ""];
  for (const c of connections) {
    const outbound = c.fromAgentId === agent.id;
    const otherId = outbound ? c.toAgentId : c.fromAgentId;
    const other = nameById.get(otherId) ?? shortId(otherId);
    const arrow = outbound ? `→ ${other}` : `← ${other}`;
    lines.push(`• ${arrow} · ${c.mode} · ${c.status} · ${shortId(c.id)}`);
  }
  lines.push("");
  lines.push("→ outbound (this agent may hand off to the other) · ← inbound (the other may hand off to this agent)");
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

/**
 * Render an agent's earned standings for `trust <agent> show` — its whole-agent
 * autonomy level, then each destructive capability it has earned the right to act on
 * without pausing (`standing-grant`) versus one reset to `gated`. References only:
 * the capability key and the recorded `basis` (counts), never an action's arguments.
 * A capability with no row is implicitly gated and simply absent from the list.
 */
export function formatStandingList(
  grants: readonly CapabilityGrant[],
  agentName: string,
  level: TrustLevel,
): string {
  const header = `${agentName} · autonomy: ${level}`;
  const granted = grants.filter((g) => g.standing === "standing-grant");
  if (granted.length === 0) {
    return [
      header,
      "",
      "No capabilities have earned a standing grant — every destructive action pauses",
      "for your confirmation. Earn one with a clean track record, then `trust <agent> --review`.",
    ].join("\n");
  }
  const lines: string[] = [header, "", `Acts without pausing (${granted.length}):`];
  for (const g of granted) {
    lines.push(`  ✓ ${g.capability} — ${g.basis} · granted ${g.updatedAt}`);
  }
  return lines.join("\n");
}

/**
 * Render ONE event as its display lines: a time/type/run header line, and an
 * indented references-only payload line when there is one worth showing. Shared by
 * the one-shot {@link formatEventList} and the live `--follow` loop, so a streamed
 * event renders identically to one printed in the initial batch.
 */
export function formatEventLines(event: Event): string[] {
  const run = event.runId ? `  run=${shortId(event.runId)}` : "";
  const lines = [`${event.createdAt}  ${event.type}${run}`];
  const payload = summarizePayload(event.payload);
  if (payload && payload !== "{}") lines.push(`  ${payload}`);
  return lines;
}

/**
 * Render an agent's event log for `events tail`. `filterNote` (e.g.
 * `type=action.executed, run=a1b2c3d4`) names any active filter in the header and
 * the empty-result message, so a narrowed view never reads as the whole log.
 */
export function formatEventList(
  events: readonly Event[],
  agentName: string,
  filterNote?: string,
): string {
  if (events.length === 0) {
    return filterNote
      ? `${agentName} has no activity matching ${filterNote}.`
      : `${agentName} has no recorded activity yet.`;
  }
  const heading = filterNote
    ? `Activity for ${agentName} (${events.length}, ${filterNote}):`
    : `Activity for ${agentName} (${events.length}):`;
  const lines: string[] = [heading, ""];
  for (const e of events) lines.push(...formatEventLines(e));
  return lines.join("\n").trimEnd();
}
