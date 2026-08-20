// The interactive-question end of the binary's surface I/O (#172). What we pin: a
// question needs BOTH ends of a terminal, it is asked where a human can see it rather
// than on the command's own output, and an unanswerable session returns "no answer"
// instead of waiting for one.
//
// The streams are injected because a test process has no terminal of its own — a
// `PassThrough` with `isTTY` set is what a pty is to `ask`, and it lets the whole rule
// run under `bun test` rather than only under a hand-driven pty.

import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { ask, hasAskableTerminal, INTERACTIVE_STREAMS, type AskStreams } from "./runtime.ts";

/** A fake terminal end: a real stream, with `isTTY` as the caller wants it. */
function fakeTty(isTTY: boolean): PassThrough & { isTTY?: boolean } {
  const stream: PassThrough & { isTTY?: boolean } = new PassThrough();
  stream.isTTY = isTTY;
  return stream;
}

/** A stream pair plus what the output end was written. */
function terminal(inputTty: boolean, outputTty: boolean): {
  streams: AskStreams;
  written: () => string;
} {
  const input = fakeTty(inputTty);
  const output = fakeTty(outputTty);
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return { streams: { input, output }, written: () => written };
}

test("a question needs both ends: something to answer with AND somewhere to be seen", () => {
  // The four combinations, not just the two the bug was filed for. Only one can be asked.
  expect(hasAskableTerminal({ input: { isTTY: true }, output: { isTTY: true } })).toBe(true);
  expect(hasAskableTerminal({ input: { isTTY: true }, output: { isTTY: false } })).toBe(false);
  expect(hasAskableTerminal({ input: { isTTY: false }, output: { isTTY: true } })).toBe(false);
  expect(hasAskableTerminal({ input: { isTTY: false }, output: { isTTY: false } })).toBe(false);
  // A stream that says nothing about being a terminal is not one.
  expect(hasAskableTerminal({ input: {}, output: {} })).toBe(false);
});

test("a question's default destination is stderr, and its answer comes from stdin", () => {
  // The half the injected streams above cannot reach: which descriptors the BINARY gets
  // when it passes none. Asking on stdout is the whole of #172 — the confirmation went
  // into `run … > out.txt` and the run waited at a blank screen — so the destination is
  // declared once, here, and both prompts read it from the same place.
  expect(INTERACTIVE_STREAMS.output).toBe(process.stderr);
  expect(INTERACTIVE_STREAMS.output).not.toBe(process.stdout);
  expect(INTERACTIVE_STREAMS.input).toBe(process.stdin);
});

test("the answer typed at the terminal comes back trimmed", async () => {
  const { streams } = terminal(true, true);
  const answered = ask("Confirm destructive action 'file.delete'? [y/N]", streams);
  (streams.input as PassThrough).write("  y  \n");
  expect(await answered).toBe("y");
});

test("the question is written where the human is, not onto the command's output", async () => {
  const { streams, written } = terminal(true, true);
  const answered = ask("Confirm destructive action 'file.delete'? [y/N]", streams);
  (streams.input as PassThrough).write("y\n");
  await answered;
  // This is the whole of #172: with the question on stdout, `asterism run … > out.txt`
  // put the destructive-action confirmation in the file and waited at a blank screen.
  expect(written()).toContain("Confirm destructive action 'file.delete'? [y/N]");
});

test("with nowhere to show the question, nothing is asked and nothing is written", async () => {
  // stdin is a terminal — there IS someone here — but stderr is redirected, so the
  // question would land somewhere they cannot see. Undefined is what every caller
  // already reads as "no human present": the destructive gate stays paused, a review
  // rejects, a grant is not made. None of them waits.
  const { streams, written } = terminal(true, false);
  expect(await ask("Confirm destructive action 'file.delete'? [y/N]", streams)).toBeUndefined();
  expect(written()).toBe("");
});

test("with nobody to answer, nothing is asked", async () => {
  const { streams, written } = terminal(false, true);
  expect(await ask("Confirm destructive action 'file.delete'? [y/N]", streams)).toBeUndefined();
  expect(written()).toBe("");
});

test("an input stream that ends without an answer is no answer, not a wait", async () => {
  // Ctrl-D, or a terminal that goes away mid-question. `rl.question()` never settles on
  // its own when the stream ends first, so without the race this call would hang.
  const { streams } = terminal(true, true);
  const answered = ask("Confirm destructive action 'file.delete'? [y/N]", streams);
  (streams.input as PassThrough).end();
  expect(await answered).toBeUndefined();
});
