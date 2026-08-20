// The binary's decision about whether a human is present (#172), read off `bin.ts`
// itself.
//
// Why the source and not the behaviour: `bin.ts` runs a command and exits, and the
// thing under test is a module-level constant read from real file descriptors — a test
// process has no terminal to give it, and a pty can drive the built binary but only
// through a surface that needs a model or a seeded track record to reach. What IS
// checkable everywhere, and is where the defect would come back, is the shape: that the
// binary asks "is there a human here?" in exactly ONE place, so a hook can never be
// wired more widely than the prompt it calls.
//
// That gap matters because these hooks use ABSENCE as the non-interactive signal. A hook
// wired on a wider test than `ask()`'s own would reach a reviewer that can never be
// asked and read every unanswerable question as a rejection — for `reflect --review`'s
// persisted queue, a durable one. `runtime.test.ts` pins what `ask` does; this pins that
// nothing in the binary decides it a second way.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./bin.ts", import.meta.url)), "utf8");

/**
 * `bin.ts` with its comment lines dropped — the file is commented in `//` lines only, so
 * this is exact. Counted against the CODE, because the counts below are about how many
 * places DECIDE something; prose that names a function is not one of them, and a check
 * that a comment can break is a check people learn to edit around.
 */
const code = source
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

/** The `...(COND ? {…} : {})` conditional wirings in the `CliIO` literal, in order. */
function conditionalWirings(): { condition: string; body: string }[] {
  const out: { condition: string; body: string }[] = [];
  const re = /\.\.\.\(\s*([^?]+?)\s*\?([\s\S]*?)\s*: \{\}\),/g;
  for (const m of source.matchAll(re)) out.push({ condition: m[1]!.trim(), body: m[2]! });
  return out;
}

test("every interactive hook is wired on the one terminal test, and the exception is the TUI", () => {
  const wirings = conditionalWirings();
  // A zero here would make every assertion below vacuously true — the regex failing to
  // match is exactly how this check would stop checking.
  expect(wirings.length).toBeGreaterThanOrEqual(4);

  const askable = wirings.filter((w) => w.condition === "interactive");
  const other = wirings.filter((w) => w.condition !== "interactive");

  // Every hook that puts a QUESTION to a human hangs off `interactive`, which is
  // `hasAskableTerminal()` — the same predicate `ask`/`askSecret` refuse on.
  const asked = askable.map((w) => w.body).join("\n");
  for (const hook of ["promptSecret", "review", "reviewTransition", "reviewGrant"]) {
    expect(asked).toContain(`${hook}:`);
  }

  // Each answer is turned into a verdict by the mapping in `cli.ts`, not by a second copy
  // here. That mapping is where EOF (a departure) is kept apart from an empty line (the
  // reject the prompt names), and `cli.test.ts` pins every case of it — but only if this
  // file actually calls it. Without this, the binary could inline the old collapsing
  // version and every test would stay green.
  expect(asked).toContain("decideReview(");
  expect(asked).toContain("decideTransition(");
  expect(asked).not.toMatch(/kind:\s*"reject"/); // no verdict decided in this file

  // Exactly one wiring reads the file descriptors itself, and it is the dashboard's TUI
  // — not a question but a full-screen drawing, which is output and belongs on stdout.
  expect(other).toHaveLength(1);
  expect(other[0]!.condition).toBe("process.stdin.isTTY && process.stdout.isTTY");
  expect(other[0]!.body).toContain("terminal:");
});

test("the binary reads the terminal in exactly one other place, and it is not a question", () => {
  // Any further `isTTY` in this file is a second opinion about whether a human is here,
  // which is the shape the bug had: `ask()` gated on stdin while the question went to
  // stdout. `readPipedStdin` keeps its own stdin test — it asks nothing — but it lives
  // in `runtime.ts`, not here.
  const reads = [...code.matchAll(/process\.(stdin|stdout|stderr)\.isTTY/g)];
  expect(reads).toHaveLength(2);
  expect(code).toContain("const interactive = hasAskableTerminal();");
  expect([...code.matchAll(/hasAskableTerminal\(/g)]).toHaveLength(1);
});

test("the only hook that asks without checking first is the one whose absence changes nothing", () => {
  // `confirm` is wired unconditionally because absence and a declined answer are the same
  // outcome: the kernel pauses either way. Every OTHER call sits inside a conditional
  // wiring, and a new unconditional hook that starts asking must fail this.
  //
  // The first version kept only the text before the first spread, so a hook added anywhere
  // after it — beside `startServer`, say — could have called `ask()` and passed. Every
  // region outside a wiring is checked now, not the first one.
  const literal = code.slice(code.indexOf("const io: CliIO = {"));
  // Split on each `...(cond ? {…} : {}),` and keep what is NOT inside one. The bodies are
  // the conditional wirings; everything between them is unconditional.
  const outside = literal.split(/\.\.\.\([^?]+?\?[\s\S]*?\s*: \{\}\),/).join("\n");
  // A split that matched nothing would leave the whole literal here and pass vacuously;
  // one that matched everything would leave nothing and pass just as vacuously.
  expect(outside.length).toBeLessThan(literal.length);
  expect(outside).toContain("confirm:");
  expect(outside).toContain("startServer:"); // a region AFTER the first wiring is included
  // Exactly one unconditional `ask`, and it is the one in `confirm`.
  expect([...outside.matchAll(/\bask\(/g)]).toHaveLength(1);
  expect([...outside.matchAll(/askSecret\(/g)]).toHaveLength(0);
  expect(outside.slice(outside.indexOf("confirm:"), outside.indexOf("readStdin"))).toContain("await ask(");
});
