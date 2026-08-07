// Memory summary — project an agent's RATIFIED memory into the curated extract that
// crosses a `read-summary` connection (Phase 3 · T2b).
//
// This is the payload of the phase's first PULL. Every mode before it ran the callee and
// projected the result; here the callee runs NOTHING, and what crosses is a view of memory
// it already holds. So this module is the whole boundary: what it emits is exactly what the
// caller sees of another agent's mind.
//
// WHY DETERMINISTIC, AND WHY NO PROVIDER SEAM (design note §13, decision D16). The obvious
// objection is that filtering and concatenating is not "curation" and still ships raw rows.
// The answer is that the curation here is STRUCTURAL, not stylistic — projection, selection,
// bounding, screening, aggregation (see `curateMemorySummary`) — and that a model on this
// path could not be made safe by the means the rest of the kernel relies on:
//
//   1. NOTHING COULD RE-IMPOSE THE KERNEL'S GUARANTEES. `enforceRecall` makes an injectable
//      ranker safe by dropping anything outside the kernel-resolved candidate set and
//      framing the KERNEL's own objects; `ReflectionProvider` output is safe because it is
//      `proposed` and a human ratifies it. A summarizer's output is new free text, so there
//      is no `enforceSummary` that can establish the model did not invent a belief the
//      callee never held — and nothing ratifies it, because it goes straight to the caller.
//      A generated summary would be a FABRICATION CHANNEL across the isolation boundary.
//   2. IT WOULD BE A DESTRUCTIVE ACTION BY OUR OWN CLASSIFICATION — an outbound network call
//      carrying private content, triggered by ANOTHER agent, on a read the callee did not
//      initiate (and unattended once T5 makes the caller an agent).
//   3. AN AUDITED CROSSING SHOULD BE REPRODUCIBLE. `handoff` crosses the run's own output;
//      `artifact-only` projects the observation stream. Both are derived from something
//      recorded. This one is a pure function of (eligible memories, focus, budget) — no
//      clock, no I/O, no randomness — so what crossed can be re-derived from what the callee
//      holds, which is what the both-logs audit exists to support. That is also why no
//      reference time is taken for recency: two pulls a second apart would otherwise be able
//      to differ at the budget's edge, for a signal the memory set itself already carries.
//
// Pure: no store, no clock, no I/O. The same discipline as `artifact-manifest.ts` and
// `world-fact-harvest.ts` — a projection of state it does not own.

import { redactForTrace } from "./redaction.js";
import { selectRecall } from "./recall.js";
import type { Memory, MemoryType } from "./types.js";

/**
 * One piece of what the callee knows — a PROJECTION, never a {@link Memory} row.
 *
 * The exclusions are the invariant, and they are enforced by this type having nowhere to put
 * them (the T2a discipline: a mode that withholds something should be unable to carry it).
 * Absent, deliberately: `id` and `sourceRunId` (handles into the callee's own store and
 * runs), `confidence` (the callee's internal calibration), `createdAt`, `status` and
 * `reviewState` (the record's own bookkeeping, and the review pile is no business of the
 * caller's — the same line T2a drew when it kept the harvest summary from crossing).
 *
 * What remains is the knowledge: what KIND of thing it is, and a screened rendering of it.
 */
export interface MemorySummaryItem {
  /** What kind of knowledge this is — an enum, not a handle. */
  memoryType: MemoryType;
  /** The screened content. Never the stored row's content verbatim unless it needed nothing. */
  content: string;
  /**
   * Set when the kernel's redaction boundary CHANGED this content — a secret-shaped value
   * scrubbed, a control character stripped, an over-long memory truncated.
   *
   * Compared as a whole rather than by reading the redaction summary's individual counters,
   * so every present and future rule is caught by one test. (The same construction as
   * `ArtifactRef.redacted`, which a review round established the hard way.) Present only
   * when it happened, so an unscreened item carries no field at all.
   */
  screened?: true;
}

/** What bounds a single crossing: how many items, and how much of each. */
export interface MemorySummaryBudget {
  /** The maximum number of items in one summary. */
  maxItems: number;
  /** The maximum bytes of any one item's content, before screening markers. */
  maxContentBytes: number;
}

/**
 * The default bounds for one `read-summary` crossing.
 *
 * Its own constant rather than a reuse of {@link DEFAULT_RECALL_BUDGET}: recall's budget
 * governs how much of an agent's memory frames ITS OWN run, and a change made for prompt-size
 * reasons must never silently change how much of one agent crosses to another.
 *
 * What the item cap is FOR is bounding a single crossing — it is not a confidentiality
 * control, and the design note says so plainly (D17). A caller holding a `read-summary`
 * connection may re-ask on different topics and eventually see the whole eligible set; that
 * is within the grant, since exposing ratified memory is the channel's entire purpose.
 *
 * Frozen: a shared module constant the kernel must never let anything mutate, mirroring
 * {@link DEFAULT_RECALL_BUDGET}.
 */
export const DEFAULT_SUMMARY_BUDGET: MemorySummaryBudget = Object.freeze({
  maxItems: 20,
  maxContentBytes: 1024,
});

/**
 * The curated extract that crosses a `read-summary` connection.
 *
 * The counts are what keep a bounded summary honest: a caller can always tell that it is
 * looking at part of something, and how much was held back and why. They are counts ONLY —
 * a scalar about the callee, never a window into it.
 */
export interface MemorySummary {
  /** The focus the caller asked about, echoed back. Absent for an unfocused pull. */
  focus?: string;
  /** How many of the callee's memories were ELIGIBLE — its active + accepted set. */
  eligible: number;
  /** How many items actually crossed. */
  included: number;
  /**
   * How many eligible memories the SCREEN excluded (never how many the budget did — that is
   * `eligible - included - withheld`). Split out because the two mean different things: one
   * is a bound, the other is a refusal.
   */
  withheld: number;
  /** The projected, screened knowledge, in the callee's own chronological order. */
  items: readonly MemorySummaryItem[];
}

/** What {@link curateMemorySummary} may be told. Both optional; neither is a clock. */
export interface MemorySummaryOptions {
  /** A free-form topic to rank against. Absent ⇒ the eligible set in store order. */
  focus?: string;
  /** Bounds for this crossing. Defaults to {@link DEFAULT_SUMMARY_BUDGET}. */
  budget?: MemorySummaryBudget;
}

/**
 * One screened candidate: the projected item, plus the memory id used to map a ranking back.
 */
interface ScreenedCandidate {
  id: string;
  item: MemorySummaryItem;
  /** The candidate as the ranker should see it — screened content, so ranking matches output. */
  ranked: Memory;
}

/**
 * Screen one memory for crossing, or refuse it.
 *
 * This is decision D18, and it is the sharpest rule in the mode: the screen both SCRUBS and
 * EXCLUDES, on different grounds, because `redactForTrace`'s categories mean different things
 * at an outbound boundary.
 *
 *   - A SECRET-VALUE hit is scrubbed and the item still crosses. The value is already gone
 *     and the surrounding knowledge is still true and still useful ("the deploy token lives
 *     in 1Password, not the repo" survives its own example token being removed). Dropping the
 *     item would delete ratified knowledge to protect a value that is no longer there.
 *   - An INJECTION- or EXFILTRATION-PHRASING hit WITHHOLDS the whole item. Under T5 this text
 *     lands in another agent's context; neutralising the span leaves the rest of a sentence
 *     that was shaped to manipulate a reader. This is the one place in the mode where the
 *     firewall's *block* semantics are right — reached through the same rule set that
 *     `redactForTrace` already ran, not through `screenMemory`, which is an inbound
 *     block/allow verdict on the memory-WRITE path and not an outbound screen.
 *
 * Truncation runs FIRST inside `redactForTrace` (its stage 1), so phrasing past
 * `maxContentBytes` is cut before the rules ever see it. That is safe rather than a hole: the
 * bytes it would have matched do not cross either.
 *
 * A memory that screens down to nothing (all-whitespace, or stripped entirely by the control
 * character rules) is withheld too — an empty item is not knowledge, and emitting one would
 * make `included` overstate what the caller received.
 */
function screenMemoryContent(
  memory: Memory,
  maxContentBytes: number,
): MemorySummaryItem | undefined {
  const { content, summary } = redactForTrace(memory.content, { maxBytes: maxContentBytes });
  if (summary.injectionRedacted > 0 || summary.exfiltrationRedacted > 0) return undefined;
  if (content.trim() === "") return undefined;
  const screened = content !== memory.content;
  return {
    memoryType: memory.memoryType,
    content,
    ...(screened ? { screened: true as const } : {}),
  };
}

/**
 * Project a callee's ELIGIBLE memories into the summary that crosses to the caller.
 *
 * `candidates` must already be the callee's `active` + `accepted` set — the kernel resolves
 * them scoped (`memories.listActiveAccepted`), exactly as it resolves recall's candidates, so
 * this function physically cannot reach another agent's rows or an unratified one. Only what
 * the operator ratified is eligible to cross; that constraint lives at the call site because
 * it is a query, and is asserted there.
 *
 * The five curation steps, in order — this is what "curated, never raw rows" means
 * mechanically:
 *
 *   1. SCREEN every candidate, and drop the ones the screen refuses (see
 *      {@link screenMemoryContent}). Screening happens BEFORE selection so the budget bounds
 *      what CROSSES rather than what was considered — otherwise a withheld item would
 *      silently consume a slot and shorten the summary for no reason the caller can see.
 *   2. PROJECT each survivor to kind + content, dropping every row field
 *      ({@link MemorySummaryItem}).
 *   3. SELECT within the survivors: with a `focus`, by relevance through `selectRecall` — the
 *      same deterministic ranker the install already trusts to decide which memories frame a
 *      run, called as the pure function it is rather than through the injectable
 *      `RecallProvider` seam (there is no provider here to distrust; see D16). Ranking reads
 *      the SCREENED content, so what was ranked is what the caller reads. Without a focus,
 *      store order, truncated to the cap.
 *   4. BOUND to `budget.maxItems`.
 *   5. AGGREGATE the counts, so a partial summary says that it is partial.
 *
 * Under the cap `selectRecall` returns its candidates unchanged, so a focused pull over a
 * small memory set returns everything eligible in chronological order. That is the same
 * behaviour recall has when framing a run, and it is the honest one: the focus is a selector
 * under a budget, not a filter that hides what fits.
 *
 * Pure and total: no candidates yields a zeroed summary with no items.
 */
export function curateMemorySummary(
  candidates: readonly Memory[],
  options: MemorySummaryOptions = {},
): MemorySummary {
  const budget = options.budget ?? DEFAULT_SUMMARY_BUDGET;
  const focus = options.focus?.trim();
  const eligible = candidates.length;

  // 1 + 2. Screen and project. `withheld` counts only what the SCREEN refused.
  const screened: ScreenedCandidate[] = [];
  let withheld = 0;
  for (const memory of candidates) {
    const item = screenMemoryContent(memory, budget.maxContentBytes);
    if (item === undefined) {
      withheld += 1;
      continue;
    }
    // The ranker sees the screened text, so relevance is scored against what will actually
    // cross. Every other field is carried through untouched — the ranker's own signals
    // (confidence, type, creation time) are the callee's internal state and are used HERE,
    // inside the callee's own boundary, without any of them crossing.
    screened.push({ id: memory.id, item, ranked: { ...memory, content: item.content } });
  }

  // 3 + 4. Select and bound.
  const max = budget.maxItems;
  let chosen: readonly ScreenedCandidate[];
  if (max <= 0) {
    chosen = [];
  } else if (focus === undefined || focus === "") {
    chosen = screened.slice(0, max);
  } else {
    const byId = new Map(screened.map((c) => [c.id, c]));
    // No reference time: recency deliberately contributes nothing, so the crossing is
    // reproducible from the memory set alone (D16, argument 3).
    const ranked = selectRecall({
      // Every candidate belongs to the callee; the ranker never reads the store, so this is
      // a label for the input, not an authorization.
      agentId: candidates[0]?.agentId ?? "",
      query: focus,
      candidates: screened.map((c) => c.ranked),
      budget: { maxMemories: max },
    });
    chosen = ranked.flatMap((m) => {
      const candidate = byId.get(m.id);
      // The ranker is the kernel's own pure function, so this cannot miss today. Guarded
      // anyway: the alternative to skipping an unknown id is emitting a `Memory` the mapping
      // did not produce, which is the one thing this boundary must never do.
      return candidate ? [candidate] : [];
    });
  }

  const items = chosen.map((c) => c.item);
  return {
    ...(focus !== undefined && focus !== "" ? { focus } : {}),
    eligible,
    included: items.length,
    withheld,
    items,
  };
}
