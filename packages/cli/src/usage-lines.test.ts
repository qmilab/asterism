// A usage line names its arguments the way its command's own help does — DERIVED, not
// listed.
//
// The usage line is what an operator reads at exactly the moment they are already
// confused: it prints on a missing positional and, since 0.8.0, on a refused option too.
// If it calls an argument something the help does not, the two surfaces they have just
// read disagree about what to type. `asterism fetch` did: its usage line said
// `<caller> <callee>` where its help, `docs/commands.md`, and every other exchange verb
// said `<from> <to>` (#162). `asterism config set` did worse — it printed two different
// usage lines depending on which mistake you made, one calling `--provider`'s value
// `<p>` and one `<name>`.
//
// Neither was reachable by reading one file. So this derives both halves:
//
//   - the usage lines the binary can be MADE to print, by typing malformed invocations
//     at every verb the help advertises;
//   - the usage lines the SOURCE contains, read out of `cli.ts`.
//
// Neither list is trusted. They are made to agree: a usage line in the source that no
// probe can trigger fails, which is what stops this from quietly covering half the
// surface as the CLI grows. (`check:docs` proves the same kind of claim about the docs
// by comparing two independent derivations; `release.yml`'s package list is checked the
// same way.)
//
// What this deliberately does NOT cover is the `Commands:` index in `asterism --help`.
// Its entries are not synopses: the block is a fixed two-column layout whose description
// column starts at 36, so every entry is written to a budget and two of them abbreviate
// rather than name — `api add <agent> <name> <url>` for `<https-url>`, and
// `connect <from> <to> --mode <m>` for the five-mode list. Both longer forms were measured
// against that budget and neither fits. Abbreviating in an index is not the defect this
// catches, which is a DIFFERENT NAME for the same argument in two places that both claim
// to say what to type.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { advertisedVerbs, makeRunner } from "./cli-surface.test-support.ts";

/** The option no command takes — one of the two ways to make a usage line print. */
const BOGUS = "--nosuchflag";

/** Filler positionals, so a verb can be walked past each of its arity checks in turn. */
const DUMMIES = ["zzz", "yyy", "xxx"];

const cwd = mkdtempSync(join(tmpdir(), "asterism-usage-"));
const run = makeRunner(cwd);

/**
 * Run one probe with NO workspace present, and leave none behind.
 *
 * Every probe here is a malformed invocation typed at a real command, including verbs
 * that write files, install services and bind ports. What makes that safe is that none
 * of them can reach a store: every side-effecting verb goes through `withHomeStore`,
 * which fails before doing anything when there is no `.asterism/` to find. `asterism
 * init` is itself a probe and creates one, so it is removed immediately — otherwise the
 * probes that follow it would run against a live workspace, and `asterism serve zzz`
 * would stop being a usage-line probe and start being a server.
 *
 * The invariant is asserted at the end, not just described: the directory is empty.
 */
async function probe(argv: string[]): Promise<string> {
  const { text } = await run(argv);
  rmSync(join(cwd, ".asterism"), { recursive: true, force: true });
  return text;
}

/** Every `Usage: asterism …` line in some output. */
function usageLinesIn(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("Usage: asterism"));
}

/**
 * Every usage line the binary can be made to print, mapped to the invocations that
 * printed it.
 *
 * The probe shapes are mechanical, and between them they walk each verb past every arity
 * check it has: the bare path, the path with an option it does not take, and the path
 * with one, two and three filler positionals. A verb whose subcommand comes AFTER the
 * agent (`trust <agent> threshold`, not `trust threshold <agent>`) needs the filler
 * FIRST, so those shapes are typed too.
 *
 * One shape is less obvious and was added because the coverage test below rejected the
 * set without it. A subcommand that refuses an option of its OWN prints its own usage
 * line — but only for an option the head verb accepted on the way past, since an option
 * NO form of the verb takes is refused first, by the head, with the head's usage. So the
 * options a head's help advertises are typed at each of its subcommands:
 * `asterism trust zzz threshold --review` is the only way to see the `threshold` usage
 * line, and typing `--nosuchflag` there never will.
 */
async function collectUsageLines(): Promise<Map<string, string[]>> {
  const verbs = await advertisedVerbs(run);
  const heads = [...new Set(verbs.map((v) => v.split(" ")[0]!))];
  const headFlags = new Map<string, string[]>();
  for (const head of heads) {
    const help = (await run([head, "--help"])).text;
    headFlags.set(head, [...new Set(help.match(/--[a-z][\w-]*/g) ?? [])]);
  }
  const found = new Map<string, string[]>();
  const record = (line: string, invocation: string): void => {
    const seen = found.get(line);
    if (seen) seen.push(invocation);
    else found.set(line, [invocation]);
  };
  const shapes: string[][] = [];
  // A bare head, so an aggregate usage line (`asterism notes <inspect|set|…>`) — printed
  // when the subcommand itself is missing or unrecognized — is reachable at all.
  for (const head of heads) shapes.push([head], [head, BOGUS], [head, DUMMIES[0]!]);
  for (const verb of verbs) {
    const path = verb.split(" ");
    shapes.push(path, [...path, BOGUS]);
    for (let n = 1; n <= DUMMIES.length; n++) shapes.push([...path, ...DUMMIES.slice(0, n)]);
    if (path.length === 2) {
      const [head, sub] = path as [string, string];
      shapes.push([head, DUMMIES[0]!, sub], [head, DUMMIES[0]!, sub, BOGUS]);
      shapes.push([head, DUMMIES[0]!, sub, DUMMIES[1]!]);
      for (const flag of headFlags.get(head) ?? []) {
        shapes.push([head, sub, flag], [head, DUMMIES[0]!, sub, flag]);
        // …and each flag WITH a value. Every value-bearing option is now refused before
        // the positional check (#174), so a bare flag stops at "The --x option needs a
        // value" and a usage line behind it stops being reachable — which is how this
        // probe set quietly lost `api add`'s. A flag that carries something gets past the
        // option check and reaches the arity complaint the line belongs to.
        shapes.push(
          [head, sub, flag, DUMMIES[0]!],
          [head, DUMMIES[0]!, sub, flag, DUMMIES[1]!],
        );
      }
    }
  }
  for (const shape of shapes) {
    for (const line of usageLinesIn(await probe(shape))) record(line, shape.join(" "));
  }
  return found;
}

/**
 * Every `Usage: asterism …` string literal in `cli.ts`, as a pattern.
 *
 * A few are template literals whose command or values are interpolated
 * (`` `Usage: asterism ${verb} <from> <to> <endpoint>` ``, and the two provider lists),
 * so a literal is compared as a regex with each `${…}` standing for "something". That is
 * what lets a source line covering three verbs be matched by the three lines the binary
 * actually prints.
 *
 * Reading the source is deliberate. The alternative — asserting a count — cannot tell a
 * usage line nothing triggers from one that does not exist.
 */
function sourceUsagePatterns(): { text: string; pattern: RegExp }[] {
  const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  // A usage line wrapped across two source lines is written as `"…" + "…"`; join those
  // first so it reads as the one string the operator sees.
  const joined = source.replace(/(["'])\s*\+\s*\n\s*\1/g, "");
  const literals = [...joined.matchAll(/(["'`])(Usage: asterism[\s\S]*?)\1/g)].map((m) => m[2]!);
  return [...new Set(literals)].map((text) => ({
    text,
    pattern: new RegExp(
      `^${text
        .split(/\$\{[^}]*\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".+")}$`,
    ),
  }));
}

/** The `<…>` placeholders in a usage or synopsis line. */
function placeholders(line: string): string[] {
  return [...new Set(line.match(/<[^<>]+>/g) ?? [])];
}

/** The synopsis of a command's own help: its lines before the first blank one. */
function synopsisOf(helpText: string): string {
  const lines = helpText.split("\n");
  const end = lines.findIndex((l) => l.trim() === "");
  return lines.slice(0, end === -1 ? lines.length : end).join("\n");
}

/**
 * Whether a usage placeholder is accounted for by the command's own help.
 *
 * Two ways, and the second is a rule rather than an exception because three usage lines
 * need it:
 *
 *  1. The help's SYNOPSIS uses the same placeholder. This is the ordinary case, and the
 *     one `fetch` failed.
 *  2. The placeholder spells out the VALUES where the synopsis names the argument —
 *     `asterism trust <agent> <propose|notify|autonomous>` against a synopsis that says
 *     `<level>`, and the same for the `objective` and `notes` aggregate lines. Spelling
 *     out what a one-line usage accepts is a refinement of a named argument, not a second
 *     name for it, so it passes when every alternative is a value the command's help
 *     documents.
 *
 * Placeholders are stripped from the help before looking for those values, or the rule
 * would be vacuous: `<name|path>` would find both of its own words inside itself.
 *
 * A stated limit: the synopsis compared against is the whole of the verb's, not the one
 * form the usage line names, so a line borrowing a SIBLING form's placeholder would pass.
 * That is deliberate rather than an oversight — several usage lines cover every form of
 * their verb in one line (`asterism trust <agent> <propose|notify|autonomous>  ·  --review
 *  ·  show  ·  revoke <capability>  ·  threshold`) and cannot be attributed to one of
 * them. What this does catch is the defect that actually happened twice: a word that
 * appears nowhere in the verb's help at all.
 */
function accountedFor(placeholder: string, synopsis: string, fullHelp: string): boolean {
  if (synopsis.includes(placeholder)) return true;
  const alternatives = placeholder.slice(1, -1).split("|");
  if (alternatives.length < 2) return false;
  const prose = fullHelp.replace(/<[^<>]+>/g, " ");
  return alternatives.every((value) =>
    new RegExp(`(^|[^\\w-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(prose),
  );
}

/**
 * Usage lines that deliberately name an argument something their help does not, with the
 * reason. Both are the chat channels: ONE synopsis covers the pair
 * (`asterism channel <telegram|discord> <agent> [--allow <id>[,<id>...]]`), so it has to
 * generalize where each channel's own usage line can say which id it means. A Telegram
 * chat id and a Discord channel id are different things, and `<id>` is their
 * generalization rather than a third name for either.
 *
 * Checked in both directions below, so an entry cannot outlive its reason.
 */
const DELIBERATELY_MORE_SPECIFIC: Readonly<Record<string, string[]>> = {
  "Usage: asterism channel telegram <agent> [--allow <chat-id>[,<chat-id>...]]": ["<chat-id>"],
  "Usage: asterism channel discord <agent> [--allow <channel-id>[,<channel-id>...]]": [
    "<channel-id>",
  ],
};

describe("every usage line names its arguments the way its own help does", () => {
  test("the usage lines derive from the binary, and cover every one in the source", async () => {
    const collected = await collectUsageLines();
    const patterns = sourceUsagePatterns();

    // A usage line in the source that no probe could trigger. Either the probe shapes no
    // longer reach it — in which case the tests below are silently checking less than
    // they claim — or nothing prints it at all.
    const untriggered = patterns
      .filter(({ pattern }) => ![...collected.keys()].some((line) => pattern.test(line)))
      .map(({ text }) => `  ${text}`);
    expect(untriggered.join("\n")).toBe("");

    // And the other direction: a printed usage line the source scan did not find means
    // the scan is reading less than the binary prints, so the coverage claim above is
    // about the wrong corpus.
    const unmatched = [...collected.keys()]
      .filter((line) => !patterns.some(({ pattern }) => pattern.test(line)))
      .map((line) => `  ${line}`);
    expect(unmatched.join("\n")).toBe("");

    // Enough of both to be a real sweep rather than a derivation that found nothing.
    expect(patterns.length).toBeGreaterThan(50);
    expect(collected.size).toBeGreaterThan(50);
  });

  test("every placeholder a usage line uses, its command's own help uses too", async () => {
    const collected = await collectUsageLines();
    const disagreements: string[] = [];
    let checked = 0;
    for (const [line, invocations] of collected) {
      const head = line.slice("Usage: asterism ".length).split(/\s+/)[0]!;
      const help = (await run([head, "--help"])).text;
      // A head with no help of its own would make the comparison vacuous — it would fall
      // back to the root usage, which names no placeholders at all.
      expect({ head, hasOwnHelp: help.startsWith(`asterism ${head}`) }).toEqual({
        head,
        hasOwnHelp: true,
      });
      const synopsis = synopsisOf(help);
      const exempt = DELIBERATELY_MORE_SPECIFIC[line] ?? [];
      for (const placeholder of placeholders(line)) {
        checked++;
        if (exempt.includes(placeholder)) continue;
        if (accountedFor(placeholder, synopsis, help)) continue;
        disagreements.push(
          `  ${placeholder} in\n    ${line}\n` +
            `  is not in \`asterism ${head} --help\`:\n    ${synopsis.split("\n")[0]}\n` +
            `  printed by: asterism ${invocations[0]}`,
        );
      }
    }
    expect(disagreements.join("\n")).toBe("");
    expect(checked).toBeGreaterThan(60);
  });

  test("no usage line is exempted that has started agreeing with its help", async () => {
    const collected = await collectUsageLines();
    const stale: string[] = [];
    for (const [line, exempt] of Object.entries(DELIBERATELY_MORE_SPECIFIC)) {
      if (!collected.has(line)) {
        stale.push(`  no longer printed, so the exemption is dead:\n    ${line}`);
        continue;
      }
      const head = line.slice("Usage: asterism ".length).split(/\s+/)[0]!;
      const help = (await run([head, "--help"])).text;
      const synopsis = synopsisOf(help);
      for (const placeholder of exempt) {
        if (!placeholders(line).includes(placeholder)) {
          stale.push(`  ${placeholder} is no longer in\n    ${line}`);
        } else if (accountedFor(placeholder, synopsis, help)) {
          stale.push(`  ${placeholder} agrees with the help now; drop the exemption:\n    ${line}`);
        }
      }
    }
    expect(stale.join("\n")).toBe("");
  });

  test("no probe reached a workspace, so none of them could act", () => {
    // The safety property `probe` relies on, asserted rather than described. An empty
    // directory means no probe wrote anything: not a store, not a service, not a file.
    expect(existsSync(join(cwd, ".asterism"))).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));
});
