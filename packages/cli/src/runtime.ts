// Runtime-neutral surface I/O for the CLI binary: reading piped stdin and asking
// an interactive line. The published bin runs under Node (its shebang), but is
// equally run under Bun; both helpers below use only Node-stable APIs that Bun
// implements, so no Bun-only global reaches any code path. (These replace the
// earlier `Bun.stdin.text()` and the Bun/browser global `prompt()`.)

import { createInterface } from "node:readline/promises";
import { text } from "node:stream/consumers";

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
