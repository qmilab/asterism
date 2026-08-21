// Runtime-neutral surface I/O for the CLI binary: reading piped stdin, asking an
// interactive line, and asking for one without echoing it. The published bin runs
// under Node (its shebang), but is equally run under Bun; every helper below uses
// only Node-stable APIs that Bun implements, so no Bun-only global reaches any code
// path. (These replace the earlier `Bun.stdin.text()` and the Bun/browser global
// `prompt()`.)

import { createInterface } from "node:readline/promises";
import { text } from "node:stream/consumers";
import { Writable } from "node:stream";

/** A stream this module reads an answer from, or writes a question to. */
type MaybeTty = { isTTY?: boolean | undefined };

/** The pair of streams an interactive question is asked over. */
export interface AskStreams {
  input: NodeJS.ReadableStream & MaybeTty;
  output: NodeJS.WritableStream & MaybeTty;
}

/**
 * Where this process puts a question when the caller does not say: read the answer
 * from stdin, ask on STDERR.
 *
 * Stderr, not stdout, and this one declaration is why every prompt agrees about it. A
 * question is not the command's output: `asterism run … > out.txt` should keep the
 * agent's answer in the file and put the destructive-action confirmation on the
 * screen. Asking on stdout did the opposite — the question went into the file and the
 * run waited at a blank screen (#172).
 */
export const INTERACTIVE_STREAMS: AskStreams = {
  input: process.stdin,
  output: process.stderr,
};

/**
 * Whether this session can be ASKED a question: both something to read an answer
 * from, and somewhere the question can be SEEN.
 *
 * BOTH ends, because they are different file descriptors and a session can have one
 * without the other. Gating on stdin alone is how `asterism run … > out.txt` on a
 * terminal came to wait indefinitely for an answer to a destructive-action
 * confirmation that had gone into the file (#172) — a blank screen that reads as a
 * crash. The question is asked on {@link INTERACTIVE_STREAMS}`.output`, so that is the
 * end that has to be a terminal, not stdout.
 *
 * Exported because the binary wires its interactive hooks on the same answer. Those
 * hooks use ABSENCE as the "no human present" signal, and a hook wired against a
 * WIDER predicate than this one is worse than no hook at all: `reflect --review`'s
 * queue drain would then reach a reviewer that can never be asked, read every
 * unanswerable question as a reject, and durably reject the whole pile. One
 * predicate, called from both places, is what keeps them from drifting apart.
 */
export function hasAskableTerminal(
  streams: { input: MaybeTty; output: MaybeTty } = INTERACTIVE_STREAMS,
): boolean {
  return streams.input.isTTY === true && streams.output.isTTY === true;
}

/**
 * Read a rejected question as "no answer" when the terminal sent EOF, and re-throw
 * anything else.
 *
 * A readline in terminal mode does not merely CLOSE on Ctrl-D: it also rejects the
 * pending question with an `AbortError`. With nothing catching it that reached the top
 * level as an unhandled rejection and killed the process with a Node stack trace —
 * measured through a pty, at the destructive-action confirmation. Ctrl-D there is a
 * human declining to answer, which is exactly what undefined already means.
 *
 * Narrow on purpose: only `ABORT_ERR`. Any other rejection is a real failure and must
 * not be quietly turned into a decline — reading one as "the human said no" would hide
 * a bug behind the safest-looking outcome there is.
 *
 * Exported only so both branches can be pinned. No stream a test can build makes
 * readline reject with anything else (a destroyed input emits an unhandled `error`
 * event instead, measured), so through `ask` the widening `catch (…) => undefined`
 * would be indistinguishable from this one.
 */
export function noAnswerOnEof(err: unknown): undefined {
  if ((err as { code?: unknown } | null)?.code === "ABORT_ERR") return undefined;
  throw err;
}

/**
 * Read all of piped stdin as text, VERBATIM — no trimming, because a piped secret
 * (PEM/private-key material, an intentionally padded token) must be stored exactly
 * as given. Returns undefined for an interactive TTY, where there is no piped input
 * to consume and reading would block forever. Callers that want a trailing newline
 * dropped can pipe with `printf`/`echo -n`.
 *
 * Gates on stdin alone, unlike the two helpers below: this one asks nothing, so it
 * needs somewhere to read from and nowhere to be seen.
 */
export async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return text(process.stdin);
}

/**
 * Ask one interactive question and resolve the trimmed answer. Returns undefined
 * when there is no terminal to ask at ({@link hasAskableTerminal}) — nobody is there
 * to answer, so callers fall through to their safe default (stay paused / reject)
 * rather than blocking on input that will never come.
 *
 * The question and what is typed in reply both go to STDERR, not stdout. Two reasons:
 * a question is not the command's output, so `asterism run … > out.txt` keeps the
 * agent's answer in the file and puts the confirmation on the screen; and it matches
 * {@link askSecret}, so one rule covers every prompt this binary raises.
 *
 * `rl.question()` never settles if the stream ends first, so a Ctrl-D would otherwise
 * leave the caller awaiting an answer that cannot arrive; racing it against `close`
 * turns that into undefined, which every caller already treats as "no answer". A
 * terminal readline also REJECTS the pending question on Ctrl-D, which reached the
 * top level as an unhandled `AbortError` and killed the process with a stack trace —
 * so the rejection is caught here and read as the same "no answer".
 *
 * `streams` is for tests, which have no terminal of their own; the binary passes
 * nothing and gets stdin/stderr.
 */
export async function ask(
  question: string,
  streams: AskStreams = INTERACTIVE_STREAMS,
): Promise<string | undefined> {
  if (!hasAskableTerminal(streams)) return undefined;
  const { input, output } = streams;
  const rl = createInterface({ input, output });
  try {
    const closed = new Promise<undefined>((resolve) => rl.once("close", () => resolve(undefined)));
    const answer = await Promise.race([rl.question(`${question} `), closed]).catch(noAnswerOnEof);
    return answer?.trim();
  } finally {
    rl.close();
  }
}

/**
 * Ask for a secret VALUE at the terminal, without echoing what is typed.
 *
 * This path leaves the value nowhere but this process: an inline argument is visible in
 * shell history and in `ps` output for as long as the command runs, and an environment
 * variable is readable by every child process. Typing it here avoids both. (A pipe can
 * be equally clean, but only when whatever feeds it is — a file or an `echo` is not.)
 *
 * Returns undefined unless there is a terminal to ask at ({@link hasAskableTerminal}) —
 * the same signal {@link ask} uses, and for the same reason: this is a question, and a
 * question needs somewhere to be seen as well as somewhere to be answered.
 *
 * Three mechanics that are not obvious:
 *
 * - Readline's echo is sent to a sink that discards it, and the question is written to
 *   STDERR by this function instead. That keeps the typed characters off the screen, and
 *   it puts the prompt where a human can see it even when stdout is redirected to a file.
 * - `rl.question()` never settles if the stream ends first, so a Ctrl-D would otherwise
 *   leave the CLI awaiting an answer that cannot arrive, and the process would exit 0
 *   having stored nothing. Racing the answer against `close` turns that into undefined,
 *   which the caller reports.
 * - Readline's line history is switched off, so the answer is not retained in a buffer
 *   after it has been handed back.
 */
export async function askSecret(question: string): Promise<string | undefined> {
  // Both ends: something to read the answer from, and somewhere the question can be seen.
  if (!hasAskableTerminal()) return undefined;
  // Everything readline would echo goes here and is dropped.
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  // `historySize: 0` because readline otherwise keeps every answered line in an
  // in-memory `history` array — measured: the typed credential sat there in plaintext
  // for the rest of the process. Nothing here needs recall, and a masked prompt has
  // nothing useful to recall anyway.
  const rl = createInterface({
    input: INTERACTIVE_STREAMS.input,
    output: sink,
    terminal: true,
    historySize: 0,
  });
  try {
    // The one declaration of where a question goes, shared with `ask` — so the muted
    // prompt and the visible one can never end up on different descriptors.
    INTERACTIVE_STREAMS.output.write(`${question} `);
    const closed = new Promise<undefined>((resolve) => rl.once("close", () => resolve(undefined)));
    const answer = await Promise.race([rl.question(""), closed]).catch(noAnswerOnEof);
    // The terminator is echoed nowhere, so end the prompt line here — otherwise whatever
    // is printed next continues the line the human was typing on.
    INTERACTIVE_STREAMS.output.write("\n");
    // The line as typed, minus the terminator readline already removed. What an empty or
    // blank answer MEANS is the caller's to decide, not this function's.
    return answer;
  } finally {
    rl.close();
  }
}
