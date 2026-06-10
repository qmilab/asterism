// The `asterism` command surface. Thin by mandate (CLAUDE.md): every handler
// parses arguments, calls one or more kernel operations, and formats the result.
// No business logic, no scoping decisions, no trust reasoning — those live in the
// kernel and are merely invoked here. The dispatcher is injectable end-to-end
// (cwd, env, output sinks, store factory, adapter factory, confirm prompt) so the
// whole surface is testable without touching the real filesystem-of-record.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import {
  BUILTIN_SOULS,
  executeRun,
  isReflectionMemoryType,
  MemoryFirewallError,
  screenMemory,
  TRUST_LEVELS,
  validateEnum,
} from "@qmilab/asterism-core";
import type {
  Action,
  Agent,
  Capability,
  FirewallFinding,
  ProposedMemory,
  ReflectionProvider,
  RuntimeAdapter,
  TailOptions,
  TrustLevel,
} from "@qmilab/asterism-core";
import type { RunningServer, ServeOptions } from "@qmilab/asterism-server";

import { helpRequested, intFlag, parseArgs, stringFlag } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { formatEventList, formatMemoryList, shortId } from "./format.js";
import { COMMAND_HELP, USAGE } from "./help.js";
import {
  agentWorkspace,
  createHome,
  dbPath,
  findHome,
  isValidAgentName,
} from "./paths.js";
import { VERSION } from "./version.js";

/** A proposed memory presented for review, with any firewall findings on it. */
export interface ReviewItem {
  /** 1-based position in the batch. */
  index: number;
  total: number;
  memoryType: string;
  content: string;
  confidence: number;
  /** Firewall findings on the proposed content; empty when it screens clean. */
  findings: readonly FirewallFinding[];
}

/** The reviewer's verdict on one proposed memory during `reflect --review`. */
export type ReviewDecision =
  | { kind: "accept" }
  | { kind: "edit"; content: string }
  | { kind: "reject" };

/** Everything the CLI touches the outside world through — injectable for tests. */
export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Print a line to standard output (the implementation adds the newline). */
  out: (text: string) => void;
  /** Print a line to standard error. */
  err: (text: string) => void;
  /** Resolve a destructive action's confirmation. Absent ⇒ the action stays paused. */
  confirm?: (action: Action) => boolean | Promise<boolean>;
  /**
   * Capabilities to expose to runs, handed to the kernel's gate untouched. Absent
   * ⇒ none — Phase 0 registers no capabilities, so the default run is confined to
   * an empty tool set. This is the host seam the acceptance test (and a future
   * embedding) uses to put real tools behind the kernel's trust enforcement.
   */
  capabilities?: readonly Capability[];
  /** Read piped standard input (for `secrets add` without an inline value). */
  readStdin?: () => Promise<string | undefined>;
  /** Build the run adapter. Absent ⇒ the default wiring reads it from the environment. */
  makeAdapter?: (env: CliIO["env"]) => {
    adapter?: RuntimeAdapter;
    reason?: string;
  };
  /** Build the reflection provider. Absent ⇒ the default wiring reads it from the environment. */
  makeReflectionProvider?: (env: CliIO["env"]) => {
    provider?: ReflectionProvider;
    reason?: string;
  };
  /**
   * Decide a proposed memory's fate during `reflect --review`. Absent ⇒ reject
   * every proposal, so nothing persists — the same safe default as `confirm`.
   */
  review?: (item: ReviewItem) => ReviewDecision | Promise<ReviewDecision>;
  /** Open the kernel store at a path. Absent ⇒ the real local SQLite store. */
  openStore?: (path: string) => AsterismStore;
  /**
   * Start the local HTTP endpoint for `serve`. Absent ⇒ serving is unavailable in
   * this embedding (the default wiring in `bin.ts` supplies the real server). The
   * store stays open for the server's lifetime, so the handler returns only after
   * {@link CliIO.waitForShutdown} resolves.
   */
  startServer?: (options: ServeOptions) => RunningServer | Promise<RunningServer>;
  /**
   * Block until a shutdown is requested (e.g. Ctrl+C). Absent ⇒ returns at once,
   * so a non-interactive caller does not hang. The default wiring waits on
   * SIGINT/SIGTERM.
   */
  waitForShutdown?: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Open the install's store, or print a clear pointer to `init` and bail. */
async function withHomeStore(
  io: CliIO,
  fn: (store: AsterismStore, home: string) => number | Promise<number>,
): Promise<number> {
  const home = findHome(io.cwd);
  if (!home) {
    io.err("No Asterism workspace found here. Run `asterism init` first.");
    return 1;
  }
  const open = io.openStore ?? ((p: string) => AsterismStore.open(p));
  // Open inside the try: a corrupt or unreadable database must surface as a
  // clean error code, not an unhandled rejection. `store` stays undefined if the
  // open throws, so the finally guards the close.
  let store: AsterismStore | undefined;
  try {
    store = open(dbPath(home));
    return await fn(store, home);
  } catch (err) {
    io.err(`error: ${errorMessage(err)}`);
    return 1;
  } finally {
    store?.close();
  }
}

/** Resolve an agent by its name (the handle every command takes), or undefined. */
function findAgentByName(store: AsterismStore, name: string): Agent | undefined {
  return store.agents.list().find((a) => a.name === name);
}

/** Print a uniform "no such agent" pointer. */
function noAgent(io: CliIO, name: string): number {
  io.err(`No agent named "${name}". Create it with: asterism new ${name}`);
  return 1;
}

/**
 * Build the run substrate from the IO's override or, lazily, from the environment.
 * The single seam either run-bearing command (`run`, `serve`) reaches the model
 * through, so the two cannot drift in how it is wired — the same reason the run
 * flow itself lives in one kernel call.
 */
async function resolveAdapter(
  io: CliIO,
): Promise<{ adapter?: RuntimeAdapter; reason?: string }> {
  return io.makeAdapter
    ? io.makeAdapter(io.env)
    : (await import("./model.js")).buildAdapterFromEnv(io.env);
}

// --- init ------------------------------------------------------------------

async function cmdInit(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.init!);
    return 0;
  }
  try {
    const { home, created } = createHome(io.cwd);
    // Opening the store applies the schema, materializing the database file.
    const open = io.openStore ?? ((p: string) => AsterismStore.open(p));
    open(dbPath(home)).close();
    if (created) {
      io.out(`Initialized Asterism in ${home}`);
      io.out(`Create your first agent:  asterism new <name> --role "..." --trust propose`);
    } else {
      io.out(`Asterism is already set up in ${home}`);
    }
    return 0;
  } catch (err) {
    io.err(`error: ${errorMessage(err)}`);
    return 1;
  }
}

// --- new -------------------------------------------------------------------

async function cmdNew(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.new!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err('Usage: asterism new <agent> [--soul <name|path>] [--role "<text>"] [--trust <level>]');
    return 1;
  }
  if (!isValidAgentName(name)) {
    io.err(
      `Invalid agent name "${name}". Use letters, digits, dot, dash, or underscore (no spaces or slashes).`,
    );
    return 1;
  }
  // A value-bearing flag given with no value parses as boolean `true`. Reject it
  // rather than silently falling back to a default — `new bot --trust` must not
  // quietly create a `propose` agent the user did not ask for.
  for (const flag of ["soul", "role", "trust"] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return 1;
    }
  }
  const role = stringFlag(parsed.flags.role) ?? "";
  const trustLevel = stringFlag(parsed.flags.trust) ?? "propose";

  // Resolve the soul reference now, while we still know the directory the user
  // invoked from. A built-in name is stored verbatim; anything else is a file
  // path, captured as an absolute path so `run` reads the same soul no matter
  // which subdirectory it is later invoked from (the home is discovered upward).
  let soulRef = stringFlag(parsed.flags.soul) ?? "casual-helper";
  let soulNote: string | undefined;
  // Own-property check, not `in`: a custom soul named like an inherited property
  // (`toString`, `__proto__`) is a file path, not a built-in soul.
  if (!Object.hasOwn(BUILTIN_SOULS, soulRef)) {
    const soulPath = resolvePath(io.cwd, soulRef);
    if (!existsSync(soulPath) || !statSync(soulPath).isFile()) {
      soulNote = `  note: no soul file at ${soulPath} yet — the agent uses a default character until one exists there.`;
    }
    soulRef = soulPath;
  }

  return withHomeStore(io, (store, home) => {
    if (findAgentByName(store, name)) {
      io.err(`An agent named "${name}" already exists.`);
      return 1;
    }
    // Validate the trust level through the kernel's enum chokepoint before use.
    validateEnum(trustLevel, TRUST_LEVELS, "trust level");
    const workspaceDir = agentWorkspace(home, name);
    mkdirSync(workspaceDir, { recursive: true });
    const agent = store.createAgent({
      name,
      role,
      soulRef,
      workspaceDir,
      trustLevel: trustLevel as TrustLevel,
    });
    io.out(`Created agent "${agent.name}" (${agent.trustLevel}) — soul: ${agent.soulRef}`);
    if (agent.role) io.out(`  role: ${agent.role}`);
    io.out(`  workspace: ${agent.workspaceDir}`);
    if (soulNote) io.out(soulNote);
    return 0;
  });
}

// --- trust -----------------------------------------------------------------

async function cmdTrust(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.trust!);
    return 0;
  }
  const name = parsed.positionals[0];
  const level = parsed.positionals[1];
  if (!name || !level) {
    io.err("Usage: asterism trust <agent> <propose|notify|autonomous>");
    return 1;
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    validateEnum(level, TRUST_LEVELS, "trust level");
    const updated = store.setTrust(agent.id, level as TrustLevel);
    io.out(`Set ${updated.name} to ${updated.trustLevel}.`);
    return 0;
  });
}

// --- secrets add -----------------------------------------------------------

async function cmdSecretsAdd(args: string[], io: CliIO): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    io.out(COMMAND_HELP.secrets!);
    return 0;
  }
  // Positional only — no flag parsing. The first two tokens are the agent and
  // key; the THIRD is the value, taken VERBATIM. Secret material is arbitrary, so
  // a value that begins with a dash (`-abc`, `-----BEGIN …`) must be stored as
  // given, not mistaken for an option. Option parsing stops after the key.
  const name = args[0];
  const key = args[1];
  if (!name || !key) {
    io.err("Usage: asterism secrets add <agent> <KEY> [value]");
    return 1;
  }
  // Value precedence: inline argument, then the matching environment variable,
  // then piped standard input. Never echoed back, whichever path it came from.
  let value = args[2] ?? io.env[key];
  if (value === undefined && io.readStdin) {
    value = await io.readStdin();
  }
  if (value === undefined || value.length === 0) {
    io.err(
      `No value for ${key}. Pass it inline, set $${key} in the environment, or pipe it on stdin.`,
    );
    return 1;
  }
  const secretValue = value;
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    store.addCredential(agent.id, key, secretValue);
    io.out(`Stored credential ${key} for agent ${name}.`);
    return 0;
  });
}

// --- skill add -------------------------------------------------------------

async function cmdSkillAdd(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.skill!);
    return 0;
  }
  const name = parsed.positionals[0];
  const file = parsed.positionals[1];
  if (!name || !file) {
    io.err("Usage: asterism skill add <agent> <file.md>");
    return 1;
  }
  const sourcePath = resolvePath(io.cwd, file);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    io.err(`No such file: ${file}`);
    return 1;
  }
  if (!sourcePath.endsWith(".md")) {
    io.err("A skill must be a markdown (.md) file.");
    return 1;
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    const fileName = basename(sourcePath);
    const skillName = fileName.replace(/\.md$/, "");
    // Copy the skill into the agent's own workspace so it belongs to that agent;
    // the stored path points inside the workspace, never at the original.
    const skillsDir = join(agent.workspaceDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const destPath = join(skillsDir, fileName);
    copyFileSync(sourcePath, destPath);
    store.attachSkill(agent.id, { name: skillName, path: destPath });
    io.out(`Attached skill "${skillName}" to agent ${name}.`);
    return 0;
  });
}

// --- run -------------------------------------------------------------------

async function cmdRun(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.run!);
    return 0;
  }
  const name = parsed.positionals[0];
  // Join every remaining positional so an unquoted multi-word task
  // (`run agent fix the login bug`) is preserved in full, not silently
  // truncated to the first word.
  const task = parsed.positionals.slice(1).join(" ");
  if (!name || !task) {
    io.err('Usage: asterism run <agent> "<task>"');
    return 1;
  }

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Resolve the adapter only after the workspace and agent check out, so an
    // uninitialized workspace or unknown agent fails like every other command
    // (and no adapter is constructed for a run that cannot proceed).
    const made = await resolveAdapter(io);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }

    // The whole run flow — start, trust-resolve + gate, frame, run, persist — is
    // the kernel's. This surface only supplies host concerns (the substrate, a
    // file reader for soul/skill bodies, the interactive confirm prompt) and
    // formats the structured outcome. The same call backs the HTTP surface, so
    // the trust/gate path cannot drift between them.
    const result = await executeRun(store, agent, task, {
      adapter: made.adapter,
      readFile: (p) => readFileSync(p, "utf8"),
      ...(io.confirm ? { confirm: io.confirm } : {}),
      ...(io.capabilities ? { capabilities: io.capabilities } : {}),
    });

    if (result.status === "awaiting_confirmation") {
      io.out("Run paused: a destructive action needs your confirmation before it can proceed.");
      return 0;
    }
    if (result.status === "done") {
      io.out(result.output.trim().length > 0 ? result.output : "(the agent produced no output)");
      return 0;
    }
    io.err(`Run failed: ${result.error ?? "unknown error"}`);
    return 1;
  });
}

// --- memory inspect --------------------------------------------------------

async function cmdMemoryInspect(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.memory!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism memory inspect <agent>");
    return 1;
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    io.out(formatMemoryList(store.memories.list(agent.id), agent.name));
    return 0;
  });
}

// --- events tail -----------------------------------------------------------

async function cmdEventsTail(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.events!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism events tail <agent> [--limit <n>] [--type <type>] [--since <id>]");
    return 1;
  }
  const limit = intFlag(parsed.flags.limit);
  const type = stringFlag(parsed.flags.type);
  const sinceId = stringFlag(parsed.flags.since);
  const options: TailOptions = {
    ...(limit !== undefined ? { limit } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(sinceId !== undefined ? { sinceId } : {}),
  };
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    io.out(formatEventList(store.events.tail(agent.id, options), agent.name));
    return 0;
  });
}

// --- reflect (review loop) / serve (local HTTP endpoint) -------------------

async function cmdReflect(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h", "review"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.reflect!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism reflect <agent> --review");
    return 1;
  }
  // `--review` is the only mode in this phase and the documented invocation.
  // Require it explicitly so reflection never runs in a surprising auto mode.
  if (parsed.flags.review !== true) {
    io.err(`Reflection runs in review mode. Re-run with: asterism reflect ${name} --review`);
    return 1;
  }

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Reflect on the agent's most recent run that produced output. The kernel owns
    // both the selection ("latest run with output") and, below, the "already known"
    // predicate, so this surface holds no policy. Checked BEFORE building the model
    // so an agent with nothing to reflect on is told so without needing a model
    // configured. Phase 0 targets the latest run (the canonical flow is run →
    // reflect); a future flag can target a specific run.
    const target = store.runs.latestWithOutput(agent.id);
    if (!target || target.output === undefined) {
      io.out(`${name} has no completed run with output to reflect on yet.`);
      return 0;
    }
    const transcript = { runId: target.id, input: target.input, output: target.output };

    // Build the reflection provider (a hosted model) the same way `run` builds its
    // adapter — only after the agent and a reflectable run check out.
    const made = io.makeReflectionProvider
      ? io.makeReflectionProvider(io.env)
      : (await import("./reflect-model.js")).buildReflectionProviderFromEnv(io.env);
    if (!made.provider) {
      io.err(made.reason ?? "No model configured for reflection.");
      return 1;
    }
    const provider = made.provider;

    // The memories the agent already accepted, so the provider can avoid
    // re-proposing what it already knows (the kernel applies the active+accepted
    // predicate so framing and reflection agree on what "known" means).
    const knownMemories = store.memories
      .listActiveAccepted(agent.id)
      .map((m) => m.content);

    let proposals: readonly ProposedMemory[];
    try {
      proposals = await provider.reflect({ agentId: agent.id, transcript, knownMemories });
    } catch (err) {
      io.err(`Reflection failed: ${errorMessage(err)}`);
      return 1;
    }

    // Defensive backstop for the reflection-only type constraint: the provider is
    // typed to the reflectable subset, but a non-conforming custom provider must
    // never slip a disallowed type (e.g. `episodic`) past review — the kernel's
    // generic memory write accepts any valid memory type, so the reflection-only
    // rule is enforced here, at the consumption point.
    const usable = proposals.filter((p) => isReflectionMemoryType(p.memoryType));
    const ignored = proposals.length - usable.length;
    if (usable.length === 0) {
      io.out(`${name}: nothing worth remembering from run ${shortId(target.id)}.`);
      return 0;
    }

    io.out(
      `Reviewing ${usable.length} proposed ${usable.length === 1 ? "memory" : "memories"} for ${name} (from run ${shortId(target.id)}).`,
    );
    if (ignored > 0) {
      io.out(`(Ignored ${ignored} proposal(s) with a non-reviewable memory type.)`);
    }
    io.out("Nothing is saved unless you accept it.");

    // Absent reviewer ⇒ reject everything: nothing persists without an explicit yes.
    const review = io.review ?? ((): ReviewDecision => ({ kind: "reject" }));
    let accepted = 0;
    let rejected = 0;
    let blocked = 0;
    let errored = 0;
    for (let i = 0; i < usable.length; i++) {
      const p = usable[i]!;
      // Screen for display so the reviewer sees what tripped a rule; the firewall
      // also re-screens at persistence (`recordMemory`), the real hard gate.
      const verdict = screenMemory(p.content);

      io.out("");
      io.out(`(${i + 1}/${usable.length}) ${p.memoryType} · confidence ${p.confidence}`);
      io.out(`  ${p.content}`);
      if (!verdict.ok) {
        io.out(
          `  ⚠ the memory firewall flagged this (${verdict.findings
            .map((f) => f.rule)
            .join(", ")}) — edit to remove the flagged content, or reject it.`,
        );
      }

      const decision = await review({
        index: i + 1,
        total: usable.length,
        memoryType: p.memoryType,
        content: p.content,
        confidence: p.confidence,
        findings: verdict.findings,
      });

      if (decision.kind === "reject") {
        rejected++;
        io.out("  ✗ rejected");
        continue;
      }
      // Trim, and treat an empty/whitespace edit as a rejection — never persist a
      // blank memory, regardless of what the reviewer returned.
      const content = (decision.kind === "edit" ? decision.content : p.content).trim();
      if (content.length === 0) {
        rejected++;
        io.out("  ✗ rejected (empty after edit)");
        continue;
      }
      // Re-screen the EDITED content so the warning the reviewer sees matches what
      // is actually about to be persisted (the original screen was on the proposal).
      if (decision.kind === "edit") {
        const editVerdict = screenMemory(content);
        if (!editVerdict.ok) {
          io.out(
            `  ⚠ your edit still trips the memory firewall (${editVerdict.findings
              .map((f) => f.rule)
              .join(", ")}).`,
          );
        }
      }
      try {
        // The memory firewall re-screens here and refuses a poisoned write
        // regardless of approval — the single hard chokepoint. Accepted memories
        // are saved active + accepted, so they frame the agent's future runs.
        store.recordMemory(agent.id, {
          memoryType: p.memoryType,
          content,
          confidence: p.confidence,
          sourceRunId: p.sourceRunId,
          reviewState: "accepted",
          status: "active",
        });
        accepted++;
        io.out(decision.kind === "edit" ? "  ✓ saved (edited)" : "  ✓ saved");
      } catch (err) {
        // A firewall block and a storage error are BOTH per-proposal outcomes — one
        // bad proposal must not abort the rest of the batch or skip the summary.
        if (err instanceof MemoryFirewallError) {
          blocked++;
          io.out(
            `  ⛔ blocked by the memory firewall — not saved (${err.findings
              .map((f) => f.rule)
              .join(", ")})`,
          );
        } else {
          errored++;
          io.out(`  ⛔ could not save: ${errorMessage(err)}`);
        }
      }
    }

    io.out("");
    io.out(
      `Done — ${accepted} saved, ${rejected} rejected` +
        `${blocked > 0 ? `, ${blocked} blocked` : ""}` +
        `${errored > 0 ? `, ${errored} errored` : ""}.`,
    );
    return 0;
  });
}

async function cmdServe(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.serve!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism serve <agent> [--port <n>] [--host <addr>]");
    return 1;
  }
  // A value-bearing flag given with no value parses as boolean `true`. Reject it
  // rather than silently binding a default the user did not ask for.
  for (const flag of ["port", "host"] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return 1;
    }
  }
  const host = stringFlag(parsed.flags.host);
  // A `--port` with a value that is not a valid port (non-numeric, or out of
  // range) must be an error, not silently dropped — otherwise a typo'd port binds
  // the default and the user is told they are serving somewhere they are not.
  let port: number | undefined;
  if (typeof parsed.flags.port === "string") {
    port = intFlag(parsed.flags.port);
    if (port === undefined || port > 65535) {
      io.err("The --port option must be a whole number between 0 and 65535.");
      return 1;
    }
  }

  if (!io.startServer) {
    io.err("Serving over HTTP is not available in this embedding.");
    return 1;
  }
  const startServer = io.startServer;

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Build the substrate the same way `run` does. A missing model is not fatal
    // for serving: the read endpoints work regardless, and a run started without
    // one is declined with a clear message rather than failing to serve at all.
    const made = await resolveAdapter(io);

    // The kernel store stays open for the server's lifetime — `withHomeStore`
    // closes it only after this callback returns, which it does once shutdown is
    // requested below. The HTTP surface is bound to THIS agent alone.
    const server = await startServer({
      store,
      agent,
      ...(made.adapter ? { adapter: made.adapter } : {}),
      ...(made.reason !== undefined ? { adapterReason: made.reason } : {}),
      readFile: (p) => readFileSync(p, "utf8"),
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { hostname: host } : {}),
    });

    io.out(`Serving agent "${agent.name}" at ${server.url}`);
    io.out(`  POST ${server.url}/agents/${agent.name}/runs    start a run  (JSON body: {"input":"<task>"})`);
    io.out(`  GET  ${server.url}/agents/${agent.name}/runs    list runs`);
    io.out(`  GET  ${server.url}/agents/${agent.name}/events  review activity`);
    if (!made.adapter) {
      io.out("  note: no model configured — runs are declined until you set one (reads still work).");
    }
    io.out("Press Ctrl+C to stop.");

    // Block until shutdown is requested, then stop the server BEFORE returning —
    // awaiting the stop drains in-flight requests, so the store (which
    // `withHomeStore` closes once this callback returns) is never pulled out from
    // under a request still being served. A non-interactive embedding without this
    // hook returns immediately.
    const waitForShutdown = io.waitForShutdown ?? (() => Promise.resolve());
    await waitForShutdown();
    await server.stop();
    io.out("Stopped.");
    return 0;
  });
}

// --- dispatch --------------------------------------------------------------

/** Dispatch a two-word command (`secrets add`, `skill add`, …) to its handler. */
async function dispatchSub(
  group: string,
  expectedSub: string,
  handler: (args: string[], io: CliIO) => Promise<number>,
  parsedHelp: string,
  rest: string[],
  io: CliIO,
): Promise<number> {
  const sub = rest[0];
  // Allow `<group> --help` to reach the group's help.
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.out(parsedHelp);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== expectedSub) {
    io.err(`Unknown subcommand: ${group} ${sub}`);
    io.out(parsedHelp);
    return 1;
  }
  return handler(rest.slice(1), io);
}

/**
 * Parse and run a single `asterism` invocation. Returns a process exit code; it
 * never throws and never calls `process.exit` — the bin does that. All output
 * goes through `io`.
 */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    case "--version":
    case "-v":
      io.out(VERSION);
      return 0;
    case "init":
      return cmdInit(rest, io);
    case "new":
      return cmdNew(rest, io);
    case "trust":
      return cmdTrust(rest, io);
    case "run":
      return cmdRun(rest, io);
    case "reflect":
      return cmdReflect(rest, io);
    case "serve":
      return cmdServe(rest, io);
    case "secrets":
      return dispatchSub("secrets", "add", cmdSecretsAdd, COMMAND_HELP.secrets!, rest, io);
    case "skill":
      return dispatchSub("skill", "add", cmdSkillAdd, COMMAND_HELP.skill!, rest, io);
    case "memory":
      return dispatchSub("memory", "inspect", cmdMemoryInspect, COMMAND_HELP.memory!, rest, io);
    case "events":
      return dispatchSub("events", "tail", cmdEventsTail, COMMAND_HELP.events!, rest, io);
    default:
      io.err(`Unknown command: ${command}`);
      io.out(USAGE);
      return 1;
  }
}
