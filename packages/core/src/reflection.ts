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

import type { Agent, Memory, MemoryType, Objective, Run, TransitionStatus } from "./types.js";
import { isTransitionStatus } from "./types.js";
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
 * A single proposed standing objective — the objective analogue of {@link ProposedMemory},
 * minus `memoryType` (objectives have no type). A provider produces these from a run
 * transcript ("you keep doing X — make it standing?"); it never persists them. `confidence`
 * is the provider's own estimate in [0, 1]; `sourceRunId` ties the proposal back to the run
 * it was noticed in.
 */
export interface ProposedObjective {
  content: string;
  confidence: number;
  sourceRunId: string;
}

/**
 * An existing objective handed to the provider so it can judge whether a run finished it. Carries
 * the `id` (the model refers back to ONE objective by it) and the `content` (what the objective is).
 * Distinct from {@link ReflectionInput.knownMemories}, which is `string[]` and cannot carry an id.
 */
export interface ObjectiveRef {
  id: string;
  content: string;
}

/** What the kernel hands a provider's optional {@link ReflectionProvider.proposeObjectiveTransitions}. */
export interface ObjectiveTransitionInput {
  /** The agent whose runs these were — every suggestion is scoped to it. */
  agentId: string;
  /**
   * The recent runs to judge the objectives against, newest-first. More than one so a batched
   * `reflect --propose` that finished an objective in an OLDER run is still caught at review time,
   * not just the single latest run.
   */
  transcripts: readonly RunTranscript[];
  /** The agent's ACTIVE + ACCEPTED objectives (the only transition candidates), WITH their ids. */
  objectives: readonly ObjectiveRef[];
}

/**
 * A single proposed objective STATUS TRANSITION — "this objective looks done/dropped". The Type-B
 * objective proposal: it names an EXISTING objective by id and the non-`active` status the run
 * suggests it has reached. A provider produces these; it never persists or applies them — applying
 * is the human's explicit, audited `setObjectiveStatus`. The kernel re-validates `objectiveId`
 * against the agent's OWN active objectives (untrusted provider output), so a hallucinated or
 * cross-agent id never reaches the operator. `confidence` is the provider's estimate in [0, 1].
 */
export interface ProposedTransition {
  objectiveId: string;
  proposedStatus: TransitionStatus;
  confidence: number;
}

/**
 * Turns a run transcript into PROPOSED writes — typed memories, and (optionally) standing
 * objectives. The default implementation drives a hosted model and lives in
 * `@qmilab/asterism-reflect`; core depends on no model client, mirroring the RuntimeAdapter
 * seam. Every method returns a read-only list so a caller can never mistake the result for a
 * writable store.
 */
export interface ReflectionProvider {
  reflect(input: ReflectionInput): Promise<readonly ProposedMemory[]>;
  /**
   * Propose NEW standing objectives the run suggests are worth carrying forward. OPTIONAL:
   * a memory-only provider may omit it, and the kernel then proposes no objectives (graceful
   * degradation, the replaceable-substrate discipline). When present, the shared
   * {@link ReflectionInput.knownMemories} field carries the agent's already-held OBJECTIVE
   * contents (the advisory dedup hint for this call), not its memories.
   */
  proposeObjectives?(input: ReflectionInput): Promise<readonly ProposedObjective[]>;
  /**
   * Propose STATUS TRANSITIONS on the agent's EXISTING objectives the run suggests are finished
   * ("you completed objective X — mark it done?"). OPTIONAL: a provider that omits it yields no
   * transition suggestions (graceful degradation, the replaceable-substrate discipline). Unlike
   * `reflect`/`proposeObjectives`, this takes {@link ObjectiveTransitionInput} — the candidate
   * objectives WITH ids — because a transition names one existing objective. The result is advisory
   * only: nothing is persisted or applied here; the human applies via `setObjectiveStatus`.
   */
  proposeObjectiveTransitions?(
    input: ObjectiveTransitionInput,
  ): Promise<readonly ProposedTransition[]>;
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

/**
 * A proposed objective readied for human review: the provider's proposal plus the memory
 * firewall's findings on its content (empty when it screens clean). The objective analogue of
 * {@link ReviewableProposal}; the findings are advisory (the hard gate is the firewall
 * re-screen at persistence), shown so the reviewer sees WHAT tripped a rule.
 */
export interface ReviewableObjectiveProposal extends ProposedObjective {
  findings: readonly FirewallFinding[];
}

/**
 * The outcome of {@link proposeReviewableObjectives} — the objective analogue of
 * {@link ProposeResult}: `proposed` (a reflectable run was found and the provider returned
 * proposals, possibly empty) or `no_run` (no completed run with output to reflect on).
 */
export type ProposeObjectivesResult =
  | { kind: "proposed"; runId: string; proposals: ReviewableObjectiveProposal[] }
  | { kind: "no_run" };

/**
 * The objective analogue of {@link proposeReviewableMemories}: the EPHEMERAL, interactive
 * live path. It selects the same run (a given `runId`, or the agent's latest run with output),
 * hands the transcript and the agent's already-held OBJECTIVES (the dedup hint) to the
 * provider's optional `proposeObjectives`, then screens each proposal for display. It only
 * ever PROPOSES — nothing is persisted (that is the reviewer's accept, where the firewall
 * re-screens as the real gate). A provider with no `proposeObjectives` yields zero proposals.
 */
export async function proposeReviewableObjectives(
  store: AsterismStore,
  agent: Agent,
  provider: ReflectionProvider,
  options: { runId?: string } = {},
): Promise<ProposeObjectivesResult> {
  const target =
    options.runId !== undefined
      ? store.runs.get(agent.id, options.runId)
      : store.runs.latestWithOutput(agent.id);
  if (!target || target.output === undefined || target.output.trim().length === 0) {
    return { kind: "no_run" };
  }
  if (!provider.proposeObjectives) {
    return { kind: "proposed", runId: target.id, proposals: [] };
  }

  const transcript = { runId: target.id, input: target.input, output: target.output };
  const knownObjectives = store.objectives.listActiveAccepted(agent.id).map((o) => o.content);
  const raw = await provider.proposeObjectives({
    agentId: agent.id,
    transcript,
    knownMemories: knownObjectives,
  });
  const proposals = raw
    .filter((p) => p.content.trim().length > 0)
    .map((p) => ({ ...p, findings: screenMemory(p.content).findings }));
  return { kind: "proposed", runId: target.id, proposals };
}

/**
 * One suggested objective transition readied for the operator: the validated proposal resolved to
 * the agent's OWN objective row (so the surface can render its content + id) plus the suggested
 * status and the provider's confidence. The Type-B analogue of {@link ReviewableObjectiveProposal},
 * minus a firewall `findings` — a transition introduces NO new content into framing (it flips a
 * status on an already-screened, already-accepted objective), so there is nothing to screen.
 */
export interface TransitionAdvisory {
  objective: Objective;
  proposedStatus: TransitionStatus;
  confidence: number;
}

/**
 * The outcome of {@link proposeObjectiveTransitions}: `proposed` (at least one judgeable run was
 * found; `advisories` may be empty when nothing looks finished, the agent has no active objectives,
 * or the provider omits the method) or `no_run` (no completed run with output to judge against).
 */
export type TransitionAdvisoryResult =
  | { kind: "proposed"; advisories: TransitionAdvisory[] }
  | { kind: "no_run" };

/**
 * The Type-B advisory path: compute which of the agent's ACTIVE objectives recent runs look to have
 * FINISHED, for an interactive reviewer to apply or skip. Deliberately the LIGHTEST shape — it
 * PERSISTS NOTHING and FRAMES NOTHING: it returns suggestions, and the only state change is the
 * human's explicit, audited {@link AsterismStore.setObjectiveStatus} at the surface.
 *
 * It judges the agent's latest run with output PLUS any runs named in `options.runIds` (the drain
 * surface passes the source runs of the proposals it is reviewing, so a batched `reflect --propose`
 * that finished an objective in an OLDER run is caught too, not only the single latest run). The
 * runs are deduped, blank-output ones dropped, sorted newest-first and bounded; their transcripts go
 * to the provider in ONE call. The candidate objectives are the agent's ACTIVE + ACCEPTED ones — the
 * same set framing uses, and the authority the provider's UNTRUSTED output is validated against:
 * exactly as recall re-enforces its provider, a returned transition is kept only when its
 * `objectiveId` is one of THIS agent's own active objectives AND its status is a real
 * {@link TransitionStatus}; a hallucinated/cross-agent/no-longer-active id or an illegal status is
 * dropped before it ever reaches the operator. At most one suggestion survives per objective: an
 * identical duplicate collapses to one, and a CONFLICTING duplicate (the same objective with a
 * different status) is dropped ENTIRELY — for untrusted output the outcome never depends on the
 * model's response order. No firewall screen: a transition adds no framable content. A provider with
 * no `proposeObjectiveTransitions`, or an agent with no active objectives, yields an empty advisory
 * list (not an error).
 */
export async function proposeObjectiveTransitions(
  store: AsterismStore,
  agent: Agent,
  provider: ReflectionProvider,
  options: { runIds?: readonly string[] } = {},
): Promise<TransitionAdvisoryResult> {
  // The runs this check judges: the latest run with output (the manual run→review case) plus any
  // explicitly named runs (the drain path passes the queued proposals' source runs). Deduped.
  const ids = new Set<string>(options.runIds ?? []);
  const latest = store.runs.latestWithOutput(agent.id);
  if (latest) ids.add(latest.id);

  const runs = [...ids]
    .map((id) => store.runs.get(agent.id, id))
    .filter((r): r is Run => !!r && r.output !== undefined && r.output.trim().length > 0)
    // Newest-first, then bounded — an unbounded batch could otherwise grow the prompt without limit.
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, DEFAULT_REFLECT_RUN_LIMIT);
  if (runs.length === 0) return { kind: "no_run" };

  // The candidate set is the agent's OWN active + accepted objectives — a done/dropped/proposed
  // objective is not a thing to "complete", so it is never a candidate.
  const active = store.objectives.listActiveAccepted(agent.id);
  if (active.length === 0 || !provider.proposeObjectiveTransitions) {
    return { kind: "proposed", advisories: [] };
  }

  const transcripts = runs.map((r) => ({ runId: r.id, input: r.input, output: r.output ?? "" }));
  const raw = await provider.proposeObjectiveTransitions({
    agentId: agent.id,
    transcripts,
    objectives: active.map((o) => ({ id: o.id, content: o.content })),
  });

  // Re-enforce untrusted provider output: keep a suggestion only for one of THIS agent's active
  // objectives with a legal target status, and AT MOST ONE per objective. Identical duplicates
  // collapse to one; a CONFLICTING duplicate (the same objective with a DIFFERENT status) is
  // dropped ENTIRELY — for untrusted output we refuse to guess `done` vs `dropped` by response
  // order, rather than silently keeping whichever the model happened to emit first.
  const byId = new Map(active.map((o) => [o.id, o]));
  const grouped = new Map<string, { objective: Objective; first: TransitionStatus; confidence: number; conflict: boolean }>();
  for (const t of raw) {
    const objective = byId.get(t.objectiveId);
    if (!objective || !isTransitionStatus(t.proposedStatus)) continue;
    const existing = grouped.get(objective.id);
    if (!existing) {
      grouped.set(objective.id, { objective, first: t.proposedStatus, confidence: t.confidence, conflict: false });
    } else if (existing.first !== t.proposedStatus) {
      existing.conflict = true; // a second, DIFFERENT status — refuse to guess; drop the objective
    }
    // an identical-status repeat is harmless and ignored.
  }
  const advisories: TransitionAdvisory[] = [];
  for (const g of grouped.values()) {
    if (g.conflict) continue;
    advisories.push({ objective: g.objective, proposedStatus: g.first, confidence: g.confidence });
  }
  return { kind: "proposed", advisories };
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
 * finished with output and have NOT been reflected before (`reflected_at IS NULL`),
 * oldest-first, capped at `limit`. The per-run `reflected_at` claim (see
 * {@link AsterismStore.claimRunForReflection}) is the durable marker, so this is
 * idempotent across sequential ticks and single-flight across overlapping ones — and a
 * single indexed read, so the per-tick cost does not grow with total history. `pending`
 * reports any runs left beyond the cap so the caller can surface them; the cap is never a
 * silent truncation. Scoped to the agent throughout (its own runs only).
 */
export function unreflectedRuns(
  store: AsterismStore,
  agent: Agent,
  limit: number = DEFAULT_REFLECT_RUN_LIMIT,
): UnreflectedRuns {
  const candidates = store.runs.unreflected(agent.id);
  return { runs: candidates.slice(0, limit), pending: Math.max(0, candidates.length - limit) };
}

/**
 * The aggregate outcome of one `reflect --propose` tick across every run it processed. The
 * flat counts are the MEMORY tally (unchanged for back-compat); `objectives` is the parallel
 * objective-proposal tally the same tick produced.
 */
export interface QueueResult extends ReflectionRunTally {
  /** Run ids this tick reflected on (each got a `reflection.proposed` marker). */
  processedRuns: string[];
  /** Un-reflected runs left beyond this tick's cap (carried from {@link unreflectedRuns}). */
  pendingRuns: number;
  /** The per-tick objective-proposal tally (the objective analogue of the flat memory counts). */
  objectives: ReflectionRunTally;
}

/**
 * Persist one run's batch of proposals (memory or objective) to the `proposed` queue, applying
 * the shared per-proposal policy and returning the tally. `normalize` returns the trimmed,
 * persistable content or `null` for an `ignored` proposal (a non-reviewable type, or empty
 * content); `persist` writes one `proposed` row and may throw {@link MemoryFirewallError} for a
 * poisoned proposal (already audited by the store) — which is WITHHELD, not fatal. The exact
 * (trimmed) content is skipped when already in `seen` (proposed∪accepted, grown as we persist so
 * two identical proposals in one batch queue once). The shared core of both the memory and the
 * objective queue paths, so they can never drift on dedup / withhold / ignore accounting.
 */
function queueProposalBatch<P>(
  raw: readonly P[],
  seen: Set<string>,
  normalize: (p: P) => string | null,
  persist: (content: string, p: P) => void,
): ReflectionRunTally {
  const tally: ReflectionRunTally = { queued: 0, withheld: 0, alreadyKnown: 0, ignored: 0 };
  for (const p of raw) {
    const content = normalize(p);
    if (content === null) {
      tally.ignored++;
      continue;
    }
    if (seen.has(content)) {
      tally.alreadyKnown++;
      continue;
    }
    try {
      persist(content, p);
      seen.add(content);
      tally.queued++;
    } catch (err) {
      // A firewall refusal is an expected per-proposal outcome: the store has already audited
      // the block (`memory.blocked` / `objective.blocked`), so withhold and move on. Any other
      // error is a genuine storage failure — rethrown to the run-level catch.
      if (err instanceof MemoryFirewallError) {
        tally.withheld++;
        continue;
      }
      throw err;
    }
  }
  return tally;
}

/**
 * The SCHEDULED counterpart to {@link proposeReviewableMemories} / {@link proposeReviewableObjectives}:
 * reflect on the agent's un-reflected runs and PERSIST each proposal — both memories AND standing
 * objectives — to the `proposed` review queue. Reflection is ONE act per run: a single
 * `reflected_at` claim covers both kinds, so "this run has been reflected" stays one fact and the
 * two proposal sets can never diverge on which runs they have seen.
 *
 * For every selected run it hands the transcript to the provider (memories via `reflect`,
 * objectives via the optional `proposeObjectives` — absent ⇒ no objective proposals), skips any
 * proposal whose exact (trimmed) content is already proposed or accepted (so re-ticks are
 * idempotent and the queue never duplicates), WITHHOLDS a firewall-flagged proposal (the
 * unattended path has no human to edit it — the store blocks it and audits the refusal; it is
 * dropped and counted, never queued), and records a `reflection.proposed` (memory) and, when
 * objectives were attempted, an `objective.proposed` (objective) marker per run.
 *
 * It only ever writes inert `proposed` rows — it NEVER accepts. The human drains the queue later
 * via {@link acceptProposedMemory} / {@link acceptProposedObjective} (and their reject siblings).
 * Both model calls happen BEFORE the claim, so a model failure leaves the run UNCLAIMED and
 * retryable; the re-read dedup set makes the retry idempotent. Agent-scoped throughout; the
 * provider's own errors propagate to the caller.
 */
export async function queueProposals(
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
    objectives: { queued: 0, withheld: 0, alreadyKnown: 0, ignored: 0 },
  };

  // Stable advisory hints for the provider — a start snapshot is fine (they only help the model
  // avoid re-proposing known content; the real dedup is `seen`, re-read per run below).
  const knownMemories = store.memories.listActiveAccepted(agent.id).map((m) => m.content);
  const knownObjectives = store.objectives.listActiveAccepted(agent.id).map((o) => o.content);

  for (const run of runs) {
    // `unreflected` guarantees non-blank output; narrow for the type checker.
    if (run.output === undefined) continue;
    const transcript = { runId: run.id, input: run.input, output: run.output };
    // Call BOTH models FIRST, then claim. A model failure (or a process death) therefore leaves
    // the run UNCLAIMED and retryable on the next tick — nothing is lost.
    const rawMemories = await provider.reflect({ agentId: agent.id, transcript, knownMemories });
    const rawObjectives = provider.proposeObjectives
      ? await provider.proposeObjectives({ agentId: agent.id, transcript, knownMemories: knownObjectives })
      : undefined;

    // CLAIM the run before persisting. A concurrent `reflect --propose` that already processed
    // this run wins the claim; we lose it and DISCARD our (now-duplicate) proposals, so the same
    // run is never double-queued. Single-flight without an external lock.
    if (!store.claimRunForReflection(agent.id, run.id)) continue;

    try {
      // Re-read each dedup set AFTER claiming, so it reflects anything a concurrent proposer or
      // drain committed while we were on the model. Exact-content skip against proposed∪accepted.
      const memSeen = new Set([
        ...store.memories.listActiveAccepted(agent.id).map((m) => m.content.trim()),
        ...store.memories.list(agent.id, { reviewState: "proposed" }).map((m) => m.content.trim()),
      ]);
      const memTally = queueProposalBatch(
        rawMemories,
        memSeen,
        (p) => {
          if (!isReflectionMemoryType(p.memoryType)) return null;
          const content = p.content.trim();
          return content.length === 0 ? null : content;
        },
        (content, p) =>
          store.recordMemory(agent.id, {
            memoryType: p.memoryType,
            content,
            confidence: p.confidence,
            sourceRunId: p.sourceRunId,
            reviewState: "proposed",
            status: "active",
          }),
      );
      store.recordReflectionProposed(agent.id, run.id, memTally);
      result.queued += memTally.queued;
      result.withheld += memTally.withheld;
      result.alreadyKnown += memTally.alreadyKnown;
      result.ignored += memTally.ignored;

      // Objective proposals — only when the provider attempted them (a memory-only provider
      // skips this block entirely, so no misleading `objective.proposed` marker is recorded).
      if (rawObjectives !== undefined) {
        const objSeen = new Set([
          ...store.objectives.listActiveAccepted(agent.id).map((o) => o.content.trim()),
          ...store.objectives.list(agent.id, { reviewState: "proposed" }).map((o) => o.content.trim()),
        ]);
        const objTally = queueProposalBatch(
          rawObjectives,
          objSeen,
          (p) => {
            const content = p.content.trim();
            return content.length === 0 ? null : content;
          },
          (content, p) => store.createObjective(agent.id, content, "proposed", p.sourceRunId),
        );
        store.recordObjectiveProposed(agent.id, run.id, objTally);
        result.objectives.queued += objTally.queued;
        result.objectives.withheld += objTally.withheld;
        result.objectives.alreadyKnown += objTally.alreadyKnown;
        result.objectives.ignored += objTally.ignored;
      }

      result.processedRuns.push(run.id);
    } catch (err) {
      // A storage failure AFTER the claim — release the claim so the run is retried rather
      // than stranded as reflected-but-empty, then propagate (one failure ends the tick).
      store.releaseRunReflection(agent.id, run.id);
      throw err;
    }
  }
  return result;
}

/**
 * @deprecated Renamed to {@link queueProposals}, kept as a backward-compatible alias for
 * embedders that imported the old name. The behaviour broadened: a tick now also queues
 * standing-objective proposals when the provider implements `proposeObjectives`. This is
 * purely additive for existing callers — a memory-only provider behaves exactly as before,
 * and the extra `objectives` field on the {@link QueueResult} is new, not a change to the
 * memory counts. Prefer `queueProposals` in new code.
 */
export const queueProposedMemories = queueProposals;

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
    // Screen the edit BEFORE the write, so a poisoned edit throws here and leaves the
    // original proposal untouched in the queue. The store then claims the original and
    // records the edit ATOMICALLY (one transaction) — claiming first stops two concurrent
    // edited-accepts from both recording, and the atomicity stops a storage failure from
    // leaving the original rejected with the edit lost.
    assertMemorySafe(edited);
    const memory = store.acceptEditedProposal(agent.id, current, edited);
    return memory ? { kind: "accepted", memory } : drainMiss(store, agent, id);
  }

  // Unchanged: re-screen at the persistence boundary (throws if the rules now flag it),
  // then claim it active via the CAS.
  assertMemorySafe(current.content);
  const settled = store.settleProposedMemory(agent.id, id, "accepted");
  return settled ? { kind: "accepted", memory: settled } : drainMiss(store, agent, id);
}

// ---------------------------------------------------------------------------
// Objective drain — the byte-for-byte parallel of the memory drain above, for
// reflection-PROPOSED standing objectives.
// ---------------------------------------------------------------------------

/**
 * The objective analogue of {@link DrainResult}: accepting a queued objective proposal
 * activates it (or a re-screened edit of it) so it frames runs; rejecting it terminates it.
 * `not_found` means no such objective for this agent; `not_proposed` means the id exists but
 * is not in the `proposed` queue (already accepted/rejected).
 */
export type ObjectiveDrainResult =
  | { kind: "accepted"; objective: Objective }
  | { kind: "rejected"; objective: Objective }
  | { kind: "not_found" }
  | { kind: "not_proposed" };

/** Read back whether `id` exists at all for this agent — to tell `not_found` from a lost CAS. */
function objectiveDrainMiss(store: AsterismStore, agent: Agent, id: string): ObjectiveDrainResult {
  return store.objectives.get(agent.id, id) ? { kind: "not_proposed" } : { kind: "not_found" };
}

/**
 * Reject a queued objective proposal: settle `proposed → rejected` via the single-winner CAS
 * (audited `objective.reviewed`). The row stays as a rejected record; it never framed a run, so
 * nothing changes. Agent-scoped — a cross-agent or unknown id is `not_found`; an already-settled
 * one (or a lost race) is `not_proposed`. The objective analogue of {@link rejectProposedMemory}.
 */
export function rejectProposedObjective(
  store: AsterismStore,
  agent: Agent,
  id: string,
): ObjectiveDrainResult {
  const settled = store.settleProposedObjective(agent.id, id, "rejected");
  return settled ? { kind: "rejected", objective: settled } : objectiveDrainMiss(store, agent, id);
}

/**
 * Accept a queued objective proposal — the human's ratification that turns an inert `proposed`
 * objective into an `active + accepted` one that frames future runs. The objective analogue of
 * {@link acceptProposedMemory}, with the same hard-gate firewall discipline on both paths:
 *
 * - Unchanged: re-screen the content ({@link assertMemorySafe}) and, if it still passes, settle
 *   `proposed → accepted` via the single-winner CAS (the re-screen catches a ruleset that
 *   tightened since the proposal was queued).
 * - Edited (`editedContent` non-blank and different): screen the NEW content up front (so a
 *   poisoned edit is refused WITHOUT touching the original), then atomically CAS-claim the
 *   original `proposed → rejected` and record the edit as a fresh `accepted` objective.
 *
 * A blank or identical `editedContent` is treated as "unchanged" (surfaces guard blank edits
 * before calling). Agent-scoped — a cross-agent or unknown id is `not_found`; an already-settled
 * one (or a lost race) is `not_proposed`.
 */
export function acceptProposedObjective(
  store: AsterismStore,
  agent: Agent,
  id: string,
  editedContent?: string,
): ObjectiveDrainResult {
  const current = store.objectives.get(agent.id, id);
  if (!current) return { kind: "not_found" };
  if (current.reviewState !== "proposed") return { kind: "not_proposed" };

  const edited = editedContent?.trim();
  if (edited !== undefined && edited.length > 0 && edited !== current.content) {
    assertMemorySafe(edited);
    const objective = store.acceptEditedObjectiveProposal(agent.id, current, edited);
    return objective ? { kind: "accepted", objective } : objectiveDrainMiss(store, agent, id);
  }

  assertMemorySafe(current.content);
  const settled = store.settleProposedObjective(agent.id, id, "accepted");
  return settled ? { kind: "accepted", objective: settled } : objectiveDrainMiss(store, agent, id);
}
