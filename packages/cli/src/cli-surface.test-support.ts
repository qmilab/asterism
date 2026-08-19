// Shared derivation of the CLI's advertised surface, for tests that make a claim about
// ALL of it. Not a test file and not shipped: `tsconfig.json` excludes it alongside
// `*.test.ts`, so it is compiled by neither `tsc -b` nor the published build.
//
// It lives here because two tests now assert something about every invocation the binary
// advertises — that each refuses an option it does not take (`unknown-flags.test.ts`),
// and that each names its arguments the same way twice (`usage-lines.test.ts`) — and a
// second copy of the derivation is a second thing to get wrong. The pinning assertions
// that keep it honest stay in `unknown-flags.test.ts`, where they already were.

import { runCli } from "./cli.ts";
import type { CliIO } from "./cli.ts";
import { findHome } from "./paths.ts";

/** One CLI invocation: its exit code and everything it printed, out and err interleaved. */
export type Run = (argv: string[]) => Promise<{ code: number; text: string }>;

/**
 * Runs the CLI in `cwd`, with an empty environment and NO workspace in reach.
 *
 * Both callers sweep every advertised verb with malformed arguments, which means typing at
 * commands that write files, install services and bind ports. What keeps that harmless is
 * that none of them can find a store: they fail at `withHomeStore` before doing anything.
 *
 * That is a precondition, not a property of `cwd` being fresh — `findHome` walks UP the way
 * git finds a repository root, so an `asterism init` run once in `/tmp` (or any ancestor of
 * the system temp directory) would put a live install in reach of every probe. It is checked
 * here rather than assumed, because the failure it prevents is a sweep quietly acting on a
 * real workspace, not a test going red. A test that genuinely wants a workspace should build
 * its own IO rather than loosen this.
 */
export function makeRunner(cwd: string): Run {
  const inherited = findHome(cwd);
  if (inherited !== undefined) {
    throw new Error(
      `Refusing to sweep the CLI from ${cwd}: an Asterism workspace at ${inherited} is in ` +
        `reach of every probe, so a malformed invocation could act on a real install. ` +
        `Remove it, or point TMPDIR somewhere without one above it.`,
    );
  }
  return async (argv) => {
    const lines: string[] = [];
    const io: CliIO = { cwd, env: {}, out: (t) => lines.push(t), err: (t) => lines.push(t) };
    const code = await runCli(argv, io);
    return { code, text: lines.join("\n") };
  };
}

/** A token that is a bare word — a subcommand by construction, where a placeholder is not. */
const isWord = (token: string | undefined): boolean =>
  token !== undefined && /^[a-z][\w-]*$/.test(token);

/**
 * Every invocation `asterism --help` advertises, plus the sibling subcommands each verb's
 * OWN help lists — so `config unset` and `service uninstall`, which the root help never
 * names, are covered too.
 *
 * Root form: a `Commands:` line is two-space indented, and a bare lower-case second word
 * IS a subcommand by construction (`capabilities show <agent>`) where a placeholder is not
 * (`run <agent> "<task>"`).
 *
 * Per-verb form: a synopsis line begins `asterism <verb> …`; the subcommand is the first
 * token after the verb when that token is a bare word (`config set <model-id>`), or the
 * second when the first is a placeholder (`trust <agent> threshold`). Reading past that
 * would mistake a VALUE for a verb — `config recall-provider <agent> local`.
 */
export async function advertisedVerbs(run: Run): Promise<string[]> {
  const helpText = async (verb: readonly string[]): Promise<string> =>
    (await run([...verb, "--help"])).text;
  const root = await helpText([]);
  const block = root.split(/^Commands:$/m)[1]?.split(/^\S/m)[0] ?? "";
  const verbs = new Set<string>();
  const heads = new Set<string>();
  for (const line of block.split("\n")) {
    const m = line.match(/^ {2}([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/);
    if (!m) continue;
    heads.add(m[1]!);
    verbs.add(m[2] ? `${m[1]} ${m[2]}` : m[1]!);
  }
  for (const head of heads) {
    for (const line of (await helpText([head])).split("\n")) {
      const m = line.match(new RegExp(`^asterism\\s+${head}\\s+(.*)$`));
      if (!m) continue;
      const [first, second] = m[1]!.trim().split(/\s+/);
      const sub = isWord(first) ? first : isWord(second) ? second : undefined;
      if (sub) verbs.add(`${head} ${sub}`);
    }
  }
  return [...verbs].sort();
}
