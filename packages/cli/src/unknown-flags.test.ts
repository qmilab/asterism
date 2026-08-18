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

import { runCli } from "./cli.ts";
import type { CliIO } from "./cli.ts";

/** The option no command takes, typed at every verb. */
const BOGUS = "--nosuchflag";

function makeIo(cwd: string): CliIO {
  return { cwd, env: {}, out: () => {}, err: () => {} };
}

async function run(cwd: string, argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const io: CliIO = { ...makeIo(cwd), out: (t) => lines.push(t), err: (t) => lines.push(t) };
  const code = await runCli(argv, io);
  return { code, text: lines.join("\n") };
}

/** The `Commands:` block of `asterism --help`, which is the advertised surface. */
async function helpText(cwd: string, verb: readonly string[]): Promise<string> {
  return (await run(cwd, [...verb, "--help"])).text;
}

/**
 * Every invocation `asterism --help` advertises, plus the sibling subcommands each
 * verb's OWN help lists — so `config unset` and `service uninstall`, which the root
 * help never names, are covered too.
 *
 * Root form: a `Commands:` line is two-space indented, and a bare lower-case second
 * word IS a subcommand by construction (`capabilities show <agent>`) where a
 * placeholder is not (`run <agent> "<task>"`).
 *
 * Per-verb form: a synopsis line begins `asterism <verb> …`; the subcommand is the
 * first token after the verb when that token is a bare word (`config set <model-id>`),
 * or the second when the first is a placeholder (`trust <agent> threshold`). Reading
 * past that would mistake a VALUE for a verb — `config recall-provider <agent> local`.
 */
async function advertisedVerbs(cwd: string): Promise<string[]> {
  const root = await helpText(cwd, []);
  const block = root.split(/^Commands:$/m)[1]?.split(/^\S/m)[0] ?? "";
  const verbs = new Set<string>();
  const heads = new Set<string>();
  for (const line of block.split("\n")) {
    const m = line.match(/^ {2}([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/);
    if (!m) continue;
    heads.add(m[1]!);
    verbs.add(m[2] ? `${m[1]} ${m[2]}` : m[1]!);
  }
  const isWord = (t: string | undefined): boolean => t !== undefined && /^[a-z][\w-]*$/.test(t);
  for (const head of heads) {
    for (const line of (await helpText(cwd, [head])).split("\n")) {
      const m = line.match(new RegExp(`^asterism\\s+${head}\\s+(.*)$`));
      if (!m) continue;
      const [first, second] = m[1]!.trim().split(/\s+/);
      const sub = isWord(first) ? first : isWord(second) ? second : undefined;
      if (sub) verbs.add(`${head} ${sub}`);
    }
  }
  return [...verbs].sort();
}

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
