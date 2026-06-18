// Reflection — the kernel's contract for turning a finished run into PROPOSED,
// human-reviewable memory.
//
// Core defines the interface and the data shapes; it depends on NO model client.
// The default provider (a hosted model) lives in `@qmilab/asterism-reflect`, the
// only package permitted to import a reflection model client — exactly the seam
// the RuntimeAdapter/adapter-pi split uses to keep the substrate replaceable.
//
// Two invariants live here, in the contract, not in any provider:
//
//   1. Reflection only ever PROPOSES. Nothing in this interface persists memory.
//      A `ReflectionProvider` returns proposals; whether any of them becomes a
//      real memory is the reviewer's decision, gated by the human AND the memory
//      firewall on the write path (see the CLI's `reflect --review`). A provider
//      that wrote memory directly would be a bug, not an implementation choice —
//      the return type gives it nowhere to write.
//
//   2. Proposals are limited to the four DURABLE memory types. `episodic` is a
//      record of what happened, not a learned lesson, so reflection never proposes
//      it (a Phase 0 constraint). The subset is checked against `MemoryType` at
//      compile time so the two can never drift.

import type { Agent, Memory, MemoryType, Run } from "./types.js";
import type { AsterismStore } from "./store.js";
import { assertMemorySafe, MemoryFirewallError, screenMemory } from "./firewall.js";
import type { FirewallFinding } from "./firewall.js";

/**
 * The memory types reflection may propose — the durable, behaviour-shaping kinds.
 * Deliberately excludes `episodic`. `satisfies readonly MemoryType[]` makes this a
 * compile-time-checked subset of the canonical {@link MemoryType} set.
 */
export const REFLECTION_MEMORY_TYPES = [
  "semantic",
  "procedural",
  "convention",
  "negative",
] as const satisfies readonly MemoryType[];

export type ReflectionMemoryType = (typeof REFLECTION_MEMORY_TYPES)[number];

/** Whether `value` is one of the four memory types reflection is allowed to propose. */
export function isReflectionMemoryType(
  value: string,
): value is ReflectionMemoryType {
  return (REFLECTION_MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * A finished run reduced to what reflection reads: the task it was given and the
 * agent's final output. Phase 0 deliberately does NOT carry the full tool-call
 * trajectory — that is trajectory export, out of scope — so reflection learns from
 * the task and the result, not from a replay of every step.
 */
export interface RunTranscript {
  /** The run this transcript belongs to; every proposal is attributed back to it. */
  runId: string;
  /** The task the run was given. */
  input: string;
  /** The agent's final output text for the run. */
  output: string;
}

/** What the kernel hands a {@link ReflectionProvider} to reflect on. */
export interface ReflectionInput {
  /** The agent whose run this was — every resulting proposal is scoped to it. */
  agentId: string;
  /** The run to learn from. */
  transcript: RunTranscript;
  /**
   * Contents of memories the agent already holds, so a provider can avoid
   * re-proposing what is already known. Advisory only — the human review step is
   * the real gate, not this hint. Optional.
   */
  knownMemories?: readonly string[];
}

/**
 * A single proposed memory write. A provider produces these; it never persists
 * them. `confidence` is the provider's own estimate in [0, 1]; `sourceRunId` ties
 * the proposal back to the run it was learned from (it becomes the memory's
 * `sourceRunId` if a human accepts it).
 */
export interface ProposedMemory {
  memoryType: ReflectionMemoryType;
  content: string;
  confidence: number;
  sourceRunId: string;
}

/**
 * Turns a run transcript into PROPOSED typed memory writes. The default
 * implementation drives a hosted model and lives in `@qmilab/asterism-reflect`;
 * core depends on no model client, mirroring the RuntimeAdapter seam. Returns a
 * read-only list so a caller can never mistake the result for a writable store.
 */
export interface ReflectionProvider {
  reflect(input: ReflectionInput): Promise<readonly ProposedMemory[]>;
}

/**
 * A proposed memory readied for human review: the provider's proposal plus the
 * memory firewall's findings on its content (empty when it screens clean). The
 * findings are advisory — for the reviewer to see WHAT tripped a rule — the hard
 * gate is the firewall re-screen at persistence (`store.recordMemory`).
 */
export interface ReviewableProposal extends ProposedMemory {
  findings: readonly FirewallFinding[];
}

/**
 * The outcome of {@link proposeReviewableMemories}:
 * - `proposed` — a reflectable run was found and the provider returned proposals
 *   (possibly an empty list); `ignored` counts proposals dropped for a
 *   non-reviewable memory type.
 * - `no_run`   — the agent has no completed run with output to reflect on (or the
 *   requested run has none), so nothing was sent to the provider.
 */
export type ProposeResult =
  | { kind: "proposed"; runId: string; proposals: ReviewableProposal[]; ignored: number }
  | { kind: "no_run" };

/**
 * The reflect-proposal pipeline, shared by every surface that reviews memory (the
 * CLI's `reflect --review` and the dashboard's console endpoint) so they can never
 * drift on WHAT is reviewable. It selects the run to learn from (a given `runId`, or
 * the agent's latest run with output), hands the transcript and the agent's already-
 * known memories to the provider, then applies the two kernel policies: the
 * reflection-only type filter ({@link isReflectionMemoryType}) and a memory-firewall
 * screen of each proposal for display.
 *
 * It only ever PROPOSES — nothing is persisted here (that is the reviewer's accept,
 * through `store.recordMemory`, where the firewall re-screens as the real gate). The
 * provider's own errors propagate to the caller, which owns how to report them.
 */
export async function proposeReviewableMemories(
  store: AsterismStore,
  agent: Agent,
  provider: ReflectionProvider,
  options: { runId?: string } = {},
): Promise<ProposeResult> {
  const target =
    options.runId !== undefined
      ? store.runs.get(agent.id, options.runId)
      : store.runs.latestWithOutput(agent.id);
  // Both paths require NON-BLANK output: `latestWithOutput` already filters on it, and
  // an explicit `runId` must meet the same bar — a run that finished with empty or
  // whitespace-only output has nothing to learn from, so the provider is never run on
  // an empty transcript.
  if (!target || target.output === undefined || target.output.trim().length === 0) {
    return { kind: "no_run" };
  }

  const transcript = { runId: target.id, input: target.input, output: target.output };
  const knownMemories = store.memories.listActiveAccepted(agent.id).map((m) => m.content);
  const raw = await provider.reflect({ agentId: agent.id, transcript, knownMemories });

  // Reflection-only types are a kernel constraint, enforced at the consumption point:
  // a non-conforming custom provider must never slip a disallowed type (e.g.
  // `episodic`) into review, since `recordMemory` would otherwise accept it.
  const usable = raw.filter((p) => isReflectionMemoryType(p.memoryType));
  const proposals = usable.map((p) => ({ ...p, findings: screenMemory(p.content).findings }));
  return { kind: "proposed", runId: target.id, proposals, ignored: raw.length - usable.length };
}

// ---------------------------------------------------------------------------
// Scheduled reflection — the unattended PROPOSER and the human-drained queue.
//
// `proposeReviewableMemories` above is the EPHEMERAL, interactive path: it computes
// proposals live and persists nothing. The helpers below are the SCHEDULED path: a
// non-interactive `reflect --propose` (driven by an operator's cron / launchd /
// systemd timer — never an in-kernel daemon) persists proposals to the `proposed`
// review queue, and the review surfaces drain that queue by transitioning each row.
//
// The crux the whole design turns on: a scheduled tick only ever PRODUCES PROPOSALS
// and PERSISTS them as inert `proposed` rows (recall + framing read only
// `active + accepted`, so a `proposed` row never shapes a run). It NEVER accepts — a
// human drains the queue later. So "nothing becomes a real memory without review"
// holds, expressed one level out: nothing becomes *active* without review.
// ---------------------------------------------------------------------------

/** How many un-reflected runs a single `reflect --propose` tick processes before stopping. */
export const DEFAULT_REFLECT_RUN_LIMIT = 25;

/** The per-run tally a `reflection.proposed` marker records (references only — counts). */
export interface ReflectionRunTally {
  /** Proposals persisted as `proposed` memories. */
  queued: number;
  /** Proposals the firewall flagged — dropped, audited, never queued. */
  withheld: number;
  /** Proposals skipped because their exact content is already proposed or accepted. */
  alreadyKnown: number;
  /** Proposals dropped for a non-reviewable type (or empty content) — nothing to learn. */
  ignored: number;
}

/** The runs a `reflect --propose` tick will reflect on next, and how many are left over. */
export interface UnreflectedRuns {
  /** Un-reflected runs-with-output, oldest-first, capped at the tick's limit. */
  runs: Run[];
  /** Un-reflected runs remaining beyond the cap (0 unless truncated). */
  pending: number;
}

/**
 * The runs a non-interactive `reflect --propose` should reflect on next: runs that
 * finished with output and have NOT been reflected before, oldest-first, capped at
 * `limit`. "Reflected before" is read from the agent's own event log — a
 * `reflection.proposed` marker tags every run a prior tick processed — so this needs no
 * new proposer state and is idempotent across ticks. `pending` reports any runs left
 * beyond the cap so the caller can surface them; the cap is never a silent truncation.
 * Scoped to the agent throughout (its own runs, its own log).
 */
export function unreflectedRuns(
  store: AsterismStore,
  agent: Agent,
  limit: number = DEFAULT_REFLECT_RUN_LIMIT,
): UnreflectedRuns {
  // Read only the marker rows (a SQL-side `type` filter), not the whole append-only log —
  // this runs on a repeating timer, so the per-tick cost must not grow with total history.
  const reflected = new Set(
    store.events
      .tail(agent.id, { type: "reflection.proposed" })
      .filter((e) => e.runId !== undefined)
      .map((e) => e.runId as string),
  );
  const candidates = store.runs.listWithOutput(agent.id).filter((r) => !reflected.has(r.id));
  return { runs: candidates.slice(0, limit), pending: Math.max(0, candidates.length - limit) };
}

/** The aggregate outcome of one `reflect --propose` tick across every run it processed. */
export interface QueueResult extends ReflectionRunTally {
  /** Run ids this tick reflected on (each got a `reflection.proposed` marker). */
  processedRuns: string[];
  /** Un-reflected runs left beyond this tick's cap (carried from {@link unreflectedRuns}). */
  pendingRuns: number;
}

/**
 * The SCHEDULED counterpart to {@link proposeReviewableMemories}: reflect on the agent's
 * un-reflected runs and PERSIST each proposal to the `proposed` review queue. For every
 * selected run it hands the transcript + already-known memories to the provider, applies
 * the reflection-only type filter, skips any proposal whose exact (trimmed) content is
 * already proposed or accepted (so re-ticks are idempotent and the queue never
 * duplicates), WITHHOLDS a firewall-flagged proposal (the unattended path has no human to
 * edit it — `recordMemory` blocks it and audits `memory.blocked`; it is dropped and
 * counted, never queued), and records a `reflection.proposed` marker per run so the next
 * tick skips it.
 *
 * It only ever writes inert `proposed` rows — it NEVER accepts. The human drains the queue
 * later via {@link acceptProposedMemory} / {@link rejectProposedMemory}. Agent-scoped
 * throughout. The provider's own errors propagate to the caller.
 */
export async function queueProposedMemories(
  store: AsterismStore,
  agent: Agent,
  provider: ReflectionProvider,
  options: { limit?: number } = {},
): Promise<QueueResult> {
  const { runs, pending } = unreflectedRuns(store, agent, options.limit);
  const result: QueueResult = {
    processedRuns: [],
    pendingRuns: pending,
    queued: 0,
    withheld: 0,
    alreadyKnown: 0,
    ignored: 0,
  };

  // The accepted memories are a stable advisory hint for the provider (a tick only adds
  // `proposed` rows, never `accepted`), so compute them once.
  const accepted = store.memories.listActiveAccepted(agent.id);
  const knownMemories = accepted.map((m) => m.content);
  // Dedup target: every content already proposed OR accepted, plus everything queued
  // earlier in THIS tick — so two runs proposing the same lesson queue it once. Built from
  // the already-fetched accepted set + a scoped `proposed` query (not a full-table scan),
  // and grown as we persist.
  const seen = new Set([
    ...accepted.map((m) => m.content.trim()),
    ...store.memories
      .list(agent.id, { reviewState: "proposed" })
      .map((m) => m.content.trim()),
  ]);

  for (const run of runs) {
    // `listWithOutput` guarantees non-blank output; narrow for the type checker.
    if (run.output === undefined) continue;
    const transcript = { runId: run.id, input: run.input, output: run.output };
    const raw = await provider.reflect({ agentId: agent.id, transcript, knownMemories });

    const tally: ReflectionRunTally = { queued: 0, withheld: 0, alreadyKnown: 0, ignored: 0 };
    for (const p of raw) {
      if (!isReflectionMemoryType(p.memoryType)) {
        tally.ignored++;
        continue;
      }
      const content = p.content.trim();
      if (content.length === 0) {
        tally.ignored++;
        continue;
      }
      if (seen.has(content)) {
        tally.alreadyKnown++;
        continue;
      }
      try {
        store.recordMemory(agent.id, {
          memoryType: p.memoryType,
          content,
          confidence: p.confidence,
          sourceRunId: p.sourceRunId,
          reviewState: "proposed",
          status: "active",
        });
        seen.add(content);
        tally.queued++;
      } catch (err) {
        // The firewall refusing a poisoned proposal is an expected per-proposal outcome:
        // `recordMemory` has already audited `memory.blocked`, so withhold and move on.
        // Any other error is a genuine storage failure, not a proposal outcome — let it
        // propagate (the run stays un-marked, so a later tick retries it idempotently).
        if (err instanceof MemoryFirewallError) {
          tally.withheld++;
          continue;
        }
        throw err;
      }
    }

    store.recordReflectionProposed(agent.id, run.id, tally);
    result.processedRuns.push(run.id);
    result.queued += tally.queued;
    result.withheld += tally.withheld;
    result.alreadyKnown += tally.alreadyKnown;
    result.ignored += tally.ignored;
  }
  return result;
}

/**
 * The outcome of draining one queued proposal — accepting it activates the memory (or
 * a re-screened edit of it), rejecting it terminates it. `not_found` means no such
 * memory for this agent; `not_proposed` means the id exists but is not in the `proposed`
 * queue (already accepted/rejected), so the surface can tell a stale action from a bad id.
 */
export type DrainResult =
  | { kind: "accepted"; memory: Memory }
  | { kind: "rejected"; memory: Memory }
  | { kind: "not_found" }
  | { kind: "not_proposed" };

/** Read back whether `id` exists at all for this agent — to tell `not_found` from a lost CAS. */
function drainMiss(store: AsterismStore, agent: Agent, id: string): DrainResult {
  return store.memories.get(agent.id, id) ? { kind: "not_proposed" } : { kind: "not_found" };
}

/**
 * Reject a queued proposal: settle `proposed → rejected` via the single-winner CAS (audited
 * `memory.reviewed`). The row stays as a rejected record; it was never active, so nothing it
 * framed changes. Agent-scoped — a cross-agent or unknown id is `not_found`; an
 * already-settled one (or a lost race against a concurrent drain) is `not_proposed`.
 */
export function rejectProposedMemory(store: AsterismStore, agent: Agent, id: string): DrainResult {
  const settled = store.settleProposedMemory(agent.id, id, "rejected");
  return settled ? { kind: "rejected", memory: settled } : drainMiss(store, agent, id);
}

/**
 * Accept a queued proposal — the human's ratification that turns an inert `proposed` row
 * into an `active + accepted` memory that frames future runs. Shared by every drain surface
 * (CLI `reflect --review`, the dashboard) so they can never drift on HOW an accept is applied.
 *
 * The memory firewall is the HARD GATE at the persistence boundary, applied on BOTH paths:
 *
 * - Unchanged: re-screen the proposal's content ({@link assertMemorySafe}) and, if it still
 *   passes, settle `proposed → accepted` via the single-winner CAS. The re-screen matters
 *   because the firewall ruleset can tighten between an unattended `--propose` and the human
 *   review — a proposal that was clean when queued but the rules now flag is blocked, not
 *   activated (it throws `MemoryFirewallError` for the caller to surface; the row stays
 *   `proposed`).
 * - Edited (`editedContent` non-blank and different): screen the NEW content up front (so a
 *   poisoned edit is refused WITHOUT touching the original — it stays in the queue), then
 *   CAS-claim the original `proposed → rejected` and record the edit as a fresh `accepted`
 *   memory. Claiming before the record is what stops two concurrent edited-accepts from
 *   yielding two accepted memories: only the CAS winner records; the loser is `not_proposed`.
 *
 * A blank or identical `editedContent` is treated as "unchanged" (the surfaces guard blank
 * edits before calling). Agent-scoped — a cross-agent or unknown id is `not_found`; an
 * already-settled one (or a lost race) is `not_proposed`.
 */
export function acceptProposedMemory(
  store: AsterismStore,
  agent: Agent,
  id: string,
  editedContent?: string,
): DrainResult {
  const current = store.memories.get(agent.id, id);
  if (!current) return { kind: "not_found" };
  if (current.reviewState !== "proposed") return { kind: "not_proposed" };

  const edited = editedContent?.trim();
  if (edited !== undefined && edited.length > 0 && edited !== current.content) {
    // Screen the edit BEFORE claiming, so a poisoned edit throws here and leaves the
    // original proposal untouched in the queue.
    assertMemorySafe(edited);
    // CAS-claim the original out of the queue first — a concurrent drain that already
    // settled it loses here, so we never record a duplicate accepted memory.
    if (!store.settleProposedMemory(agent.id, id, "rejected")) return drainMiss(store, agent, id);
    const memory = store.recordMemory(agent.id, {
      memoryType: current.memoryType,
      content: edited,
      confidence: current.confidence,
      ...(current.sourceRunId !== undefined ? { sourceRunId: current.sourceRunId } : {}),
      reviewState: "accepted",
      status: "active",
    });
    return { kind: "accepted", memory };
  }

  // Unchanged: re-screen at the persistence boundary (throws if the rules now flag it),
  // then claim it active via the CAS.
  assertMemorySafe(current.content);
  const settled = store.settleProposedMemory(agent.id, id, "accepted");
  return settled ? { kind: "accepted", memory: settled } : drainMiss(store, agent, id);
}
