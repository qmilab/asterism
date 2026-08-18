import { expect, test } from "bun:test";

import { helpRequested, intFlag, parseArgs, stringFlag, undeclaredOptions } from "./args.ts";

test("collects positionals", () => {
  const { positionals, flags, unknown } = parseArgs(["new", "personal"]);
  expect(positionals).toEqual(["new", "personal"]);
  expect(flags).toEqual({});
  expect(unknown).toEqual([]);
});

test("declared value flag consumes the next token", () => {
  const { positionals, flags } = parseArgs(["personal", "--trust", "autonomous"], {
    values: ["trust"],
  });
  expect(positionals).toEqual(["personal"]);
  expect(flags.trust).toBe("autonomous");
});

test("inline --flag=value form", () => {
  const { flags } = parseArgs(["--soul=careful-consultant"], { values: ["soul"] });
  expect(flags.soul).toBe("careful-consultant");
});

test("declared boolean flag does not swallow the following token", () => {
  const { positionals, flags } = parseArgs(["agent", "--review"], { booleans: ["review"] });
  expect(positionals).toEqual(["agent"]);
  expect(flags.review).toBe(true);
});

test("a negative number is taken as a flag value, not a flag", () => {
  // Telegram group ids are negative; `--allow -100123` must bind the id.
  const spec = { values: ["allow"] } as const;
  expect(parseArgs(["--allow", "-100123"], spec).flags.allow).toBe("-100123");
  expect(parseArgs(["--allow", "-100,-200"], spec).flags.allow).toBe("-100,-200");
  // A "-" followed by a non-digit is still another flag, so the value-less flag
  // stays boolean true.
  expect(parseArgs(["--allow", "--other"], spec).flags.allow).toBe(true);
});

test("a declared value flag with no value becomes boolean true", () => {
  // The call sites read this back as "the --x option needs a value".
  expect(parseArgs(["--port"], { values: ["port"] }).flags.port).toBe(true);
});

test("--help / -h are declared for every command without being listed", () => {
  expect(parseArgs(["--help"]).flags.help).toBe(true);
  expect(parseArgs(["-h"]).flags.h).toBe(true);
  expect(parseArgs(["--help", "-h"]).unknown).toEqual([]);
});

test("-- ends flag parsing", () => {
  const { positionals, flags, unknown } = parseArgs(["run", "agent", "--", "--not-a-flag"]);
  expect(positionals).toEqual(["run", "agent", "--not-a-flag"]);
  expect(flags).toEqual({});
  expect(unknown).toEqual([]);
});

test("an undeclared option is collected, not recorded as a flag", () => {
  const { positionals, flags, unknown } = parseArgs(["writer", "--mdoe", "handoff"], {
    values: ["mode"],
  });
  expect(unknown).toEqual(["--mdoe"]);
  expect(flags).toEqual({});
  // The value typed after it is NOT swallowed — it stays where the operator put it, so
  // the refusal can name the option alone instead of a positional that looks missing.
  expect(positionals).toEqual(["writer", "handoff"]);
});

test("an undeclared option is collected as typed, inline value stripped", () => {
  expect(parseArgs(["--tpye=semantic"], { values: ["type"] }).unknown).toEqual(["--tpye"]);
  expect(parseArgs(["-q"]).unknown).toEqual(["-q"]);
  expect(parseArgs(["--a", "--b"]).unknown).toEqual(["--a", "--b"]);
});

test("a dash-leading token with a space in it is text, not an option", () => {
  // One quoted argument, not two: `asterism run writer "--draft the proposal"`. An
  // option name never contains whitespace, so this is a positional — which is what
  // keeps the task the operator typed intact instead of refusing a whole sentence.
  const parsed = parseArgs(["writer", "--draft the proposal"], { values: ["draft"] });
  expect(parsed.positionals).toEqual(["writer", "--draft the proposal"]);
  expect(parsed.unknown).toEqual([]);
  expect(parsed.flags).toEqual({});
  // The test is on the NAME, so an inline value with spaces is still that option.
  expect(parseArgs(["--role=senior editor"], { values: ["role"] }).flags.role).toBe("senior editor");
});

test("a bare negative number stays a digit-keyed flag, never an undeclared option", () => {
  // `config recall-budget writer -5` — the parser has nowhere else to put it, and the
  // setter reads it back to reject the VALUE with its own message.
  const parsed = parseArgs(["recall-budget", "writer", "-5"], { booleans: ["unset"] });
  expect(parsed.unknown).toEqual([]);
  expect(parsed.flags["5"]).toBe(true);
  expect(parseArgs(["-2.5"]).flags["2.5"]).toBe(true);
  expect(undeclaredOptions(parsed, ["unset"])).toEqual([]);
});

test("undeclaredOptions names both the undeclared and the not-here-allowed", () => {
  // `config` parses one union for every subcommand; `recall-budget` narrows to its own.
  const parsed = parseArgs(["recall-budget", "writer", "--agent", "x", "--agnet", "y"], {
    booleans: ["unset", "default"],
    values: ["agent"],
  });
  expect(parsed.unknown).toEqual(["--agnet"]);
  expect(undeclaredOptions(parsed, ["unset", "default"])).toEqual(["--agnet", "--agent"]);
  // Allowed where the sibling verb takes it.
  expect(undeclaredOptions(parsed, ["agent"])).toEqual(["--agnet"]);
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
