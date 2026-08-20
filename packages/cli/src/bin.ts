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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import type { CliIO, ReviewDecision, TransitionDecision } from "./cli.js";
import { artifactFetchHost, workspaceCapabilities } from "./capabilities.js";
import { outboundHost } from "./outbound.js";
import { createNodeTerminal } from "./dashboard/terminal-node.js";
import { ask, askSecret, hasAskableTerminal, readPipedStdin } from "./runtime.js";
import type { Action } from "@qmilab/asterism-core";

// Whether this session can be asked a question at all: a terminal to read an answer
// from AND one to show the question on. Every interactive hook below is wired on this
// one answer, and `ask`/`askSecret` refuse on the same one, so a hook can never be
// present in a session where the question behind it cannot be put.
//
// That lockstep is load-bearing, not tidiness. These hooks use ABSENCE as the "no human
// present" signal, and a hook wired more widely than the prompt it calls is worse than
// no hook: `reflect --review`'s persisted queue would reach a reviewer that can never be
// asked, read every unanswerable question as a reject, and durably reject the pile it
// exists to protect. Read once rather than per call — the streams do not change under a
// running process, and one read cannot disagree with another.
const interactive = hasAskableTerminal();

const io: CliIO = {
  cwd: process.cwd(),
  env: process.env,
  // The default tool catalog the shipped binary exposes — real, workspace-scoped
  // file tools behind the kernel's trust gate. Built per run from the agent's
  // workspace so each tool is confined to that agent's directory; the kernel does
  // the trust scoping and the destructive-action gating on top.
  capabilities: workspaceCapabilities,
  // The filesystem side of `artifact fetch` — the same workspace confinement the file
  // tools use, applied to the callee's workspace on the read and the caller's on the
  // write. The kernel decides whether a byte may cross; this only moves it.
  fetchHost: artifactFetchHost(),
  // The HTTP side of a bound endpoint — the one place this binary speaks to another
  // machine on an agent's behalf, carrying that agent's credential. The kernel decides
  // whether the call may happen at all and screens what comes back; this only moves the
  // bytes, and it must not follow redirects (a 3xx would forward the credential to an
  // origin the operator never named).
  outboundHost: outboundHost(),
  out: (text) => {
    process.stdout.write(`${text}\n`);
  },
  err: (text) => {
    process.stderr.write(`${text}\n`);
  },
  // Destructive actions pause for an explicit yes. `ask` returns undefined when there is
  // no terminal to ask at, so a run with no human present never auto-approves — the safe
  // default is to stay paused, and the run reports how to confirm it later.
  //
  // Wired unconditionally, unlike the hooks below, because absence and a declined answer
  // are the SAME outcome here: the kernel pauses either way (`run.ts`, `confirm?`). There
  // is nothing for its absence to signal that its answer does not already say.
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
  // `secrets add` with no value anywhere else: ask for one at the terminal, echoing
  // nothing. Wired ONLY when there is a terminal, like `review` below — the field's
  // ABSENCE is what the command reads as "no one is here to type it", and it must not be
  // present in a piped session where `readPipedStdin` has already consumed stdin.
  //
  // BOTH ends are required, not just stdin. The question goes to stderr (so it survives
  // `> file` on the output, and so it is never mistaken for the command's result), which
  // means a redirected stderr is a session with somewhere to read from and nowhere to
  // ask: measured, `secrets add work KEY 2>log` on a terminal put the question in the
  // file and waited for an answer with a blank screen. Refusing with the three scripted
  // ways is the better end to that.
  ...(interactive
    ? { promptSecret: (key: string) => askSecret(`Value for ${key} (not echoed):`) }
    : {}),
  // `reflect --review`: the kernel proposes typed memories and prints each one; the
  // human decides its fate here. Wired ONLY when there is a terminal to ask at — a
  // piped/redirected session has no human to decide, and the field's ABSENCE is what the
  // command reads as "non-interactive". This matters for the persisted queue: there, a
  // reject is a durable transition, so a default-reject in a non-interactive session
  // would wipe the pile; omitting `review` makes the queue drain refuse to run unattended
  // instead. The proposal text is already printed by the command, so this only collects
  // the decision.
  //
  // The LIVE path refuses too, for the same reason with a different cost: a live reject
  // persists nothing, but reaching it means building a model and paying for a call whose
  // every answer is then discarded, and ending on a summary of decisions nobody made.
  ...(interactive
    ? {
        review: async (): Promise<ReviewDecision> => {
          const answer = await ask(
            "  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject):",
          );
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
        // `reflect --review` Type B: the kernel suggests an existing objective looks finished and
        // prints it; the human decides here. Apply runs the (audited) transition; skip leaves it; quit
        // stops the rest. Wired only on a TTY for the same reason as `review` — a piped/redirected
        // session has no human, and the field's ABSENCE makes the command apply nothing (and skip the
        // model call). The default on an empty answer is SKIP — nothing changes without an explicit yes.
        reviewTransition: async (): Promise<TransitionDecision> => {
          const answer = await ask("  Apply this change? [a]pply / [s]kip / [q]uit (default: skip):");
          const choice = (answer ?? "").toLowerCase();
          if (choice === "a" || choice === "apply" || choice === "y" || choice === "yes") {
            return "apply";
          }
          if (choice === "q" || choice === "quit") return "quit";
          return "skip";
        },
      }
    : {}),
  // `trust --review`: the kernel proposes which capabilities have EARNED a standing
  // grant and prints each with its evidence; the human ratifies here. Nothing is granted
  // without an explicit yes. Wired on the same terminal test as the hooks above, so a
  // session with no human is told to come back with one rather than walked through every
  // candidate and shown "0 granted, N left gated" — a report of decisions nobody made.
  ...(interactive
    ? {
        reviewGrant: async (): Promise<boolean> => {
          const answer = await ask(
            "  Grant this capability a standing (act without pausing)? [y/N]:",
          );
          return answer !== undefined && /^y(es)?$/i.test(answer);
        },
      }
    : {}),
  // `serve`: start the local HTTP endpoint. Imported lazily so non-serve commands
  // never load the HTTP layer (the same pattern `run` uses for the substrate).
  startServer: async (options) => (await import("@qmilab/asterism-server")).serve(options),
  // `dashboard`: start the install-wide operator console the TUI is a client of (and
  // that `--headless` exposes). Lazily imported, like `serve`.
  startConsole: async (options) => (await import("@qmilab/asterism-server")).serveConsole(options),
  // `dashboard`: the interactive terminal, wired only when stdin AND stdout are TTYs
  // — a piped/redirected session has no raw input or sized output to drive a TUI, so
  // the field is omitted and `dashboard` reports it needs a terminal (or --headless).
  //
  // Deliberately NOT `interactive`: a TUI is not a question. It draws a full screen,
  // which is output and belongs on stdout, where the dashboard's own renderer already
  // writes. A question is not output, which is why it goes to stderr instead.
  ...(process.stdin.isTTY && process.stdout.isTTY ? { terminal: createNodeTerminal() } : {}),
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
  // `service`: which OS service manager to target, and how to re-launch this CLI
  // from inside a generated service. Absolute paths only — a launchd/systemd
  // service runs with a minimal PATH and cannot rely on `asterism` being found.
  platform: process.platform,
  selfInvocation: [process.execPath, fileURLToPath(import.meta.url)],
  // Run `launchctl`/`systemctl` for `service`. A non-zero exit is captured and
  // returned (not thrown) so a status probe can read state from the exit code.
  runCommand: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code: code ?? 0, stdout, stderr });
      });
    }),
};

const code = await runCli(process.argv.slice(2), io);
process.exit(code);
