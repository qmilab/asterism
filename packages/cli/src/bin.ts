#!/usr/bin/env node
// The `asterism` executable. This module has side effects (it runs a command and
// calls process.exit), so it is kept SEPARATE from the package's importable entry
// (`index.ts`): `package.json` points `bin` here and `main`/`exports` at the
// import-safe library surface, so `import "@qmilab/asterism"` never executes the
// CLI against the host's argv.
//
// The shebang names `node` — the compatibility floor every install has — so
// `npx`/`npm`/`pnpm`/`yarn` users (and a bare `asterism` on `PATH`) run it without
// Bun. It runs identically under Bun, but Bun honors the shebang too: force Bun's
// runtime with `bunx --bun @qmilab/asterism` or `bun run --bun` (or run the file
// directly, `bun bin.js`). No code path below touches a Bun-only global (see
// `runtime.ts`), so the runtime that wins the shebang race never matters.
//
// Thin by design: wire the real outside world (stdin/stdout/env/cwd and an
// interactive confirmation prompt) into `runCli`, then translate its return value
// into a process exit code. All parsing, kernel calls, and formatting live in
// `cli.ts`; the concrete adapter is wired lazily there from the environment.

import { runCli } from "./cli.js";
import type { CliIO, ReviewDecision } from "./cli.js";
import { workspaceCapabilities } from "./capabilities.js";
import { ask, readPipedStdin } from "./runtime.js";
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
  // Destructive actions pause for an explicit yes. `ask` returns undefined for a
  // non-interactive (piped) session, so a run with no human present never
  // auto-approves — the safe default is to stay paused.
  confirm: async (action: Action) => {
    // Show the action's arguments (e.g. the path a delete targets) so the human is
    // approving a specific operation, not a bare capability name — the difference
    // between confirming one file and confirming a whole directory. `JSON.stringify`
    // can return undefined (e.g. for a function arg); guard and cap the length.
    let detail = "";
    if (action.args !== undefined) {
      const rendered = JSON.stringify(action.args);
      if (rendered) detail = rendered.length > 200 ? ` ${rendered.slice(0, 200)}…` : ` ${rendered}`;
    }
    const answer = await ask(`Confirm destructive action '${action.capability}'${detail}? [y/N]`);
    return answer !== undefined && /^y(es)?$/i.test(answer);
  },
  // Only consume stdin when it is piped (see `readPipedStdin`): the value is
  // returned VERBATIM so a piped secret is stored exactly as given.
  readStdin: readPipedStdin,
  // `reflect --review`: the kernel proposes typed memories and prints each one; the
  // human decides its fate here. Nothing is saved without an explicit accept, and a
  // non-interactive (piped) session saves nothing — the safe default, mirroring the
  // destructive-action prompt above. The proposal text is already printed by the
  // command, so this only collects the decision.
  review: async (): Promise<ReviewDecision> => {
    const answer = await ask("  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject):");
    const choice = (answer ?? "").toLowerCase();
    if (choice === "a" || choice === "accept" || choice === "y" || choice === "yes") {
      return { kind: "accept" };
    }
    if (choice === "e" || choice === "edit") {
      const edited = await ask("  New content:");
      const content = edited ?? "";
      return content.length > 0 ? { kind: "edit", content } : { kind: "reject" };
    }
    return { kind: "reject" };
  },
  // `serve`: start the local HTTP endpoint. Imported lazily so non-serve commands
  // never load the HTTP layer (the same pattern `run` uses for the substrate).
  startServer: async (options) => (await import("@qmilab/asterism-server")).serve(options),
  // `channel telegram`: start the chat channel. Lazily imported for the same reason
  // — only this command loads the channel transport.
  startTelegram: async (options) => (await import("@qmilab/asterism-channels")).runTelegram(options),
  // `channel discord`: same, over the Discord Gateway. The transport defaults to the
  // runtime's global WebSocket (Bun, Node 22+); on a runtime without one the launch
  // fails with a clear pointer to upgrade — no dependency, the `fetch` pattern.
  startDiscord: async (options) => (await import("@qmilab/asterism-channels")).runDiscord(options),
  // Block until the first interrupt, then let `serve` shut down gracefully (stop
  // the server, close the store). A second Ctrl+C falls through to the default
  // hard exit.
  waitForShutdown: () =>
    new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }),
  // Pace `events tail --follow`: wait a beat between polls, but resolve `false` the
  // moment an interrupt arrives so the loop ends and the process exits cleanly
  // (rather than the default hard kill). Listeners and the timer are torn down on
  // each tick, so repeated polling never accumulates handlers.
  followTick: () =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve(value);
      };
      const stop = (): void => finish(false);
      const timer = setTimeout(() => finish(true), 1000);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }),
};

const code = await runCli(process.argv.slice(2), io);
process.exit(code);
