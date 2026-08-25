import { expect, test } from "bun:test";

import { AUTONOMY_HELP, COMMAND_HELP, USAGE } from "./help.ts";
// The destructive-action gate's copy rule, shared with `check:docs` so there is exactly
// one of it. See the test that uses it for why that matters.
// @ts-expect-error — a checker's plain-JS helper, deliberately outside the package graph.
import { gateOverclaims } from "../../../scripts/lib/gate-claims.mjs";
// Golden rule 7's word list, shared with `check:docs` for the same reason and after the
// same failure. See the test that uses it.
// @ts-expect-error — a checker's plain-JS helper, deliberately outside the package graph.
import { vocabularyLeaks } from "../../../scripts/lib/copy-vocabulary.mjs";
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

test("the CLI's help states the destructive-action gate no more widely than it fires", () => {
  // Two ways one sentence can promise more than the gate delivers, and this product has
  // shipped both:
  //
  //   every-level    "a destructive action pauses at every trust level" — false at
  //                  `propose`, which withholds the action and hands over a plan (#139).
  //   no-exception   "even an `autonomous` agent pauses", with no mention of the
  //                  allow-list — false for a capability the operator granted standing to,
  //                  which `trust <agent> --review` really does (#176 → #177).
  //
  // The second was written by the correction for the first, which is why both live in ONE
  // predicate — `scripts/lib/gate-claims.mjs`, shared with `check:docs`, which applies it to
  // every page a user meets and to the help the binary actually PRINTS. This test is the
  // fast half: it needs no build, and it covers the constants those help screens are
  // rendered from.
  //
  // ⚠ There used to be a SECOND test here, hand-writing the `every-level` half in its own
  // regexes — the guard #139 left behind, kept when #177 built the shared rule beside it.
  // It had already drifted, exactly as one predicate in two spellings does. Measured before
  // removing it: over the 61 sources both rules read, each fires zero times, so nothing live
  // was resting on it — and it MISSED three shapes this one catches, two of them real
  // defects #177 had to fix by hand (`whatever the agent's trust level`, `the gate holds at
  // every level:` with the promise after the colon, and a row naming all three levels before
  // promising a stop). What it caught and this does not is a level-wide pause promise with
  // no destructive word anywhere in its block, which is not a claim about this gate.
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

test("the CLI's help carries no internal architecture vocabulary", () => {
  // Golden rule 7: public copy sells the behavioural outcome, not the architecture.
  //
  // This test used to BE the rule — five words, refused in the help constants, under the
  // name "public copy". Golden rule 7 says "README, CLI help text, and any user-facing
  // string", and the corpus was the second of those. So `kernel` sat in eight passages of
  // published copy, the site's own front page among them, where a guard reading three
  // string constants could not see it. The same shape as the destructive-gate test above,
  // discovered by auditing that one as a category (#177 → #183).
  //
  // The rule now lives in `scripts/lib/copy-vocabulary.mjs` — with the sense each word is
  // still ALLOWED in, which is the half a flat list could not express — and `check:docs`
  // applies it to every page a user meets and to the help the binary actually PRINTS. One
  // implementation on purpose. This is the fast half: it needs no build, and it covers the
  // constants those help screens are rendered from.
  //
  // No package names are passed: a published package's name is legitimate on its own npm
  // page, and nothing in the help has cause to name one.
  for (const [name, copy] of [
    ["USAGE", USAGE],
    ["AUTONOMY_HELP", AUTONOMY_HELP],
    ...Object.entries(COMMAND_HELP),
  ] as [string, string][]) {
    expect(
      vocabularyLeaks(copy).map((f: { word: string; sentence: string }) => `${name}: [${f.word}] ${f.sentence}`),
      `${name} names a part of the machine where it could name what the product does`,
    ).toEqual([]);
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
