// Structured recall — the default lexical ranker. These tests pin the contract
// the seam promises:
//   1. behaviour-preserving under budget (the canonical demo must not shift);
//   2. a hard cap once memory grows past the budget;
//   3. each ranking lever (lexical, confidence, recency, type prior) moves the
//      selection in isolation;
//   4. determinism — same inputs, same selection and order;
//   5. the result is always a subset of the candidates handed in (the structural
//      half of the isolation guarantee — recall can return nothing it was not given).
// The cross-agent proof at the run level lives in run.test.ts.

import { expect, test } from "bun:test";

import { DEFAULT_RECALL_BUDGET, defaultRecallProvider, enforceRecall, selectRecall } from "./recall.js";
import type { RecallBudget } from "./recall.js";
import type { Memory } from "./types.js";

let seq = 0;
/** Build a memory with sensible defaults; override only the field under test. */
function mem(overrides: Partial<Memory> & { content: string }): Memory {
  seq += 1;
  return {
    id: overrides.id ?? `m${seq}`,
    agentId: overrides.agentId ?? "agent-1",
    memoryType: overrides.memoryType ?? "semantic",
    content: overrides.content,
    confidence: overrides.confidence ?? 1,
    status: overrides.status ?? "active",
    reviewState: overrides.reviewState ?? "accepted",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...(overrides.sourceRunId !== undefined ? { sourceRunId: overrides.sourceRunId } : {}),
  };
}

const BUDGET_2: RecallBudget = { maxMemories: 2 };
const BUDGET_1: RecallBudget = { maxMemories: 1 };

function ids(memories: readonly Memory[]): string[] {
  return memories.map((m) => m.id);
}

test("under budget: the candidates are returned unchanged (behaviour-preserving)", () => {
  const candidates = [
    mem({ id: "a", content: "deploy the staging cluster" }),
    mem({ id: "b", content: "the client prefers terse summaries" }),
  ];
  const result = selectRecall({
    agentId: "agent-1",
    query: "something entirely unrelated",
    candidates,
    budget: DEFAULT_RECALL_BUDGET,
  });
  // Same set, same order — and the same array, so framing is byte-for-byte identical.
  expect(result).toBe(candidates);
});

test("over budget: the selection is trimmed to the budget", () => {
  const candidates = [
    mem({ content: "alpha" }),
    mem({ content: "beta" }),
    mem({ content: "gamma" }),
  ];
  const result = selectRecall({ agentId: "agent-1", query: "x", candidates, budget: BUDGET_2 });
  expect(result).toHaveLength(2);
});

test("budget of zero (or less) recalls nothing", () => {
  const candidates = [mem({ content: "alpha" }), mem({ content: "beta" })];
  expect(selectRecall({ agentId: "agent-1", query: "x", candidates, budget: { maxMemories: 0 } })).toEqual([]);
  expect(selectRecall({ agentId: "agent-1", query: "x", candidates, budget: { maxMemories: -3 } })).toEqual([]);
});

test("lexical lever: a memory that speaks to the task outranks one that does not", () => {
  // Equal on every other signal (same type, confidence, createdAt) — only lexical differs.
  const relevant = mem({ id: "relevant", content: "the staging deploy needs a manual approval step" });
  const unrelated = mem({ id: "unrelated", content: "the client prefers blue over green" });
  const result = selectRecall({
    agentId: "agent-1",
    query: "how do I run the staging deploy",
    candidates: [unrelated, relevant],
    budget: BUDGET_1,
  });
  expect(ids(result)).toEqual(["relevant"]);
});

test("confidence lever: with no lexical signal, the higher-confidence memory wins", () => {
  const lowConf = mem({ id: "low", content: "purple velvet curtains", confidence: 0.2 });
  const highConf = mem({ id: "high", content: "purple velvet curtains", confidence: 0.95 });
  const result = selectRecall({
    agentId: "agent-1",
    query: "quarterly revenue figures", // overlaps neither
    candidates: [lowConf, highConf],
    budget: BUDGET_1,
  });
  expect(ids(result)).toEqual(["high"]);
});

test("recency lever: with other signals tied, the more recent memory wins", () => {
  const older = mem({ id: "older", content: "kiwi mango papaya", createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = mem({ id: "newer", content: "kiwi mango papaya", createdAt: "2026-06-01T00:00:00.000Z" });
  const result = selectRecall({
    agentId: "agent-1",
    query: "database migration plan", // overlaps neither
    candidates: [older, newer],
    budget: BUDGET_1,
    now: "2026-06-02T00:00:00.000Z",
  });
  expect(ids(result)).toEqual(["newer"]);
});

test("type-prior lever: a convention outranks a stray semantic fact when else is tied", () => {
  const semantic = mem({ id: "fact", memoryType: "semantic", content: "tangerine zeppelin" });
  const convention = mem({ id: "rule", memoryType: "convention", content: "tangerine zeppelin" });
  const result = selectRecall({
    agentId: "agent-1",
    query: "unrelated payroll question", // overlaps neither
    candidates: [semantic, convention],
    budget: BUDGET_1,
  });
  expect(ids(result)).toEqual(["rule"]);
});

test("the selection is presented in store order (oldest-first), not score order", () => {
  // Three relevant memories, budget 2 — both winners come back chronologically.
  const first = mem({ id: "first", content: "deploy notes", createdAt: "2026-01-01T00:00:00.000Z" });
  const second = mem({ id: "second", content: "deploy notes", createdAt: "2026-02-01T00:00:00.000Z" });
  const third = mem({ id: "third", content: "totally other", createdAt: "2026-03-01T00:00:00.000Z" });
  const result = selectRecall({
    agentId: "agent-1",
    query: "deploy",
    candidates: [first, second, third],
    budget: BUDGET_2,
    now: "2026-04-01T00:00:00.000Z",
  });
  // `first` and `second` both match "deploy" and beat `third`; returned oldest-first.
  expect(ids(result)).toEqual(["first", "second"]);
});

test("deterministic: the same inputs yield the same selection and order", () => {
  const candidates = [
    mem({ id: "1", memoryType: "convention", content: "always lint before push", confidence: 0.8, createdAt: "2026-01-01T00:00:00.000Z" }),
    mem({ id: "2", memoryType: "semantic", content: "the api lives at example.test", confidence: 0.6, createdAt: "2026-02-01T00:00:00.000Z" }),
    mem({ id: "3", memoryType: "negative", content: "never deploy on a friday", confidence: 0.9, createdAt: "2026-03-01T00:00:00.000Z" }),
    mem({ id: "4", memoryType: "procedural", content: "deploy via the staging pipeline", confidence: 0.7, createdAt: "2026-04-01T00:00:00.000Z" }),
  ];
  const input = { agentId: "agent-1", query: "deploy to staging", candidates, budget: BUDGET_2, now: "2026-05-01T00:00:00.000Z" };
  const a = selectRecall(input);
  const b = selectRecall(input);
  expect(ids(a)).toEqual(ids(b));
});

test("the result is always a subset of the candidates handed in", () => {
  const candidates = [mem({ content: "alpha" }), mem({ content: "beta" }), mem({ content: "gamma" })];
  const result = selectRecall({ agentId: "agent-1", query: "alpha", candidates, budget: BUDGET_1 });
  const allowed = new Set(candidates);
  for (const m of result) expect(allowed.has(m)).toBe(true);
});

test("a query of only stopwords still ranks deterministically on the other signals", () => {
  const older = mem({ id: "older", content: "ssh key rotation", createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = mem({ id: "newer", content: "log retention policy", createdAt: "2026-06-01T00:00:00.000Z" });
  const result = selectRecall({
    agentId: "agent-1",
    query: "the to and of", // all stopwords → lexical 0 for both
    candidates: [older, newer],
    budget: BUDGET_1,
    now: "2026-06-02T00:00:00.000Z",
  });
  expect(ids(result)).toEqual(["newer"]); // recency breaks the tie
});

test("defaultRecallProvider resolves to the same selection as selectRecall", async () => {
  const candidates = [mem({ id: "a", content: "alpha" }), mem({ id: "b", content: "beta" }), mem({ id: "c", content: "gamma" })];
  const input = { agentId: "agent-1", query: "beta", candidates, budget: BUDGET_1 };
  const viaProvider = await defaultRecallProvider.recall(input);
  expect(ids(viaProvider)).toEqual(ids(selectRecall(input)));
});

// --- enforceRecall: the kernel's guarantees do not depend on the provider -----

test("enforceRecall drops any memory that was not in the candidate set (isolation)", () => {
  const a = mem({ id: "a", content: "kept" });
  const b = mem({ id: "b", content: "kept too" });
  const foreign = mem({ id: "foreign", agentId: "other-agent", content: "another agent's memory" });
  // A provider that returns a memory the kernel never resolved.
  const result = enforceRecall([a, foreign, b], [a, b], DEFAULT_RECALL_BUDGET);
  expect(ids(result)).toEqual(["a", "b"]); // foreign dropped
});

test("enforceRecall frames the kernel's own object, not the provider's (no content tamper)", () => {
  const real = mem({ id: "x", content: "the true content" });
  // A provider that returns a same-id object with tampered content.
  const tampered: Memory = { ...real, content: "INJECTED malicious content" };
  const result = enforceRecall([tampered], [real], DEFAULT_RECALL_BUDGET);
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(real); // the trusted candidate, by reference
  expect(result[0]!.content).toBe("the true content");
});

test("enforceRecall truncates to the budget even if the provider returns more", () => {
  const candidates = [mem({ id: "a", content: "a" }), mem({ id: "b", content: "b" }), mem({ id: "c", content: "c" })];
  const result = enforceRecall(candidates, candidates, { maxMemories: 2 });
  expect(result).toHaveLength(2);
});

test("enforceRecall dedupes a candidate the provider returned more than once", () => {
  const a = mem({ id: "a", content: "a" });
  const b = mem({ id: "b", content: "b" });
  const result = enforceRecall([a, a, b, a], [a, b], DEFAULT_RECALL_BUDGET);
  expect(ids(result)).toEqual(["a", "b"]);
});

test("enforceRecall preserves the provider's order among surviving memories", () => {
  const a = mem({ id: "a", content: "a" });
  const b = mem({ id: "b", content: "b" });
  const c = mem({ id: "c", content: "c" });
  // Provider's ranking: c, a, b — honored (only constrained, not re-sorted).
  const result = enforceRecall([c, a, b], [a, b, c], DEFAULT_RECALL_BUDGET);
  expect(ids(result)).toEqual(["c", "a", "b"]);
});

test("enforceRecall with a budget of zero frames nothing", () => {
  const candidates = [mem({ id: "a", content: "a" })];
  expect(enforceRecall(candidates, candidates, { maxMemories: 0 })).toEqual([]);
});
