// Structured recall — choosing WHICH of an agent's memories frame a run.
//
// Phase 0 inlined every accepted memory into a run's system prompt. That is
// correct but unbounded: the prompt grows with the agent's whole history, and
// nothing decides which memories matter for the task at hand. Recall is the seam
// that fixes both — it ranks an agent's candidate memories against the run's task
// and returns at most a budget's worth to frame.
//
// The seam mirrors `RuntimeAdapter` and `ReflectionProvider`: core defines the
// interface and a default, dependency-free implementation; a richer provider
// (local embeddings, a vector index) is a later, OPT-IN alternative behind the
// same interface — never in the default install path.
//
// THE BOUNDARY. A `RecallProvider` does not query the store. The KERNEL resolves
// the agent's candidates (its own active+accepted memories) and hands them in;
// the provider only ranks and selects within that set. So recall can only ever
// see one agent's memories — it physically cannot reach another agent's rows,
// the same property `framing.ts` relies on. Cross-agent leakage would require
// querying the store wrong, which the repositories already forbid.
//
// The default ranker is PURE and DETERMINISTIC — no clock (the reference time is
// passed in), no randomness, no I/O — so the same inputs always produce the same
// selection, which keeps framing testable and cache-friendly.

import type { Memory, MemoryType } from "./types.js";

/** A budget bounding how much memory a single run may recall. */
export interface RecallBudget {
  /** The maximum number of memories to frame into a run. */
  maxMemories: number;
}

/**
 * The default recall budget. Chosen high enough that a typical agent's memory
 * frames in full — so recall is invisible until memory actually grows past it,
 * and small memory sets (the canonical demo, existing tests) are unaffected.
 *
 * Frozen: it is a shared module constant, and the kernel must never let an untrusted
 * provider mutate it (which would change every later run's cap). The kernel also
 * never hands this object to a provider — it passes a fresh snapshot — but freezing
 * is the belt-and-suspenders that makes a poisoning bug impossible, not just avoided.
 */
export const DEFAULT_RECALL_BUDGET: RecallBudget = Object.freeze({ maxMemories: 20 });

/**
 * What the kernel hands a {@link RecallProvider}. All `candidates` already belong
 * to `agentId` (the kernel resolved them); the provider only ranks/selects within
 * them. It never reads the store, so it cannot widen the set or cross agents.
 */
export interface RecallInput {
  /** The agent whose run this is — every candidate already belongs to it. */
  agentId: string;
  /** The run's task; the relevance query the ranker scores against. */
  query: string;
  /**
   * The agent's candidate memories — its active + accepted set, oldest-first (the
   * kernel passes `store.memories.listActiveAccepted`). The provider selects a
   * subset of THESE and nothing else.
   */
  candidates: readonly Memory[];
  /** The budget bounding the selection. */
  budget: RecallBudget;
  /**
   * Reference time for recency scoring (ISO 8601) — the run's start. Passed in,
   * never read from a clock, so the ranker stays pure and deterministic. Absent ⇒
   * recency contributes nothing (the other signals still rank).
   */
  now?: string;
}

/**
 * Selects which of an agent's candidate memories frame a run. The default,
 * dependency-free implementation lives here ({@link defaultRecallProvider}); a
 * local-ML / embeddings provider is a later opt-in implementation of this same
 * interface, mirroring the {@link RuntimeAdapter} seam. Returns a read-only list,
 * always a subset of `input.candidates`.
 */
export interface RecallProvider {
  recall(input: RecallInput): Promise<readonly Memory[]>;
}

// ---------------------------------------------------------------------------
// Default ranker — lexical overlap + recency + confidence + a per-type prior.
// Each lever is a named constant so a test can assert it moves the ranking.
// ---------------------------------------------------------------------------

/**
 * How much each signal weighs in a candidate's score. Lexical relevance to the
 * task dominates; confidence and recency are secondary nudges. The per-type prior
 * is additive (see {@link TYPE_PRIOR}). These are deliberately simple, documented
 * knobs — the embeddings provider replaces the relevance signal entirely.
 */
const WEIGHTS = { lexical: 1.0, confidence: 0.3, recency: 0.3 } as const;

/**
 * A small additive bump per memory type: a hard CONVENTION or a NEGATIVE ("never
 * do X") shapes behaviour more than a stray semantic fact, so it is likelier to
 * survive a tight budget when other signals tie. Mirrors the framing type order.
 */
const TYPE_PRIOR: Readonly<Record<MemoryType, number>> = {
  convention: 0.2,
  negative: 0.2,
  procedural: 0.12,
  semantic: 0.06,
  episodic: 0.0,
};

/** Recency half-life: a memory this old contributes half its recency weight. */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Common words that carry no relevance signal — dropped before overlap so a task
 * and a memory are not judged "related" because they both say "the" or "to". A
 * compact list, not a linguistic resource; the embeddings provider needs none.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "of", "to", "in",
  "on", "at", "by", "for", "with", "from", "as", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "this", "that", "these", "those", "i",
  "you", "he", "she", "we", "they", "me", "my", "your", "our", "do", "does",
  "did", "so", "no", "not", "can", "will", "would", "should", "could", "have",
  "has", "had", "what", "when", "where", "who", "how", "all", "any", "up",
]);

/**
 * Split text into a set of distinct, lower-cased content tokens: alphanumeric
 * runs, minus stopwords and single characters. A set (not a bag) keeps a repeated
 * word from inflating overlap.
 */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Clamp a possibly out-of-range / non-finite value into [0, 1]. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Fraction of the task's distinct words that this memory mentions — "how much of
 * the task does this memory speak to". In [0, 1]; 0 when the query has no scorable
 * tokens (e.g. all stopwords), so recall falls back to the other signals.
 */
function lexicalOverlap(queryTokens: ReadonlySet<string>, content: string): number {
  if (queryTokens.size === 0) return 0;
  const contentTokens = tokenize(content);
  let shared = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) shared += 1;
  }
  return shared / queryTokens.size;
}

/**
 * Recency in [0, 1] via exponential decay from `now`. A memory created at `now`
 * (or, under clock skew, after it) scores 1; one a half-life older scores 0.5.
 * Returns 0 when `now` is absent or either timestamp is unparseable.
 */
function recencyScore(createdAt: string, now: string | undefined): number {
  if (now === undefined) return 0;
  const age = Date.parse(now) - Date.parse(createdAt);
  if (!Number.isFinite(age)) return 0;
  if (age <= 0) return 1;
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/** The default ranker's score for one candidate against the task. Higher = more relevant. */
function scoreMemory(
  memory: Memory,
  queryTokens: ReadonlySet<string>,
  now: string | undefined,
): number {
  return (
    WEIGHTS.lexical * lexicalOverlap(queryTokens, memory.content) +
    WEIGHTS.confidence * clamp01(memory.confidence) +
    WEIGHTS.recency * recencyScore(memory.createdAt, now) +
    (TYPE_PRIOR[memory.memoryType] ?? 0)
  );
}

/** Store order: oldest-first, ties broken by original position (≈ rowid ASC). */
function byStoreOrder(
  a: { memory: Memory; index: number },
  b: { memory: Memory; index: number },
): number {
  const t = a.memory.createdAt.localeCompare(b.memory.createdAt);
  return t !== 0 ? t : a.index - b.index;
}

/**
 * The pure core of the default provider — select up to the budget's worth of the
 * most task-relevant memories. Exported for direct testing.
 *
 * BEHAVIOUR-PRESERVING under budget: when the candidates already fit, they are
 * returned UNCHANGED (same order), so framing is byte-for-byte identical to the
 * pre-recall behaviour and the budget only bites once memory grows past it.
 *
 * Over budget: candidates are scored, the top `maxMemories` are taken, and the
 * SELECTION is returned in store order (oldest-first) — the same ordering style as
 * the under-budget path — so the prompt reads chronologically within each type
 * regardless of how many memories exist. Selection is by score; presentation is
 * chronological. Fully deterministic: score ties break on store order.
 */
export function selectRecall(input: RecallInput): readonly Memory[] {
  const { candidates, budget } = input;
  const max = budget.maxMemories;
  if (max <= 0) return [];
  if (candidates.length <= max) return candidates;

  const queryTokens = tokenize(input.query);
  const scored = candidates.map((memory, index) => ({
    memory,
    index,
    score: scoreMemory(memory, queryTokens, input.now),
  }));
  // Most relevant first; ties fall back to store order so the result is stable.
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : byStoreOrder(a, b)));
  // Present the chosen set chronologically, matching the under-budget path.
  return scored.slice(0, max).sort(byStoreOrder).map((s) => s.memory);
}

/**
 * The default {@link RecallProvider}: a pure, dependency-free lexical ranker under
 * a recall budget. The kernel uses this unless a host injects another provider.
 */
export const defaultRecallProvider: RecallProvider = {
  recall(input: RecallInput): Promise<readonly Memory[]> {
    return Promise.resolve(selectRecall(input));
  },
};

// ---------------------------------------------------------------------------
// Kernel-side enforcement — the recall guarantees do not depend on the provider.
// ---------------------------------------------------------------------------

/**
 * Re-impose the kernel's recall guarantees on a provider's output, no matter what
 * the provider did. A {@link RecallProvider} is INJECTABLE — a later embeddings /
 * vector backend could be buggy or hostile — so the kernel never trusts its result
 * to honor the contract. This re-establishes, in trusted code (mirroring how the
 * trust layer never trusts the adapter — the kernel owns the boundary, the seam
 * only proposes):
 *
 *   - ISOLATION — every framed memory is one of the `candidates` the kernel handed
 *     in, matched by `id`. A provider cannot introduce a memory the kernel did not
 *     resolve, including another agent's row, or one of this agent's own
 *     proposed/archived memories (candidates are only the active+accepted set). And
 *     the framed object is the kernel's OWN trusted candidate — never the object the
 *     provider returned — so a provider cannot tamper with a real id's content either.
 *   - BUDGET — at most `maxMemories` are framed, even if the provider returned more.
 *   - NO DUPLICATES — each candidate is framed at most once.
 *
 * The provider's ORDER is preserved among the memories that survive, so its ranking
 * is honored — only constrained. The default provider already satisfies all three,
 * so this is a no-op for it; it exists to make the seam safe for the providers it
 * is built to admit.
 *
 * The no-tamper guarantee frames objects from `candidates`, so it is only as strong
 * as that array's integrity: the caller MUST pass candidates the provider could not
 * have mutated. The kernel (`run.ts`) does this by handing the provider per-object
 * clones and keeping a pristine `candidates` array — which it passes here — for
 * itself. `selected` is treated as references-and-ids only; its objects never frame.
 */
export function enforceRecall(
  selected: readonly Memory[],
  candidates: readonly Memory[],
  budget: RecallBudget,
): readonly Memory[] {
  const max = budget.maxMemories;
  if (max <= 0) return [];
  // The trusted objects, keyed by id — what actually frames the run.
  const trusted = new Map<string, Memory>();
  for (const candidate of candidates) trusted.set(candidate.id, candidate);

  const out: Memory[] = [];
  const taken = new Set<string>();
  for (const memory of selected) {
    if (out.length >= max) break;
    const canonical = trusted.get(memory.id);
    if (canonical === undefined) continue; // not a candidate the kernel resolved — drop
    if (taken.has(memory.id)) continue; // already framed — dedupe
    taken.add(memory.id);
    out.push(canonical); // frame the kernel's own object, not the provider's
  }
  return out;
}
