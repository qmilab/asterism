#!/usr/bin/env bun
// The `asterism` executable. This module has side effects (it runs a command and
// calls process.exit), so it is kept SEPARATE from the package's importable entry
// (`index.ts`): `package.json` points `bin` here and `main`/`exports` at the
// import-safe library surface, so `import "@qmilab/asterism"` never executes the
// CLI against the host's argv.
//
// Thin by design: wire the real outside world (stdin/stdout/env/cwd and an
// interactive confirmation prompt) into `runCli`, then translate its return value
// into a process exit code. All parsing, kernel calls, and formatting live in
// `cli.ts`; the concrete adapter is wired lazily there from the environment.

import { runCli } from "./cli";
import type { CliIO } from "./cli";
import type { Action } from "@qmilab/asterism-core";

const io: CliIO = {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => {
    process.stdout.write(`${text}\n`);
  },
  err: (text) => {
    process.stderr.write(`${text}\n`);
  },
  // Destructive actions pause for an explicit yes. Non-interactive (piped) runs
  // never auto-approve — the safe default is to stay paused.
  confirm: (action: Action) => {
    if (!process.stdin.isTTY) return false;
    const answer = prompt(`Confirm destructive action '${action.capability}'? [y/N]`);
    return answer !== null && /^y(es)?$/i.test(answer.trim());
  },
  // Only consume stdin when it is piped, so an interactive session is not blocked
  // waiting on input that will never come.
  readStdin: async () => {
    if (process.stdin.isTTY) return undefined;
    const text = await Bun.stdin.text();
    return text.trim();
  },
};

const code = await runCli(process.argv.slice(2), io);
process.exit(code);
