// Pure output formatting. Takes kernel entities, returns the strings the CLI
// prints — no I/O, no store, trivially testable. Nothing here ever renders a
// secret value (the kernel never hands one out to these surfaces anyway).

import type {
  ActionRecord,
  Agent,
  ArtifactRef,
  CapabilityGrant,
  Connection,
  Event,
  Memory,
  MemorySummary,
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
 *
 * WITHDRAWN channels stay listed, sorted after the open ones and labelled. This is the
 * surface an operator checks to answer "did that revoke take effect?", so hiding a revoked
 * row would remove the evidence at exactly the place it is looked for — and a
 * revoke-then-reconnect pair would read as though nothing had ever happened. Sorting keeps
 * them from crowding the channels that still carry work; the label keeps them from being
 * mistaken for one.
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
  // Open channels first, withdrawn ones after — a stable partition of the store's existing
  // oldest-first order, not a re-sort, so rows keep their order within each group.
  const ordered = [
    ...connections.filter((c) => c.status === "active"),
    ...connections.filter((c) => c.status !== "active"),
  ];
  for (const c of ordered) {
    const outbound = c.fromAgentId === agent.id;
    const otherId = outbound ? c.toAgentId : c.fromAgentId;
    const other = nameById.get(otherId) ?? shortId(otherId);
    const arrow = outbound ? `→ ${other}` : `← ${other}`;
    // A revoked row is history, so it says so in words as well as in the status field —
    // `revoked` alone reads as a state a channel might come back from, and it cannot.
    const withdrawn = c.status === "revoked" ? "  (withdrawn — nothing crosses it)" : "";
    lines.push(`• ${arrow} · ${c.mode} · ${c.status} · ${shortId(c.id)}${withdrawn}`);
  }
  lines.push("");
  // Mode-neutral wording: a channel may carry a handoff or an artifact-only exchange, so the
  // legend describes the DIRECTION of work, not one mode's verb.
  lines.push("→ outbound (this agent may send work to the other) · ← inbound (the other may send work to this agent)");
  return lines.join("\n").trimEnd();
}

/**
 * Render the manifest an `artifact-only` exchange returned — the workspace artifacts the
 * callee produced, as REFERENCES: path, size, and whether each still exists.
 *
 * Deliberately says what did NOT cross. The mode's whole point is that the callee's words
 * and its file contents stay on its side of the boundary, so the footer names that plainly
 * rather than leaving the operator to infer why there is no prose here — and points at the
 * one place the bytes actually are (the callee's own workspace, on the operator's disk).
 *
 * A deleted path is shown too: the manifest describes everything the run CHANGED, so a file
 * the callee wrote and then removed reads as `deleted` rather than silently vanishing.
 */
export function formatArtifactManifest(
  artifacts: readonly ArtifactRef[],
  calleeName: string,
): string[] {
  if (artifacts.length === 0) {
    return [`${calleeName} produced no artifacts.`];
  }
  const lines = [`${calleeName} produced ${artifacts.length === 1 ? "1 artifact" : `${artifacts.length} artifacts`}:`];
  for (const a of artifacts) {
    const detail = !a.exists
      ? "deleted"
      : a.sizeBytes !== undefined
        ? formatBytes(a.sizeBytes)
        : a.kind === "dir"
          ? "directory"
          : "present";
    // A screened name is shown, but say so — otherwise the operator reads a path that looks
    // real, tries to fetch it, and gets a refusal with no idea why. The name itself is not
    // recoverable here by design; the honest thing is to name the limitation next to it.
    const note = a.redacted ? "  (name partly screened — cannot be fetched)" : "";
    lines.push(`  ${a.path}   ${detail}${note}`);
  }
  lines.push("");
  lines.push(
    `Only these references crossed — not ${calleeName}'s words, memory, or the file contents.`,
  );
  lines.push(`The files are in ${calleeName}'s own workspace.`);
  return lines;
}

/**
 * Render the curated extract a `read-summary` pull returned — what the callee KNOWS,
 * projected to kind + screened content, never its memory records (Phase 3 · T2b).
 *
 * The counts lead, because a bounded extract that does not say it is bounded is the one way
 * this rendering could mislead: an operator reading eight lines needs to know whether that was
 * everything. The screen's refusals are reported separately from the budget's cap, since one
 * is a refusal and the other is a bound — and the reason is named, because "3 held back" with
 * no explanation reads as a malfunction rather than the boundary working.
 *
 * The copy is deliberately exact about what this is. The mode is called `read-summary`, but
 * nothing wrote a summary: what crossed is a screened extract of ratified memory, and saying
 * "summary" as though a model had composed one would overclaim in precisely the way the
 * project's isolation copy is careful not to.
 */
export function formatMemorySummary(summary: MemorySummary, calleeName: string): string[] {
  if (summary.eligible === 0) {
    return [
      `${calleeName} has no ratified memory to share.`,
      `Only memory its operator has accepted can cross — nothing proposed, rejected, or archived.`,
    ];
  }
  if (summary.items.length === 0) {
    const why =
      summary.withheld > 0
        ? `all ${summary.withheld === 1 ? "of it was" : `${summary.withheld} were`} held back by the outbound screen`
        : `none of it matched`;
    return [`Nothing crossed from ${calleeName}: ${why}.`];
  }

  const noun = summary.included === 1 ? "note" : "notes";
  const lines = [
    `${calleeName} knows ${summary.included} of ${summary.eligible} ratified ${noun}` +
      (summary.focus !== undefined ? `, on "${summary.focus}"` : "") +
      ":",
    "",
  ];
  // Pad the kind so the content lines up — the kind is a label, not the point.
  const width = Math.max(...summary.items.map((i) => i.memoryType.length));
  for (const item of summary.items) {
    const kind = item.memoryType.padEnd(width);
    // A screened item is marked, for the same reason a screened artifact path is: the operator
    // is reading text the boundary CHANGED, and text that looks untouched but isn't is worse
    // than text that says so.
    const note = item.screened ? "   (screened)" : "";
    lines.push(`  ${kind}  ${item.content}${note}`);
  }
  lines.push("");
  if (summary.withheld > 0) {
    lines.push(
      `${summary.withheld} more ${summary.withheld === 1 ? "note was" : "notes were"} held back by the outbound screen.`,
    );
  }
  const capped = summary.eligible - summary.included - summary.withheld;
  if (capped > 0) {
    lines.push(`${capped} more did not fit this extract — ask again with a focus to reach them.`);
  }
  lines.push(
    `Only this extract crossed — not ${calleeName}'s memory records, its runs, or anything it has not accepted.`,
  );
  return lines;
}

/**
 * Human-readable byte size for a manifest row — whole units, no false precision. Shared with
 * `artifact fetch` so a size the operator read off the manifest is rendered the same way
 * when the bytes actually land.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
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
