import { expect, test } from "bun:test";

import { helpRequested, intFlag, parseArgs, stringFlag } from "./args.ts";

test("collects positionals", () => {
  const { positionals, flags } = parseArgs(["new", "personal"]);
  expect(positionals).toEqual(["new", "personal"]);
  expect(flags).toEqual({});
});

test("value-bearing long flag consumes the next token", () => {
  const { positionals, flags } = parseArgs(["personal", "--trust", "autonomous"]);
  expect(positionals).toEqual(["personal"]);
  expect(flags.trust).toBe("autonomous");
});

test("inline --flag=value form", () => {
  const { flags } = parseArgs(["--soul=careful-consultant"]);
  expect(flags.soul).toBe("careful-consultant");
});

test("declared boolean flag does not swallow the following token", () => {
  const { positionals, flags } = parseArgs(["agent", "--review"], ["review"]);
  expect(positionals).toEqual(["agent"]);
  expect(flags.review).toBe(true);
});

test("a long flag with no value becomes boolean true", () => {
  const { flags } = parseArgs(["--help"]);
  expect(flags.help).toBe(true);
});

test("short flags are boolean", () => {
  const { flags } = parseArgs(["-h"]);
  expect(flags.h).toBe(true);
});

test("-- ends flag parsing", () => {
  const { positionals, flags } = parseArgs(["run", "agent", "--", "--not-a-flag"]);
  expect(positionals).toEqual(["run", "agent", "--not-a-flag"]);
  expect(flags).toEqual({});
});

test("stringFlag / intFlag / helpRequested helpers", () => {
  expect(stringFlag("x")).toBe("x");
  expect(stringFlag(true)).toBeUndefined();
  expect(stringFlag(undefined)).toBeUndefined();
  expect(intFlag("12")).toBe(12);
  expect(intFlag("nope")).toBeUndefined();
  expect(intFlag(true)).toBeUndefined();
  expect(helpRequested(parseArgs(["-h"]))).toBe(true);
  expect(helpRequested(parseArgs(["x"]))).toBe(false);
});
