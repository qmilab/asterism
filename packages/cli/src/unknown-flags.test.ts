// Every advertised verb refuses an option it does not take — DERIVED, not listed.
//
// The list of verbs comes from the binary's own help, the way `check:docs`' command
// coverage pass derives it, because a hand-kept list of "verbs that reject" is exactly
// what came up short three times on #139: five verbs guarded, thirty-five not, and the
// gap invisible from inside the file. A verb added tomorrow appears here the moment it
// appears in `asterism --help`, and fails until it refuses.
//
// Two directions are checked, and the second is what keeps the exemption list from
// rotting: a verb that must refuse and does not is a failure, AND a verb exempted here
// that has started refusing is also a failure — so the exemption can never outlive its
// reason.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { advertisedVerbs as deriveVerbs, makeRunner } from "./cli-surface.test-support.ts";

/** The option no command takes, typed at every verb. */
const BOGUS = "--nosuchflag";

async function run(cwd: string, argv: string[]): Promise<{ code: number; text: string }> {
  return makeRunner(cwd)(argv);
}

/** The `Commands:` block of `asterism --help`, which is the advertised surface. */
async function helpText(cwd: string, verb: readonly string[]): Promise<string> {
  return (await run(cwd, [...verb, "--help"])).text;
}

/**
 * Every invocation the binary's own help advertises. Derived in
 * `cli-surface.test-support.ts`, because `usage-lines.test.ts` needs the same list and
 * two copies of a derivation are two things to get wrong. The assertions that keep it
 * honest are below, where they always were.
 */
async function advertisedVerbs(cwd: string): Promise<string[]> {
  return deriveVerbs(makeRunner(cwd));
}

/**
 * The flags one invocation's own synopsis advertises.
 *
 * Refusing what a command does not take is only half a claim; the other half is that it
 * still takes everything it advertises, and a declaration that drops a flag breaks that
 * silently — the flag simply starts being refused. Deriving the list from the binary's
 * own synopsis covers every documented flag, where a hand-written list covers the ones
 * whoever wrote it remembered.
 *
 * Which line belongs to which invocation follows the same rule the verb derivation uses:
 * the first BARE word in the remainder is the subcommand the line is about, and its
 * absence means the line is about the head verb. Matching on prefix alone instead reads
 * every `asterism config <sub>` line as a line about bare `config`, and then demands
 * that `config` accept `--provider`.
 */
function synopsisFlags(helpText: string, invocation: string): { flags: string[]; named: boolean } {
  const lines = helpText.split("\n");
  const end = lines.findIndex((l) => l.trim() === "");
  const synopsis = lines.slice(0, end === -1 ? lines.length : end);
  const [head, sub] = invocation.split(" ");
  const flags: string[] = [];
  let taking = false;
  let named = false;
  for (const line of synopsis) {
    const m = line.match(new RegExp(`^asterism\\s+${head}\\b(.*)$`));
    if (m) {
      const lineSub = m[1]!.trim().split(/\s+/).find((t) => /^[a-z][\w-]*$/.test(t));
      taking = lineSub === sub;
      if (taking) named = true;
    } else if (line.startsWith("asterism ")) taking = false;
    else if (!/^\s/.test(line)) taking = false; // an indented line continues the one above
    if (taking) flags.push(...(line.match(/--[a-z][\w-]*/g) ?? []));
  }
  return { flags: [...new Set(flags)], named };
}

/**
 * Invocations no synopsis line names, so the check above has nothing to derive from.
 * Both are the chat channels, whose one synopsis covers the pair as
 * `asterism channel <telegram|discord> <agent> [--allow …]`. Their `--allow` is covered
 * by `outbound-surfaces.test.ts`, which types it end to end on both.
 *
 * Recorded rather than skipped quietly, and checked in both directions below — a
 * synopsis rewritten to name them must shrink this list.
 */
const NO_SYNOPSIS_OF_ITS_OWN = ["channel discord", "channel telegram"];

/**
 * The verbs that take their tail RAW and so cannot refuse a flag-shaped token — it is
 * the operator's own text, and eating it would hand an agent a different task than the
 * one typed. None of them reaches `parseArgs` at all.
 *
 * That this is the real reason, and not an alibi for a verb someone forgot, is proven
 * elsewhere: `cli.test.ts` runs a dash-leading tail end to end through `objective add`,
 * `handoff`, `artifact`, `summary` and `brief` and reads it back verbatim from the
 * kernel. The `notes` verbs share `objective`'s raw-args dispatch and `secrets add` the
 * same discipline for verbatim secret material.
 *
 * The third test below keeps the list honest in the other direction: an entry that has
 * started refusing, or that the help no longer advertises, fails.
 */
const FREE_FORM = new Set([
  "secrets add", // [value] — verbatim secret material
  "objective add", // "<text>"
  "objective list",
  "objective done",
  "objective drop",
  "notes inspect",
  "notes set", // "<subject>" "<value>"
  "notes clear",
  "notes accept",
  "notes reject",
  "handoff", // "<task>"
  "artifact", // "<task>"
  "summary", // ["<focus>"]
  "brief", // "<brief>"
]);

describe("every advertised verb refuses an option it does not take", () => {
  const cwd = mkdtempSync(join(tmpdir(), "asterism-flags-"));

  test("the verb list derives from the binary's own help", async () => {
    const verbs = await advertisedVerbs(cwd);
    // Not an assertion about WHICH verbs — that is derived. Only that the derivation
    // found the surface rather than an empty block, and that it reached past the root
    // help into each verb's own (which is where `config unset` lives).
    expect(verbs.length).toBeGreaterThan(40);
    expect(verbs).toContain("config unset");
    expect(verbs).toContain("service uninstall");
    expect(verbs).toContain("trust threshold");
    expect(verbs).toContain("capabilities remove");
  });

  test("each one names the option and exits non-zero", async () => {
    const verbs = await advertisedVerbs(cwd);
    const missed: string[] = [];
    for (const verb of verbs) {
      if (FREE_FORM.has(verb)) continue;
      const { code, text } = await run(cwd, [...verb.split(" "), BOGUS]);
      if (code === 0 || !text.includes(`does not take ${BOGUS}`)) {
        missed.push(`  asterism ${verb} ${BOGUS}\n    → exit ${code}: ${text.split("\n")[0]}`);
      }
    }
    expect(missed.join("\n")).toBe("");
  });

  test("no free-form verb is exempted that has started refusing", async () => {
    const verbs = new Set(await advertisedVerbs(cwd));
    const stale: string[] = [];
    for (const verb of FREE_FORM) {
      // An exemption for a verb the help no longer advertises is stale on its own.
      if (!verbs.has(verb)) {
        stale.push(`  ${verb} — no longer advertised`);
        continue;
      }
      const { text } = await run(cwd, [...verb.split(" "), BOGUS]);
      if (text.includes(`does not take ${BOGUS}`)) {
        stale.push(`  ${verb} — refuses now; drop the exemption`);
      }
    }
    expect(stale.join("\n")).toBe("");
  });

  test("every flag a verb's own synopsis advertises is still accepted by it", async () => {
    const verbs = await advertisedVerbs(cwd);
    const refused: string[] = [];
    const unnamed: string[] = [];
    let typed = 0;
    for (const verb of verbs) {
      const path = verb.split(" ");
      const { flags, named } = synopsisFlags(await helpText(cwd, path), verb);
      if (!named) unnamed.push(verb);
      for (const flag of flags) {
        typed++;
        const { text } = await run(cwd, [...path, flag]);
        if (text.includes(`does not take ${flag}`)) refused.push(`  asterism ${verb} ${flag}`);
      }
    }
    expect(refused.join("\n")).toBe("");
    // Enough flags to be a real sweep, not a derivation that quietly found nothing.
    expect(typed).toBeGreaterThan(40);
    // And what it could NOT derive is named, not silently dropped.
    expect(unnamed.sort()).toEqual(NO_SYNOPSIS_OF_ITS_OWN);
  });

  test("every option that refuses a MISSING value refuses an EMPTY one the same way", async () => {
    // The other half of "an option you typed is not discarded in silence" (#174). An
    // option given no value at all parses as boolean `true` and has been refused since
    // 0.8.0; an option given an EMPTY value — what `--host "$HOST"` expands to with the
    // variable unset or cleared — fell through as a real value, and what happened next
    // varied by verb. `config set gpt-4o --provider ""` wrote it to the config file;
    // `new bot --model ""` wrote a per-agent override that shadows the install default
    // with nothing; `serve writer --host ""` bound `::`, every interface, where the
    // documented default is loopback.
    //
    // Which options take a value is DERIVED from the binary, not listed: an option whose
    // bare form says it needs one is an option that takes one. So a flag added tomorrow
    // is covered the moment it refuses a missing value, and no list can fall behind.
    const verbs = await advertisedVerbs(cwd);
    const missed: string[] = [];
    const seen: string[] = [];
    let checked = 0;
    for (const verb of verbs) {
      const path = verb.split(" ");
      const { flags } = synopsisFlags(await helpText(cwd, path), verb);
      for (const flag of flags) {
        const bare = await run(cwd, [...path, flag]);
        // Not a value-bearing option — a genuine boolean (`--review`, `--follow`,
        // `--unset`, `--headless`). Nothing to give an empty value to.
        if (bare.code === 0 || !/needs a value/.test(bare.text)) continue;
        checked++;
        seen.push(`${verb} ${flag}`);
        const empty = await run(cwd, [...path, flag, ""]);
        // The SAME first line, not merely a non-zero exit: the two are one mistake, and
        // a verb that refuses the empty form for some other reason (an unknown enum
        // value, say) is describing the expansion instead of the mistake.
        const same = empty.text.split("\n")[0] === bare.text.split("\n")[0];
        if (empty.code === 0 || !same) {
          missed.push(
            `  asterism ${verb} ${flag} ""\n    → exit ${empty.code}: ${empty.text.split("\n")[0]}` +
              `\n    (bare form said: ${bare.text.split("\n")[0]})`,
          );
        }
      }
    }
    expect(missed.join("\n")).toBe("");
    // A derivation that found nothing would pass the assertion above over zero options —
    // and one that quietly found FEWER would pass it too. So: a floor on the count, and
    // the options whose empty form actually did damage, named. A verb that starts
    // checking its positionals before its options drops out of this sweep silently, which
    // is how four of these were missed on the first pass.
    expect(checked).toBeGreaterThan(20);
    expect(seen).toEqual(
      expect.arrayContaining([
        "new --soul", // resolved an empty path as a soul directory
        "new --model", // wrote an override that shadows the install default with nothing
        "new --trust",
        "config set --provider", // wrote `"provider": ""`, then advised an untypeable command
        "config set --base-url", // shadowed a working provider default with nothing
        "serve --host", // bound `::` — every interface — instead of loopback
        "dashboard --host",
        "connect --mode", // grants a permissioned channel
        "disconnect --mode",
        "service install --kind",
        "memory inspect --type",
        "events tail --type",
      ]),
    );
  });

  test("the refusal comes before the usage complaint, so it names the real mistake", async () => {
    // The option check runs first everywhere. Without that, a verb missing its
    // positionals reports the positional — sending the operator to look for a value
    // they typed rather than the option they misspelled.
    const { text } = await run(cwd, ["connect", BOGUS]);
    expect(text.split("\n")[0]).toContain(`does not take ${BOGUS}`);
  });

  test("--help still wins over a bad option, on every verb", async () => {
    for (const verb of await advertisedVerbs(cwd)) {
      if (FREE_FORM.has(verb)) continue;
      const { code, text } = await run(cwd, [...verb.split(" "), "--help", BOGUS]);
      // Matched against the option itself, not the phrase: `AUTONOMY_HELP` legitimately
      // says "a 'propose' agent does not take one at all", and a looser match read that
      // as a refusal on every verb whose help carries it.
      expect({ verb, code, refused: text.includes(`does not take ${BOGUS}`) }).toEqual({
        verb,
        code: 0,
        refused: false,
      });
    }
  });

  test("passthrough after `--` is never read as the verb's own option", async () => {
    // `service install <agent> -- --port 8080` forwards `--port` to the supervised
    // command. It is split off before parsing, so it can never be refused here.
    const { text } = await run(cwd, ["service", "install", "writer", "--", "--port", "8080"]);
    expect(text).not.toContain("does not take --port");
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));
});
