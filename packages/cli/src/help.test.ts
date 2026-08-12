import { expect, test } from "bun:test";

import { AUTONOMY_HELP, COMMAND_HELP, USAGE } from "./help.ts";
import { formatStandingList } from "./format.ts";

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
