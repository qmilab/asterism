import { expect, test } from "bun:test";

import { AUTONOMY_HELP, COMMAND_HELP, USAGE } from "./help.ts";
// The destructive-action gate's copy rule, shared with `check:docs` so there is exactly
// one of it. See the test that uses it for why that matters.
// @ts-expect-error — a checker's plain-JS helper, deliberately outside the package graph.
import { gateOverclaims } from "../../../scripts/lib/gate-claims.mjs";
import { formatStandingList } from "./format.ts";
import { PROVIDER_DEFAULTS } from "./model-config.ts";

test("usage lists every command in the surface", () => {
  for (const command of [
    "init",
    "new",
    "list",
    "trust",
    "capabilities show",
    "secrets add",
    "skill add",
    "objective add",
    "run",
    "connect <from>",
    "disconnect <from>",
    "connections <agent>",
    "handoff <from>",
    "artifact <from>",
    "fetch <from>",
    "confirm",
    "runs <agent>",
    "memory inspect",
    "events tail",
    "reflect",
    "config",
    "serve",
    "service install",
  ]) {
    expect(USAGE).toContain(command);
  }
});

test("notify help states plainly that it acts first and does not ask", () => {
  // Golden rule: the middle level must never read as "asks before acting".
  expect(AUTONOMY_HELP).toContain("notify");
  expect(AUTONOMY_HELP).toContain("Acts on its own");
  expect(AUTONOMY_HELP).toContain("does NOT ask first");
  // The same promise must travel with `new`'s help, where the level is chosen.
  expect(COMMAND_HELP.new).toContain("does not");
  expect(COMMAND_HELP.new).toContain("ask first");
});

test("help describes the destructive-action gate, and which levels actually stop to ask", () => {
  expect(AUTONOMY_HELP).toContain("destructive");
  // Naming the two levels that PAUSE, and the one that does not act at all, is the
  // whole content of the gate for a reader choosing a level.
  expect(AUTONOMY_HELP).toContain("notify");
  expect(AUTONOMY_HELP).toContain("autonomous");
  expect(AUTONOMY_HELP).toContain("propose");
});

test("no user-facing copy claims a destructive action pauses at EVERY trust level", () => {
  // It does not: `propose` withholds the action and returns a plan — nothing is asked.
  // The claim was false in eight places across the product and the docs at once, so it
  // is guarded by shape rather than by remembering each site (`trust.ts` resolves
  // destructive → "withhold" under propose, → "confirm" otherwise).
  const allCopy = [USAGE, AUTONOMY_HELP, ...Object.values(COMMAND_HELP)].join("\n");
  for (const sentence of allCopy.split(/(?<=[.:])\s+/)) {
    // Any qualifier between the quantifier and "level" — `at every autonomy level` slipped
    // through a version of this that only allowed the word "trust", and it was false in
    // exactly the same way.
    const universal =
      /\b(at|for) (every|any|all)(\s+\w+)? levels?\b|regardless of (its )?trust/i.test(sentence);
    const pauses = /\bpause|\bstops? and asks?|\basks? (you )?first|confirmation/i.test(sentence);
    expect(
      universal && pauses,
      `copy claims a pause at every level, which is false at 'propose': ${sentence.trim()}`,
    ).toBe(false);
  }
});

test("no user-facing copy promises the destructive gate without its allow-list exception", () => {
  // The mirror of the test above, and the reason both are here: correcting the `propose`
  // overclaim (#139) is what wrote this one (#176 → #177). `decideGate` consults
  // `autoApprove` BEFORE it decides to pause, and `run.ts` fills that set from earned
  // standing grants — so an operator who accepted a `trust <agent> --review` grant on
  // `fs.delete` gets deletions with no prompt, and copy that promises otherwise is wrong
  // in the operator's favour right up until it matters.
  //
  // The rule itself lives in `scripts/lib/gate-claims.mjs` and is shared with `check:docs`,
  // which applies it to every page a user meets and to the help the binary actually PRINTS.
  // One implementation on purpose: two guards for one sentence are how the correction for
  // half of it shipped without the other half. This test is the fast half — it needs no
  // build — and covers the constants those help screens are rendered from.
  for (const [name, copy] of [
    ["USAGE", USAGE],
    ["AUTONOMY_HELP", AUTONOMY_HELP],
    ...Object.entries(COMMAND_HELP),
  ] as [string, string][]) {
    const overclaims = gateOverclaims(copy);
    expect(
      overclaims.map((f) => `${name}: [${f.rule}] ${f.sentence}`),
      `${name} states the destructive-action gate more widely than the kernel enforces it`,
    ).toEqual([]);
  }
});

test("`trust show` does not promise a `propose` agent a pause it will never see", () => {
  // `decideGate` withholds every side effect at `propose` BEFORE the destructive flag is
  // consulted, so at that level nothing pauses and an earned grant cannot take effect.
  // This view is rendered from the agent's level, so it has to say which it is.
  const grant = {
    id: "g1",
    agentId: "a1",
    capability: "fs.delete",
    standing: "standing-grant" as const,
    basis: "3 clean executions across 2 targets",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  for (const grants of [[], [grant]]) {
    // Whitespace-normalized: the copy wraps across a newline, so matching a literal
    // space made this assertion unfalsifiable — it passed against the exact sentence it
    // exists to forbid.
    const proposeCopy = formatStandingList(grants, "helper", "propose").replace(/\s+/g, " ");
    expect(proposeCopy).not.toMatch(/(pauses|stops) for your confirmation/);
    expect(proposeCopy).toContain("propose");
    // And the levels that DO pause must still say so.
    for (const level of ["notify", "autonomous"] as const) {
      expect(formatStandingList(grants, "helper", level)).not.toContain("inert at propose");
    }
  }
});

test("public copy carries no internal architecture vocabulary", () => {
  const allCopy = [USAGE, AUTONOMY_HELP, ...Object.values(COMMAND_HELP)].join("\n");
  for (const forbidden of [/\bkernel\b/i, /\badapter\b/i, /\bfirewall\b/i, /\bregistry\b/i, /\bsubstrate\b/i]) {
    expect(allCopy).not.toMatch(forbidden);
  }
});

test("the exposure verb's help keeps it distinct from trust, and never implies agents were unconfined", () => {
  const copy = COMMAND_HELP.capabilities!;
  // The two nouns are adjacent and confusable; the help has to say which is which.
  expect(copy).toContain("This is not the same as trust");
  expect(copy).toContain("WHICH tools an agent has");
  // Copy constraint from the decision record: narrowing is something you may do ON TOP
  // of the workspace boundary and trust level every agent already has. No string here
  // may suggest an agent was loose before this existed.
  expect(copy).toContain("perfectly normal");
  expect(copy).not.toMatch(/unconfined|unrestricted|unlimited|no restrictions|sandbox/i);
});

test("the config help lists exactly the providers that are built in", () => {
  // The help text asserts a completeness it cannot check for itself: "naming one
  // of these is enough". Adding a PROVIDER_DEFAULTS entry and forgetting the copy
  // leaves a provider that works but is invisible; removing one leaves copy that
  // advertises an endpoint nobody has. Derive the list, do not assert it.
  const copy = COMMAND_HELP.config!;
  // Anchor on the OPTIONS block: the synopsis line above it also names
  // `--provider <name>`, and slicing from the first match found only that.
  const start = copy.indexOf("Options for");
  expect(start).toBeGreaterThan(-1);
  const options = copy.slice(start, copy.indexOf("--base-url <url>", start));
  expect(options).toContain("--provider <name>");
  const listed = new Set(
    options.match(/\b[a-z][a-z0-9-]{2,}\b/g)?.filter((w) => w in PROVIDER_DEFAULTS),
  );
  expect([...listed].sort()).toEqual(Object.keys(PROVIDER_DEFAULTS).sort());
});

test("the config help separates the providers that need no key", () => {
  // Not just that both sets appear, but that the keyless ones are named in the
  // sentence promising no account — the claim a reader actually acts on.
  const copy = COMMAND_HELP.config!;
  const keyless = Object.entries(PROVIDER_DEFAULTS)
    .filter(([, d]) => d.needsNoKey === true)
    .map(([name]) => name);
  const noAccountClause = copy.slice(copy.indexOf("no\n                      account"));
  for (const name of keyless) expect(noAccountClause).toContain(name);
});
