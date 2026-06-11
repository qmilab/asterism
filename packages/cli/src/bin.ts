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

import { runCli } from "./cli.js";
import type { CliIO, ReviewDecision } from "./cli.js";
import { workspaceCapabilities } from "./capabilities.js";
import type { Action } from "@qmilab/asterism-core";

const io: CliIO = {
  cwd: process.cwd(),
  env: process.env,
  // The default tool catalog the shipped binary exposes — real, workspace-scoped
  // file tools behind the kernel's trust gate. Built per run from the agent's
  // workspace so each tool is confined to that agent's directory; the kernel does
  // the trust scoping and the destructive-action gating on top.
  capabilities: workspaceCapabilities,
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
    // Show the action's arguments (e.g. the path a delete targets) so the human is
    // approving a specific operation, not a bare capability name — the difference
    // between confirming one file and confirming a whole directory. `JSON.stringify`
    // can return undefined (e.g. for a function arg); guard and cap the length.
    let detail = "";
    if (action.args !== undefined) {
      const rendered = JSON.stringify(action.args);
      if (rendered) detail = rendered.length > 200 ? ` ${rendered.slice(0, 200)}…` : ` ${rendered}`;
    }
    const answer = prompt(`Confirm destructive action '${action.capability}'${detail}? [y/N]`);
    return answer !== null && /^y(es)?$/i.test(answer.trim());
  },
  // Only consume stdin when it is piped, so an interactive session is not blocked
  // waiting on input that will never come. The value is returned VERBATIM — inline
  // and environment secrets are stored exactly as given, and a piped secret (PEM /
  // private-key material, intentionally padded tokens) must not be normalized.
  // Callers that want a trailing newline dropped can pipe with `printf`/`echo -n`.
  readStdin: async () => {
    if (process.stdin.isTTY) return undefined;
    return Bun.stdin.text();
  },
  // `reflect --review`: the kernel proposes typed memories and prints each one; the
  // human decides its fate here. Nothing is saved without an explicit accept, and a
  // non-interactive (piped) session saves nothing — the safe default, mirroring the
  // destructive-action prompt above. The proposal text is already printed by the
  // command, so this only collects the decision.
  review: (): ReviewDecision => {
    if (!process.stdin.isTTY) return { kind: "reject" };
    const answer = prompt("  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject):");
    const choice = (answer ?? "").trim().toLowerCase();
    if (choice === "a" || choice === "accept" || choice === "y" || choice === "yes") {
      return { kind: "accept" };
    }
    if (choice === "e" || choice === "edit") {
      const edited = prompt("  New content:");
      const content = (edited ?? "").trim();
      return content.length > 0 ? { kind: "edit", content } : { kind: "reject" };
    }
    return { kind: "reject" };
  },
  // `serve`: start the local HTTP endpoint. Imported lazily so non-serve commands
  // never load the HTTP layer (the same pattern `run` uses for the substrate).
  startServer: async (options) => (await import("@qmilab/asterism-server")).serve(options),
  // Block until the first interrupt, then let `serve` shut down gracefully (stop
  // the server, close the store). A second Ctrl+C falls through to the default
  // hard exit.
  waitForShutdown: () =>
    new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }),
};

const code = await runCli(process.argv.slice(2), io);
process.exit(code);
