// Runtime-neutral surface I/O for the CLI binary: reading piped stdin, asking an
// interactive line, and asking for one without echoing it. The published bin runs
// under Node (its shebang), but is equally run under Bun; every helper below uses
// only Node-stable APIs that Bun implements, so no Bun-only global reaches any code
// path. (These replace the earlier `Bun.stdin.text()` and the Bun/browser global
// `prompt()`.)

import { createInterface } from "node:readline/promises";
import { text } from "node:stream/consumers";
import { Writable } from "node:stream";

/**
 * Read all of piped stdin as text, VERBATIM — no trimming, because a piped secret
 * (PEM/private-key material, an intentionally padded token) must be stored exactly
 * as given. Returns undefined for an interactive TTY, where there is no piped input
 * to consume and reading would block forever. Callers that want a trailing newline
 * dropped can pipe with `printf`/`echo -n`.
 */
export async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return text(process.stdin);
}

/**
 * Ask one interactive question and resolve the trimmed answer. Returns undefined
 * when stdin is not a TTY — a piped/non-interactive session has no one to answer,
 * so callers fall through to their safe default (stay paused / reject) rather than
 * blocking on input that will never come.
 */
export async function ask(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Ask for a secret VALUE at the terminal, without echoing what is typed.
 *
 * This is the one value path that leaves no trace outside the process: an inline
 * argument is visible in shell history and in `ps` output for as long as the command
 * runs, and an environment variable is readable by every child process. Typing it here
 * avoids both.
 *
 * Returns undefined unless stdin AND stderr are both terminals — the same
 * non-interactive signal the two helpers above use, widened by one end because this is
 * the only one of the three that has to be SEEN before it can be answered.
 *
 * Two mechanics that are not obvious:
 *
 * - Readline's echo is sent to a sink that discards it, and the question is written to
 *   STDERR by this function instead. That keeps the typed characters off the screen, and
 *   it puts the prompt where a human can see it even when stdout is redirected to a file.
 * - `rl.question()` never settles if the stream ends first, so a Ctrl-D would otherwise
 *   leave the CLI awaiting an answer that cannot arrive, and the process would exit 0
 *   having stored nothing. Racing the answer against `close` turns that into undefined,
 *   which the caller reports.
 */
export async function askSecret(question: string): Promise<string | undefined> {
  // Both ends: something to read the answer from, and somewhere the question can be seen.
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  // Everything readline would echo goes here and is dropped.
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  try {
    process.stderr.write(`${question} `);
    const closed = new Promise<undefined>((resolve) => rl.once("close", () => resolve(undefined)));
    const answer = await Promise.race([rl.question(""), closed]);
    // The terminator is echoed nowhere, so end the prompt line here — otherwise whatever
    // is printed next continues the line the human was typing on.
    process.stderr.write("\n");
    // The line as typed, minus the terminator readline already removed. What an empty or
    // blank answer MEANS is the caller's to decide, not this function's.
    return answer;
  } finally {
    rl.close();
  }
}
