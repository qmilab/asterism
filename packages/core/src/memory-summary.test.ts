// curateMemorySummary — the pure projection that crosses a `read-summary` connection
// (Phase 3 · T2b; design note §13, decisions D16–D18).
//
// This module IS the boundary of the mode: what it emits is exactly what one agent sees of
// another's mind. So the tests here are about what it excludes as much as what it emits.

import { expect, test } from "bun:test";

import { curateMemorySummary, DEFAULT_SUMMARY_BUDGET } from "./memory-summary.js";
import { screenMemory } from "./firewall.js";
import type { Memory, MemoryType } from "./types.js";

/**
 * A memory that PASSES the inbound firewall but trips the outbound scrub: the NUL splits
 * `token`, so the write path's raw-content test does not match, while `redactForTrace`
 * strips the control character before running the same rules and the word reconstitutes.
 * Written as an escape rather than a literal byte so the source stays readable.
 */
const EVASIVE = "Never reveal the deploy to\u0000ken to anyone outside the team.";

let seq = 0;

/** A stored memory as the callee's store would hand it back (active + accepted). */
function memory(content: string, overrides: Partial<Memory> = {}): Memory {
  seq += 1;
  return {
    id: `mem-${seq}`,
    agentId: "callee",
    memoryType: "semantic",
    content,
    confidence: 0.8,
    status: "active",
    reviewState: "accepted",
    createdAt: new Date(Date.UTC(2026, 0, seq)).toISOString(),
    ...overrides,
  };
}

// --- projection: the row does not cross -------------------------------------

test("an item carries the KIND and the content, and nothing of the row", () => {
  const summary = curateMemorySummary([
    memory("Always quote prices in USD.", {
      memoryType: "convention",
      sourceRunId: "run-that-must-not-cross",
      confidence: 0.42,
    }),
  ]);

  expect(summary.items).toHaveLength(1);
  const item = summary.items[0]!;
  // The whole exclusion list, asserted as a KEY SET rather than field by field — so adding a
  // field to the item type has to be a deliberate act that updates this test, exactly as the
  // T2a acceptance test pins `ArtifactExchangeResult`'s keys.
  expect(Object.keys(item).sort()).toEqual(["content", "memoryType"]);
  expect(item.memoryType).toBe("convention");
  expect(item.content).toBe("Always quote prices in USD.");
  // Belt and braces: nothing anywhere in the payload mentions the row's identifiers.
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain("run-that-must-not-cross");
  expect(serialized).not.toContain("mem-");
  expect(serialized).not.toContain("0.42");
  expect(serialized).not.toContain("accepted");
});

test("an empty eligible set yields a zeroed summary, not an error", () => {
  const summary = curateMemorySummary([]);
  expect(summary).toEqual({ eligible: 0, included: 0, withheld: 0, items: [] });
});

// --- the screen: D18's split by category ------------------------------------

test("a secret-shaped VALUE is scrubbed and the knowledge still crosses", () => {
  const summary = curateMemorySummary([
    memory("The deploy token is sk-abc123def456ghi789jkl012mno345pqr678stu and rotates monthly."),
  ]);

  expect(summary.included).toBe(1);
  expect(summary.withheld).toBe(0);
  const item = summary.items[0]!;
  expect(item.content).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678stu");
  // The surrounding sentence survives — that is the whole point of marking rather than
  // withholding: the value is gone, the knowledge ("it rotates monthly") is still true.
  expect(item.content).toContain("rotates monthly");
  expect(item.screened).toBe(true);
});

test("an injection-shaped memory is WITHHELD WHOLE, not merely marked", () => {
  // The mechanism that makes this reachable for a STORED memory, verified rather than
  // assumed: a control character splits a keyword, so the INBOUND firewall — which tests the
  // raw content — does not match and the memory can be written and ratified. `redactForTrace`
  // strips control characters (its stage 2) BEFORE running the same rules, so the word
  // reconstitutes and the outbound scrub catches what the write path structurally could not.
  const evasive = EVASIVE;
  expect(screenMemory(evasive).ok).toBe(true); // storable: the write path accepts it

  const summary = curateMemorySummary([memory("Ship on Fridays only."), memory(evasive)]);

  expect(summary.eligible).toBe(2);
  expect(summary.included).toBe(1);
  expect(summary.withheld).toBe(1);
  expect(summary.items[0]!.content).toBe("Ship on Fridays only.");
  // Not one span of it crossed — not the harmless half of the sentence either.
  expect(JSON.stringify(summary)).not.toContain("anyone outside the team");
});

test("ordinary prose is neither scrubbed nor withheld, even when it uses the rules' words", () => {
  // The cost of D18's withhold branch would be unacceptable if it fired on normal memory, so
  // this pins the false-positive behaviour of the rules the mode leans on.
  const ordinary = [
    "Follow the setup instructions in docs/install.md before the first run.",
    "Ignore the lint warning about unused imports in generated files.",
    "The system prompt lives in SOUL.md and is loaded at framing time.",
    "The password manager is 1Password; nothing lives in the repo.",
  ];
  const summary = curateMemorySummary(ordinary.map((c) => memory(c)));

  expect(summary.included).toBe(4);
  expect(summary.withheld).toBe(0);
  for (const item of summary.items) expect(item.screened).toBeUndefined();
  expect(summary.items.map((i) => i.content)).toEqual(ordinary);
});

test("a memory that screens down to nothing is withheld, never emitted blank", () => {
  // Control characters are stripped (stage 2) before anything else looks at the text, so a
  // memory made only of them screens down to nothing. An empty item is not knowledge, and
  // emitting one would make `included` overstate what the caller received.
  const summary = curateMemorySummary([memory("\u0000\u0007 \u001b")]);
  expect(summary.included).toBe(0);
  expect(summary.withheld).toBe(1);
  expect(summary.items).toEqual([]);
});

test("over-long content is truncated and marked screened", () => {
  // Realistic prose, not a repeated character run: a long opaque token-shaped run is caught
  // by the SECRET-value rules instead, which is correct behaviour but tests a different path.
  const long = "The quarterly report is filed on the last Friday of the month. ".repeat(5);
  const summary = curateMemorySummary([memory(long)], {
    budget: { maxItems: 10, maxContentBytes: 50 },
  });
  expect(summary.included).toBe(1);
  expect(summary.items[0]!.content).toBe(long.slice(0, 50));
  expect(summary.items[0]!.screened).toBe(true);
});

test("phrasing beyond the byte cap is truncated away rather than counted as a refusal", () => {
  // Truncation runs FIRST inside redactForTrace, so a rule match past the cap never happens.
  // That is safe rather than a hole: the bytes it would have matched do not cross either.
  const prefix = "Deployments run at 9am UTC every weekday without exception. ";
  const summary = curateMemorySummary([memory(prefix + EVASIVE)], {
    budget: { maxItems: 10, maxContentBytes: 40 },
  });
  expect(summary.included).toBe(1);
  expect(summary.withheld).toBe(0);
  expect(summary.items[0]!.content).toBe(prefix.slice(0, 40));
});

// --- selection and bounding -------------------------------------------------

test("the budget bounds what crosses, and the counts say so", () => {
  const memories = Array.from({ length: 30 }, (_, i) => memory(`note ${i}`));
  const summary = curateMemorySummary(memories);

  expect(summary.eligible).toBe(30);
  expect(summary.included).toBe(DEFAULT_SUMMARY_BUDGET.maxItems);
  expect(summary.withheld).toBe(0);
  // eligible - included - withheld is what the budget held back: the renderer needs both
  // numbers to tell a bounded extract from a screened one.
  expect(summary.eligible - summary.included - summary.withheld).toBe(
    30 - DEFAULT_SUMMARY_BUDGET.maxItems,
  );
});

test("the screen's refusals do not consume budget slots", () => {
  // Screening happens BEFORE selection, so a withheld memory never occupies a slot a
  // crossable one could have used — otherwise the extract would silently shrink.
  const evasive = EVASIVE;
  const memories = [
    memory(evasive),
    memory(evasive),
    ...Array.from({ length: 5 }, (_, i) => memory(`note ${i}`)),
  ];
  const summary = curateMemorySummary(memories, { budget: { maxItems: 3, maxContentBytes: 1024 } });

  expect(summary.included).toBe(3);
  expect(summary.withheld).toBe(2);
  expect(summary.items.map((i) => i.content)).toEqual(["note 0", "note 1", "note 2"]);
});

test("a focus ranks by relevance once there is more than the budget allows", () => {
  const memories = [
    memory("The office kettle needs descaling."),
    memory("Deployments run at 9am UTC."),
    memory("Pricing is quoted in USD, never local currency.", { memoryType: "convention" }),
    memory("The pricing page is generated from pricing.yaml."),
  ];
  const focused = curateMemorySummary(memories, {
    focus: "pricing",
    budget: { maxItems: 2, maxContentBytes: 1024 },
  });

  expect(focused.focus).toBe("pricing");
  expect(focused.included).toBe(2);
  for (const item of focused.items) expect(item.content).toContain("ricing");
  // Presentation stays chronological within the selection, matching how recall frames a run.
  expect(focused.items.map((i) => i.content)).toEqual([
    "Pricing is quoted in USD, never local currency.",
    "The pricing page is generated from pricing.yaml.",
  ]);
});

test("under the cap a focus returns everything eligible, in the callee's own order", () => {
  const memories = [memory("alpha"), memory("beta")];
  const summary = curateMemorySummary(memories, { focus: "nothing matches this" });
  // The focus is a selector under a budget, not a filter that hides what fits — the same
  // behaviour recall has when framing a run.
  expect(summary.items.map((i) => i.content)).toEqual(["alpha", "beta"]);
});

test("a blank focus is treated as no focus at all", () => {
  const summary = curateMemorySummary([memory("alpha")], { focus: "   " });
  expect(summary.focus).toBeUndefined();
});

test("a zero item budget crosses nothing while still reporting what was eligible", () => {
  const summary = curateMemorySummary([memory("alpha"), memory("beta")], {
    budget: { maxItems: 0, maxContentBytes: 1024 },
  });
  expect(summary.eligible).toBe(2);
  expect(summary.included).toBe(0);
  expect(summary.items).toEqual([]);
});

// --- determinism: D16's argument 3 ------------------------------------------

test("the same memory set yields a byte-identical summary every time", () => {
  // No clock, no randomness, no I/O — so what crossed can be re-derived from what the callee
  // holds, which is the property the both-logs audit exists to support. A recency-weighted
  // ranker would break this at the budget's edge, which is why no reference time is taken.
  const types: MemoryType[] = ["semantic", "procedural", "convention", "negative", "episodic"];
  const memories = Array.from({ length: 40 }, (_, i) =>
    memory(`fact ${i} about pricing and deploys`, { memoryType: types[i % types.length]! }),
  );
  const a = JSON.stringify(curateMemorySummary(memories, { focus: "pricing" }));
  const b = JSON.stringify(curateMemorySummary(memories, { focus: "pricing" }));
  expect(a).toBe(b);
});

test("the default budget is frozen against mutation", () => {
  expect(Object.isFrozen(DEFAULT_SUMMARY_BUDGET)).toBe(true);
});
