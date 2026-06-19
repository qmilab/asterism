// The opt-in embeddings RecallProvider — rank an agent's candidate memories by
// MEANING (embedding cosine similarity) instead of keyword overlap.
//
// It implements core's `RecallProvider` exactly, so the kernel drives it through the
// same seam as the default lexical ranker, and re-imposes ISOLATION + BUDGET +
// NO-DUPLICATES on its OUTPUT (`enforceRecall`) regardless of what this returns. So
// this file is free to be "just a ranker": it never reaches the store, never sees
// another agent's rows (the kernel hands in only this agent's candidates), and a bug
// here can at worst reorder/drop within the handed-in set — never widen it.
//
// Two deliberate properties:
//   - UNDER BUDGET IS A NO-OP. When the candidates already fit, they are returned
//     unchanged — no embedding call at all. So opting in costs nothing until an
//     agent's memory actually grows past its recall budget, and small memory sets
//     behave byte-for-byte like the default provider.
//   - FAIL SAFE. If the embedder is unavailable (a local server down, a malformed
//     response), the provider does NOT fail the run — it degrades to core's
//     dependency-free lexical ranker (`selectRecall`), which still frames CORRECT
//     memories, and reports the degrade through `onDegrade` so the host can be loud.

import { selectRecall } from "@qmilab/asterism-core";
import type { Memory, RecallInput, RecallProvider } from "@qmilab/asterism-core";

import type { Embedder } from "./embedder.js";

/** Construction options for {@link EmbeddingRecallProvider}. */
export interface EmbeddingRecallProviderOptions {
  /** The vector source (a local HTTP endpoint by default; see {@link createHttpEmbedder}). */
  embedder: Embedder;
  /**
   * Called when recall falls back to the lexical ranker because the embedder was
   * unavailable or returned something unusable. The host wires this to a loud
   * stderr line so a silent local-server outage is visible. Never throws into recall.
   */
  onDegrade?: (error: unknown) => void;
}

/** Cosine similarity of two equal-length vectors; 0 when either is zero-length or zero-norm. */
function cosine(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(sim) ? sim : 0;
}

export class EmbeddingRecallProvider implements RecallProvider {
  private readonly embedder: Embedder;
  private readonly onDegrade: ((error: unknown) => void) | undefined;

  constructor(options: EmbeddingRecallProviderOptions) {
    this.embedder = options.embedder;
    this.onDegrade = options.onDegrade;
  }

  async recall(input: RecallInput): Promise<readonly Memory[]> {
    const { candidates, budget, query } = input;
    const max = budget.maxMemories;
    if (max <= 0) return [];
    // Under budget: everything frames. No selection to make, so no embedding call —
    // identical to the default provider's under-budget path. The kernel still
    // re-enforces, so this is also the cheapest correct answer.
    if (candidates.length <= max) return candidates;

    try {
      // Embed the query and every candidate in one call; index 0 is the query.
      const vectors = await this.embedder.embed([query, ...candidates.map((c) => c.content)]);
      const queryVec = vectors[0];
      if (!Array.isArray(queryVec) || vectors.length !== candidates.length + 1) {
        throw new Error("embedder returned an unexpected number of vectors");
      }

      // Score each candidate against the query; keep its original index so ties and
      // presentation fall back to store order (the candidates arrive oldest-first).
      const scored = candidates.map((memory, index) => {
        const vec = vectors[index + 1];
        const score = Array.isArray(vec) ? cosine(queryVec, vec) : -Infinity;
        return { memory, index, score };
      });
      // Most similar first; ties break on store order so the result is deterministic.
      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
      // Present the chosen set chronologically (store order), matching the default
      // provider's presentation so framing reads the same way regardless of ranker.
      return scored
        .slice(0, max)
        .sort((a, b) => a.index - b.index)
        .map((s) => s.memory);
    } catch (error) {
      // The embedder was unavailable or returned garbage. Degrade to the lexical
      // ranker — correct memories, no crashed run — and let the host be loud.
      this.onDegrade?.(error);
      return selectRecall(input);
    }
  }
}
