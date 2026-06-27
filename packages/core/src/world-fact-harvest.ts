// World-fact harvest — turn a run's STATE-CHANGING tool observations into proposed
// working-note candidates (#84 T3).
//
// A run's tools emit structured observations (the §2 `ToolObservation` seam): facts the
// tool KNOWS it established (`file:notes/todo.md size_bytes = 412`, `dir:dist exists =
// false`). This module is the deterministic, dependency-free reducer that maps the
// observations a run actually produced into a small set of `(subject, value)` candidates
// the kernel proposes as working notes for the operator to review (#86's proposed →
// accepted/rejected path). Pure: no store, no clock, no I/O — so it is trivially testable
// and replay-stable.
//
// Two deliberate choices (settled with the operator; see
// internal/design/richer-tool-observations.md §13):
//   1. LIVE at end-of-run, not reflect-time and NOT from the opt-in Lodestar trace — the
//      kernel gate already sees every observation, so the harvest stays on-by-default and
//      coupling-free. The collection happens in `run.ts` (the `onObservation` hook); this
//      module is the pure reduction it calls at the terminal exit.
//   2. STATE-CHANGING only — `write`/`destructive` effects; pure reads are dropped (a read
//      establishes nothing the agent changed, and would flood notes with transient lookups).

import type { ToolObservation } from "./adapter.js";
import type { EffectClass } from "./trust.js";

/**
 * One run-time observation paired with the EFFECTIVE effect the gate classified it under
 * (a destructive call carries `destructive`, incl. an arg-escalated write→destructive).
 * The `run.ts` collector pushes one of these per successful, observation-bearing tool call;
 * the harvest selects on `effect`.
 */
export interface ObservedEffect {
  observation: ToolObservation;
  effect: EffectClass;
}

/**
 * A proposed working-note candidate: a `(subject, value)` the harvest derived from a run's
 * observations, ready to be screened + proposed via `store.proposeWorldFact`. `subject` is
 * the controlled fact subject (`file:<path>` / `dir:<path>`); `value` is the rendered
 * current state.
 */
export interface WorldFactCandidate {
  subject: string;
  value: string;
}

// The `asterism.fs.*@1` current-state relations this deterministic renderer understands.
// Hardcoded here (not imported from the `cli` emitter — `core` must not depend on a
// surface) as the harvest's view of the fact contract; an observation carrying an unknown
// relation simply contributes no renderable state and is skipped, never guessed.
const REL_EXISTS = "exists";
const REL_SIZE_BYTES = "size_bytes";

/**
 * Render a subject's final relation map to a working-note value, or `undefined` to SKIP it
 * (no renderable current-state fact — never guess a value). Priority, highest first:
 *   - `exists = false`  → `"absent"`  (a deletion dominates: even with a stale `size_bytes`
 *                                      from an earlier write, the subject is gone).
 *   - `size_bytes = N`  → `"N bytes"` (a present file with a known size).
 *   - `exists = true`   → `"present"` (existence without a size — e.g. a directory).
 * Strict comparisons: `exists` carries a boolean, `size_bytes` a number, so a malformed
 * object of the wrong type falls through rather than mis-rendering.
 */
function renderValue(relations: ReadonlyMap<string, unknown>): string | undefined {
  if (relations.get(REL_EXISTS) === false) return "absent";
  const size = relations.get(REL_SIZE_BYTES);
  if (typeof size === "number") return `${size} bytes`;
  if (relations.get(REL_EXISTS) === true) return "present";
  return undefined;
}

/**
 * Reduce a run's collected {@link ObservedEffect}s to deterministic working-note candidates.
 *
 * 1. SELECT state-changing observations (`effect !== "read"`): a pure read establishes
 *    nothing the agent changed.
 * 2. ACCUMULATE per subject a `relation → object` map, applying facts in execution order so
 *    the LAST value of each relation wins — a `write` then `delete` of one path resolves to
 *    its final `exists = false` state, a re-write to its latest size.
 * 3. RENDER each subject (skipping any with no renderable state), and
 * 4. SORT by subject so a downstream "propose up to the cap" is deterministic.
 *
 * Dedup is automatic (one entry per subject). Pure and total: an empty or all-read input
 * yields `[]`.
 */
export function harvestWorldFactCandidates(
  effects: readonly ObservedEffect[],
): WorldFactCandidate[] {
  // subject → (relation → latest object). A Map preserves first-seen subject order, but the
  // final result is sorted, so insertion order does not leak into the output.
  const bySubject = new Map<string, Map<string, unknown>>();
  for (const { observation, effect } of effects) {
    if (effect === "read") continue;
    // The `observation` arrives from a tool's result — an UNTRUSTED extra channel. The TS
    // type guarantees `facts: ObservedFact[]`, but a host/JS tool implemented outside strict
    // TS can return a truthy-but-malformed observation (no `facts`, a non-array `facts`, a
    // fact missing `subject`/`relation`). The harvest runs at the run's terminal exit, so a
    // throw here would reject `executeRun` rather than ignore the bad observation — exactly
    // the T1 recorder's defensiveness, applied to the consumer. So validate the shape and
    // skip what does not match, never throw.
    const facts: unknown = observation?.facts;
    if (!Array.isArray(facts)) continue;
    for (const fact of facts) {
      if (fact === null || typeof fact !== "object") continue;
      const { subject, relation, object } = fact as {
        subject?: unknown;
        relation?: unknown;
        object?: unknown;
      };
      if (typeof subject !== "string" || typeof relation !== "string") continue;
      let relations = bySubject.get(subject);
      if (relations === undefined) {
        relations = new Map<string, unknown>();
        bySubject.set(subject, relations);
      }
      relations.set(relation, object);
    }
  }

  const candidates: WorldFactCandidate[] = [];
  for (const [subject, relations] of bySubject) {
    const value = renderValue(relations);
    if (value !== undefined) candidates.push({ subject, value });
  }
  candidates.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
  return candidates;
}
