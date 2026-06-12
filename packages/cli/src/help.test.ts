import { expect, test } from "bun:test";

import { AUTONOMY_HELP, COMMAND_HELP, USAGE } from "./help.ts";

test("usage lists every command in the surface", () => {
  for (const command of [
    "init",
    "new",
    "list",
    "trust",
    "secrets add",
    "skill add",
    "run",
    "confirm",
    "runs <agent>",
    "memory inspect",
    "events tail",
    "reflect",
    "serve",
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

test("help describes the destructive-action confirmation gate", () => {
  expect(AUTONOMY_HELP).toContain("destructive");
  expect(AUTONOMY_HELP).toContain("confirmation");
});

test("public copy carries no internal architecture vocabulary", () => {
  const allCopy = [USAGE, AUTONOMY_HELP, ...Object.values(COMMAND_HELP)].join("\n");
  for (const forbidden of [/\bkernel\b/i, /\badapter\b/i, /\bfirewall\b/i, /\bregistry\b/i, /\bsubstrate\b/i]) {
    expect(allCopy).not.toMatch(forbidden);
  }
});
