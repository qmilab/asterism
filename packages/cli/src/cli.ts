// The `asterism` command surface. Thin by mandate (CLAUDE.md): every handler
// parses arguments, calls one or more kernel operations, and formats the result.
// No business logic, no scoping decisions, no trust reasoning — those live in the
// kernel and are merely invoked here. The dispatcher is injectable end-to-end
// (cwd, env, output sinks, store factory, adapter factory, confirm prompt,
// capability exposure) so the whole surface is testable without touching the
// real filesystem-of-record.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import {
  BUILTIN_SOULS,
  executeRun,
  isReflectionMemoryType,
  MEMORY_TYPES,
  MemoryFirewallError,
  resumeRun,
  REVIEW_STATES,
  screenMemory,
  TRUST_LEVELS,
  validateEnum,
} from "@qmilab/asterism-core";
import type {
  Action,
  Agent,
  Capability,
  FirewallFinding,
  MemoryQuery,
  ProposedMemory,
  ReflectionProvider,
  Run,
  RuntimeAdapter,
  TailOptions,
  TrustLevel,
} from "@qmilab/asterism-core";
import type { RunningServer, ServeOptions } from "@qmilab/asterism-server";
import type { ChannelHandle, TelegramOptions } from "@qmilab/asterism-channels";

import { helpRequested, intFlag, parseArgs, stringFlag } from "./args.js";
import type { ParsedArgs } from "./args.js";
import type { AsterismConfig, ModelSettings } from "./config.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  formatActionSummary,
  formatAgentList,
  formatEventLines,
  formatEventList,
  formatMemoryList,
  formatRunActivity,
  formatRunList,
  shortId,
} from "./format.js";
import { COMMAND_HELP, USAGE } from "./help.js";
import type { ModelResolutionContext } from "./model-config.js";
import { resolveModelConfig } from "./model-config.js";
import {
  agentWorkspace,
  configPath,
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
   * Builds the capabilities to expose to a run, given the agent's confined
   * workspace, handed to the kernel's gate untouched — both `run` and `serve` call
   * the same factory, so tool exposure cannot differ by surface. Absent ⇒ none, so
   * the run is confined to an empty tool set. This is the host seam `bin.ts` wires
   * the real catalog through (and that the acceptance test fakes); the workspace
   * argument lets a file tool be confined to the agent's directory without the
   * kernel ever learning a path. Two contract points a host must own: the catalog
   * is install-wide (every agent's runs receive the same tools — only the workspace
   * binding, the trust level, and the gate differ; per-agent capability scoping is
   * a later phase), and each capability's declared `effect` is load-bearing — the
   * kernel escalates to `destructive` from command-string arguments but cannot
   * detect a mis-declared destructive tool with structured args, so declare
   * conservatively.
   */
  capabilities?: (workspaceDir: string) => readonly Capability[];
  /** Read piped standard input (for `secrets add` without an inline value). */
  readStdin?: () => Promise<string | undefined>;
  /**
   * Build the run adapter. Absent ⇒ the default wiring resolves the model from the
   * config file, the environment, and the agent's own override (the `context`).
   */
  makeAdapter?: (
    env: CliIO["env"],
    context: ModelResolutionContext,
  ) => {
    adapter?: RuntimeAdapter;
    reason?: string;
  };
  /**
   * Build the reflection provider. Absent ⇒ the default wiring resolves the model
   * the same way `run` does, including the agent's own override (the `context`).
   */
  makeReflectionProvider?: (
    env: CliIO["env"],
    context: ModelResolutionContext,
  ) => {
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
   * Start a Telegram chat channel for `channel telegram`. Absent ⇒ chat channels
   * are unavailable in this embedding (the default wiring in `bin.ts` supplies the
   * real transport). Like {@link CliIO.startServer}, the store stays open for the
   * channel's lifetime, so the handler returns only after
   * {@link CliIO.waitForShutdown} resolves.
   */
  startTelegram?: (options: TelegramOptions) => ChannelHandle | Promise<ChannelHandle>;
  /**
   * Block until a shutdown is requested (e.g. Ctrl+C). Absent ⇒ returns at once,
   * so a non-interactive caller does not hang. The default wiring waits on
   * SIGINT/SIGTERM.
   */
  waitForShutdown?: () => Promise<void>;
  /**
   * Pace the `events tail --follow` loop. Resolves `true` when it is time to poll
   * for new events again (the default wiring waits a short interval), or `false`
   * when a stop was requested (Ctrl+C) so the loop ends cleanly. Absent ⇒
   * `--follow` degrades to a single read of the backlog: a non-interactive
   * embedding has nothing to stream to and no interrupt to wait on, so it must not
   * loop forever.
   */
  followTick?: () => Promise<boolean>;
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
 * Build the run substrate from the IO's override or, lazily, from the resolved
 * model. The single seam either run-bearing command (`run`, `serve`) reaches the
 * model through, so the two cannot drift in how it is wired — the same reason the
 * run flow itself lives in one kernel call. The agent's name (with the loaded
 * config) lets the model resolve per agent, so different agents can run on
 * different models.
 */
async function resolveAdapter(
  io: CliIO,
  home: string,
  agentName: string,
): Promise<{ adapter?: RuntimeAdapter; reason?: string }> {
  const context: ModelResolutionContext = { config: loadConfig(home), agentName };
  return io.makeAdapter
    ? io.makeAdapter(io.env, context)
    : (await import("./model.js")).buildAdapter(io.env, context);
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

// --- model configuration ---------------------------------------------------

/** The value-bearing model flags shared by `new` and `config set`. */
const MODEL_FLAGS = ["model", "provider", "base-url", "api"] as const;

/**
 * Read the model flags (`--model`/`--provider`/`--base-url`/`--api`) into a
 * {@link ModelSettings}, with only the flags that were given set. Maps `--model`
 * to `id`. There is deliberately NO key flag — API keys stay in the environment,
 * never the config file.
 */
function modelSettingsFromFlags(parsed: ParsedArgs): ModelSettings {
  const settings: ModelSettings = {};
  const id = stringFlag(parsed.flags.model);
  if (id !== undefined) settings.id = id;
  const provider = stringFlag(parsed.flags.provider);
  if (provider !== undefined) settings.provider = provider;
  const baseUrl = stringFlag(parsed.flags["base-url"]);
  if (baseUrl !== undefined) settings.baseUrl = baseUrl;
  const api = stringFlag(parsed.flags.api);
  if (api !== undefined) settings.api = api;
  return settings;
}

/** A one-line, human description of a model's coordinates for confirmations and `config`. */
function describeModel(settings: ModelSettings): string {
  const extra: string[] = [];
  if (settings.provider !== undefined) extra.push(`provider: ${settings.provider}`);
  if (settings.baseUrl !== undefined) extra.push(`base url: ${settings.baseUrl}`);
  if (settings.api !== undefined) extra.push(`api: ${settings.api}`);
  const head = settings.id ?? "(model id inherited)";
  return extra.length > 0 ? `${head} (${extra.join(", ")})` : head;
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
  for (const flag of ["soul", "role", "trust", ...MODEL_FLAGS] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return 1;
    }
  }
  const role = stringFlag(parsed.flags.role) ?? "";
  const trustLevel = stringFlag(parsed.flags.trust) ?? "propose";
  // An optional per-agent model pin, written to the config file after the agent
  // is created. The kernel never learns the model — it stays surface config.
  const modelSettings = modelSettingsFromFlags(parsed);
  const hasModel = Object.keys(modelSettings).length > 0;

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
    // Persist the per-agent model pin only after the agent itself is committed, so
    // a write failure here leaves a usable agent (recoverable with `config set`),
    // never a config entry pointing at an agent that does not exist.
    if (hasModel) {
      const config = loadConfig(home);
      const agents = { ...(config.agents ?? {}) };
      agents[name] = { model: modelSettings };
      config.agents = agents;
      saveConfig(home, config);
      io.out(`  model: ${describeModel(modelSettings)}`);
    }
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

  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Resolve the adapter only after the workspace and agent check out, so an
    // uninitialized workspace or unknown agent fails like every other command
    // (and no adapter is constructed for a run that cannot proceed). The agent's
    // name resolves its own model override, if it has one.
    const made = await resolveAdapter(io, home, agent.name);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }

    // The whole run flow — start, trust-resolve + gate, frame, run, persist — is
    // the kernel's. This surface only supplies host concerns (the substrate, a
    // file reader for soul/skill bodies, the interactive confirm prompt) and
    // formats the structured outcome. The same call backs the HTTP surface, so
    // the trust/gate path cannot drift between them.
    // The catalog is built per-run from the agent's workspace, so each file tool
    // is confined to that agent's directory. The kernel still does the scoping and
    // gating; this only supplies the candidate tools.
    const capabilities = io.capabilities?.(agent.workspaceDir);
    const result = await executeRun(store, agent, task, {
      adapter: made.adapter,
      readFile: (p) => readFileSync(p, "utf8"),
      // Stream the run's activity as it happens. It goes to stderr so the agent's
      // own output on stdout stays clean and pipeable; a tool line per execution
      // is enough to watch progress without flooding the terminal.
      onEvent: (event) => {
        const line = formatRunActivity(event);
        if (line) io.err(line);
      },
      ...(io.confirm ? { confirm: io.confirm } : {}),
      ...(capabilities ? { capabilities } : {}),
    });

    // After a run that can act on its own, surface what it actually did — the gate
    // decisions, to stderr. This is "notify finally notifies": the middle level's
    // promise to show each action afterward, now kept. `propose` returns its plan
    // as the run output, so it needs no separate summary.
    if (agent.trustLevel !== "propose" && result.actions.length > 0) {
      for (const line of formatActionSummary(result.actions)) io.err(line);
    }

    if (result.status === "awaiting_confirmation") {
      io.out("Run paused: a destructive action needs your confirmation before it can proceed.");
      io.out(`Confirm it to continue:  asterism confirm ${name} ${shortId(result.run.id)}`);
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

// --- confirm ---------------------------------------------------------------

/**
 * Resolve a `confirm` run reference to the run and the agent that owns it. Two
 * forms are accepted: `<agent> <run>` (scoped to that agent) and a bare `<run>`
 * (resolved across the operator's own agents). A run reference is a full id or a
 * unique short-id prefix — the same short id `runs`/`run` print. Resolution stays
 * agent-scoped throughout (`store.runs` asserts the agentId on every match), so the
 * bare form is the operator reaching across agents it owns, never one agent's run
 * leaking into another's view.
 */
type RunResolution =
  | { kind: "ok"; agent: Agent; run: Run }
  | { kind: "no_agent"; name: string }
  | { kind: "not_found"; ref: string; agentName?: string }
  | { kind: "ambiguous"; ref: string };

/** Runs in one agent whose id equals, or uniquely begins with, `ref`. */
function matchRuns(store: AsterismStore, agent: Agent, ref: string): Run[] {
  const exact = store.runs.get(agent.id, ref);
  if (exact) return [exact];
  return store.runs.list(agent.id).filter((r) => r.id.startsWith(ref));
}

/**
 * Resolve a run reference — a full id or a unique short-id prefix, the same short
 * id the views print — to one run within a SINGLE agent's scope. Used by the
 * `--run` filters on `memory inspect` and `events tail`: resolution runs entirely
 * through `store.runs` (agent-scoped), so a `--run` value can only ever name one of
 * this agent's own runs, never reach across agents.
 */
type AgentRunMatch =
  | { kind: "ok"; run: Run }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

function matchAgentRun(store: AsterismStore, agent: Agent, ref: string): AgentRunMatch {
  const runs = matchRuns(store, agent, ref);
  if (runs.length === 0) return { kind: "not_found" };
  if (runs.length > 1) return { kind: "ambiguous" };
  return { kind: "ok", run: runs[0]! };
}

function resolveRunRef(store: AsterismStore, positionals: string[]): RunResolution {
  // `<agent> <run>`: resolve within the named agent only.
  if (positionals.length >= 2) {
    const name = positionals[0]!;
    const ref = positionals[1]!;
    const agent = findAgentByName(store, name);
    if (!agent) return { kind: "no_agent", name };
    const runs = matchRuns(store, agent, ref);
    if (runs.length === 0) return { kind: "not_found", ref, agentName: name };
    if (runs.length > 1) return { kind: "ambiguous", ref };
    return { kind: "ok", agent, run: runs[0]! };
  }
  // Bare `<run>`: find the unique owning agent among all of the operator's agents.
  const ref = positionals[0]!;
  const matches: { agent: Agent; run: Run }[] = [];
  for (const agent of store.agents.list()) {
    for (const run of matchRuns(store, agent, ref)) matches.push({ agent, run });
  }
  if (matches.length === 0) return { kind: "not_found", ref };
  if (matches.length > 1) return { kind: "ambiguous", ref };
  return { kind: "ok", agent: matches[0]!.agent, run: matches[0]!.run };
}

async function cmdConfirm(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.confirm!);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    io.err("Usage: asterism confirm [<agent>] <run>");
    return 1;
  }

  return withHomeStore(io, async (store, home) => {
    const resolved = resolveRunRef(store, parsed.positionals);
    if (resolved.kind === "no_agent") return noAgent(io, resolved.name);
    if (resolved.kind === "ambiguous") {
      io.err(
        `"${resolved.ref}" matches more than one run. Use the full id, or name the agent: asterism confirm <agent> <run>.`,
      );
      return 1;
    }
    if (resolved.kind === "not_found") {
      const where = resolved.agentName ? ` for agent ${resolved.agentName}` : "";
      io.err(`No run matching "${resolved.ref}"${where}.`);
      return 1;
    }
    const { agent, run } = resolved;

    // Only a parked run can be confirmed. Say so plainly otherwise — and do not
    // build a model for a run that cannot be resumed (mirrors `run`'s ordering).
    if (run.status !== "awaiting_confirmation") {
      io.err(`Run ${shortId(run.id)} (${agent.name}) is ${run.status} — nothing to confirm.`);
      return 1;
    }

    // The resume runs through the same model that started it — resolve it for the
    // owning agent so a per-agent model is honored on resume too.
    const made = await resolveAdapter(io, home, agent.name);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }

    // The resume is the kernel's: it re-enters the loop with exactly the actions
    // this run was gated on pre-approved, records the grant, and persists the
    // outcome. This surface only streams activity and formats the result.
    //
    // Deliberately NO `confirm` hook here, even though `run` forwards one: this
    // confirm authorizes only the action(s) the run paused on (the reconstructed
    // grant). If the resumed run reaches a *new* destructive action, it must pause
    // again for its own `confirm` — not be approved inline by a prompt during this
    // resume. Omitting the hook keeps the CLI bounded to one confirmation per action,
    // matching the HTTP endpoint and what the docs promise.
    const capabilities = io.capabilities?.(agent.workspaceDir);
    const outcome = await resumeRun(store, agent, run.id, {
      adapter: made.adapter,
      readFile: (p) => readFileSync(p, "utf8"),
      onEvent: (event) => {
        const line = formatRunActivity(event);
        if (line) io.err(line);
      },
      ...(capabilities ? { capabilities } : {}),
    });

    // Defensive: the run could have changed between the check above and the resume.
    if (outcome.kind === "not_found") {
      io.err(`No run ${shortId(run.id)} for agent ${agent.name}.`);
      return 1;
    }
    if (outcome.kind === "not_paused") {
      io.err(
        `Run ${shortId(outcome.run.id)} (${agent.name}) is ${outcome.run.status} — nothing to confirm.`,
      );
      return 1;
    }
    const { result } = outcome;

    // Surface what the resumed run did — the confirmed action now shows as executed.
    if (agent.trustLevel !== "propose" && result.actions.length > 0) {
      for (const line of formatActionSummary(result.actions)) io.err(line);
    }

    if (result.status === "awaiting_confirmation") {
      io.out("Run paused again: another destructive action needs your confirmation.");
      io.out(`Confirm it to continue:  asterism confirm ${agent.name} ${shortId(result.run.id)}`);
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

// --- list ------------------------------------------------------------------

async function cmdList(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.list!);
    return 0;
  }
  return withHomeStore(io, (store) => {
    // Pair each agent with its last-run time for the roster's "last active"
    // line. Per-agent lookup is fine at this scale; the kernel does the scoping
    // (`latest` asserts the agentId), so this surface only assembles the view.
    const entries = store.agents.list().map((agent) => {
      const last = store.runs.latest(agent.id);
      return last ? { agent, lastRunAt: last.startedAt } : { agent };
    });
    io.out(formatAgentList(entries));
    return 0;
  });
}

// --- runs ------------------------------------------------------------------

async function cmdRuns(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.runs!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism runs <agent>");
    return 1;
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    io.out(formatRunList(store.runs.list(agent.id), agent.name));
    return 0;
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
    io.err(
      "Usage: asterism memory inspect <agent> [--type <type>] [--review-state <state>] [--run <run>]",
    );
    return 1;
  }
  // A value-bearing flag given with no value parses as boolean `true`. Reject it
  // rather than silently dropping the filter and showing the unfiltered view.
  for (const flag of ["type", "review-state", "run"] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return 1;
    }
  }
  const typeRaw = stringFlag(parsed.flags.type);
  const reviewRaw = stringFlag(parsed.flags["review-state"]);
  const runRef = stringFlag(parsed.flags.run);
  // An empty `--run=` (e.g. an unset shell variable) must be rejected like a missing
  // value, not treated as a prefix — every run id begins with "", so it would
  // silently match the sole run or trip an ambiguity error on several.
  if (runRef !== undefined && runRef.trim() === "") {
    io.err("The --run option needs a value.");
    return 1;
  }

  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Validate the closed-enum filters through the kernel's chokepoint, so a typo
    // is a clear error rather than a silent empty result.
    const memoryType =
      typeRaw !== undefined ? validateEnum(typeRaw, MEMORY_TYPES, "memory type") : undefined;
    const reviewState =
      reviewRaw !== undefined ? validateEnum(reviewRaw, REVIEW_STATES, "review state") : undefined;

    // Resolve `--run` to one of this agent's own runs (a short id is enough), so the
    // source-run filter is scoped and a bad reference is reported, not ignored.
    let sourceRunId: string | undefined;
    if (runRef !== undefined) {
      const match = matchAgentRun(store, agent, runRef);
      if (match.kind === "not_found") {
        io.err(`No run matching "${runRef}" for ${name}.`);
        return 1;
      }
      if (match.kind === "ambiguous") {
        io.err(`"${runRef}" matches more than one of ${name}'s runs — use a longer id.`);
        return 1;
      }
      sourceRunId = match.run.id;
    }

    const query: MemoryQuery = {
      ...(memoryType !== undefined ? { memoryType } : {}),
      ...(reviewState !== undefined ? { reviewState } : {}),
      ...(sourceRunId !== undefined ? { sourceRunId } : {}),
    };
    const notes: string[] = [];
    if (memoryType !== undefined) notes.push(`type=${memoryType}`);
    if (reviewState !== undefined) notes.push(`review-state=${reviewState}`);
    if (sourceRunId !== undefined) notes.push(`run=${shortId(sourceRunId)}`);
    const filterNote = notes.length > 0 ? notes.join(", ") : undefined;

    io.out(formatMemoryList(store.memories.list(agent.id, query), agent.name, filterNote));
    return 0;
  });
}

// --- events tail -----------------------------------------------------------

async function cmdEventsTail(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h", "follow"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.events!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err(
      "Usage: asterism events tail <agent> [--limit <n>] [--type <type>] [--run <run>] [--since <id>] [--follow]",
    );
    return 1;
  }
  // A value-bearing flag given with no value parses as boolean `true`. Reject it
  // rather than silently dropping the filter. (`--follow` is a genuine boolean.)
  for (const flag of ["limit", "type", "run", "since"] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return 1;
    }
  }
  // A `--limit` that is not a non-negative integer is an error, not a silently
  // ignored value that would show the whole log instead of the cap asked for.
  let limit: number | undefined;
  if (typeof parsed.flags.limit === "string") {
    limit = intFlag(parsed.flags.limit);
    if (limit === undefined) {
      io.err("The --limit option must be a whole number.");
      return 1;
    }
  }
  const type = stringFlag(parsed.flags.type);
  const sinceId = stringFlag(parsed.flags.since);
  const runRef = stringFlag(parsed.flags.run);
  const follow = parsed.flags.follow === true;
  // An empty `--run=` (e.g. an unset shell variable) must be rejected like a missing
  // value, not treated as a prefix that matches every run id.
  if (runRef !== undefined && runRef.trim() === "") {
    io.err("The --run option needs a value.");
    return 1;
  }

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Resolve `--run` to one of this agent's own runs (a short id is enough), so the
    // filter is scoped and a bad reference is reported, not ignored.
    let runId: string | undefined;
    if (runRef !== undefined) {
      const match = matchAgentRun(store, agent, runRef);
      if (match.kind === "not_found") {
        io.err(`No run matching "${runRef}" for ${name}.`);
        return 1;
      }
      if (match.kind === "ambiguous") {
        io.err(`"${runRef}" matches more than one of ${name}'s runs — use a longer id.`);
        return 1;
      }
      runId = match.run.id;
    }

    const options: TailOptions = {
      ...(limit !== undefined ? { limit } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(sinceId !== undefined ? { sinceId } : {}),
      ...(runId !== undefined ? { runId } : {}),
    };
    const notes: string[] = [];
    if (type !== undefined) notes.push(`type=${type}`);
    if (runId !== undefined) notes.push(`run=${shortId(runId)}`);
    const filterNote = notes.length > 0 ? notes.join(", ") : undefined;

    if (follow) return followEvents(store, agent, io, options, filterNote);

    io.out(formatEventList(store.events.tail(agent.id, options), agent.name, filterNote));
    return 0;
  });
}

/**
 * Live `events tail --follow`: print the backlog the one-shot view would show, then
 * stream each new event as it lands until a stop is requested. The store stays open
 * for the whole loop (`withHomeStore` closes it when this resolves). Reads are
 * agent-scoped like every other, so a live tail can no more cross agents than a
 * static one. Without an {@link CliIO.followTick} (a non-interactive embedding) this
 * shows the backlog once and returns — it never loops with nothing able to stop it.
 */
async function followEvents(
  store: AsterismStore,
  agent: Agent,
  io: CliIO,
  options: TailOptions,
  filterNote?: string,
): Promise<number> {
  // Backlog and the resume cursor come from ONE atomic snapshot, so a concurrent
  // append can never slip between them and be dropped — the kernel computes the
  // cursor as the newest matching event as of that snapshot (the true high-water,
  // not the backlog's last row, which lags behind a capped `--limit`/`--since`
  // page or an empty `--limit 0` view).
  const { events: backlog, cursor: initialCursor } = store.events.followSnapshot(
    agent.id,
    options,
  );
  io.out(formatEventList(backlog, agent.name, filterNote));

  const tick = io.followTick;
  if (!tick) return 0;

  // The live stream keeps the type/run filters but drops `limit` — that bounded the
  // backlog, not the tail — and advances by cursor from the snapshot's high-water.
  let cursor = initialCursor;
  const streamBase: TailOptions = {
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  };

  while (await tick()) {
    const fresh = store.events.tail(agent.id, {
      ...streamBase,
      ...(cursor !== undefined ? { sinceId: cursor } : {}),
    });
    for (const e of fresh) for (const line of formatEventLines(e)) io.out(line);
    if (fresh.length > 0) cursor = fresh[fresh.length - 1]!.id;
  }
  return 0;
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

  return withHomeStore(io, async (store, home) => {
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
    // adapter — only after the agent and a reflectable run check out. Resolves this
    // agent's own model, if it has one.
    const context: ModelResolutionContext = { config: loadConfig(home), agentName: agent.name };
    const made = io.makeReflectionProvider
      ? io.makeReflectionProvider(io.env, context)
      : (await import("./reflect-model.js")).buildReflectionProvider(io.env, context);
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

// --- config ----------------------------------------------------------------

/** The ASTERISM_MODEL_* variables, in field order, for the env-override notice. */
const MODEL_ENV_VARS = [
  "ASTERISM_MODEL_ID",
  "ASTERISM_MODEL_PROVIDER",
  "ASTERISM_MODEL_BASE_URL",
  "ASTERISM_MODEL_API",
] as const;

/** Whether a settings object has any field set. */
function hasSettings(settings: ModelSettings | undefined): settings is ModelSettings {
  return settings !== undefined && Object.keys(settings).length > 0;
}

async function cmdConfig(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.config!);
    return 0;
  }
  const sub = parsed.positionals[0];
  if (sub === undefined || sub === "show") return cmdConfigShow(io);
  if (sub === "set") return cmdConfigSet(parsed, io);
  if (sub === "unset") return cmdConfigUnset(parsed, io);
  io.err(`Unknown subcommand: config ${sub}`);
  io.out(COMMAND_HELP.config!);
  return 1;
}

/** `asterism config` / `config show` — the effective configuration, per agent. */
function cmdConfigShow(io: CliIO): Promise<number> {
  return withHomeStore(io, (store, home) => {
    const config = loadConfig(home);
    io.out(`Configuration  (${configPath(home)})`);
    io.out("");
    io.out(
      hasSettings(config.model)
        ? `Install default model: ${describeModel(config.model)}`
        : "Install default model: (none set)",
    );

    const envSet = MODEL_ENV_VARS.filter((k) => io.env[k] !== undefined);
    if (envSet.length > 0) {
      io.out(`Environment override:  ${envSet.join(", ")} set — overrides the config file.`);
    }

    io.out("");
    io.out("Per-agent model:");
    const agents = store.agents.list();
    if (agents.length === 0) {
      io.out("  (no agents yet)");
    } else {
      for (const agent of agents) {
        const override = config.agents?.[agent.name]?.model;
        const { model } = resolveModelConfig(io.env, { config, agentName: agent.name });
        const resolved = model ? `${model.id} (provider: ${model.provider})` : "(no model — set one)";
        // Name the source of the resolved id — the headline coordinate.
        const source = hasSettings(override) && override.id !== undefined
          ? "agent override"
          : io.env.ASTERISM_MODEL_ID !== undefined
            ? "environment"
            : config.model?.id !== undefined
              ? "install default"
              : "unset";
        io.out(`  ${agent.name}  →  ${resolved}  [${source}]`);
      }
    }

    io.out("");
    io.out("API keys are never stored here — set them in the environment (e.g. OPENAI_API_KEY).");
    return 0;
  });
}

/** `asterism config set <id> [flags] [--agent <name>]` — write a default or override. */
function cmdConfigSet(parsed: ParsedArgs, io: CliIO): Promise<number> {
  for (const flag of ["agent", ...MODEL_FLAGS] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return Promise.resolve(1);
    }
  }
  // The model id may be given positionally (`config set gpt-4o`) or via --model;
  // the positional is the ergonomic form. Other coordinates are flags only.
  const settings = modelSettingsFromFlags(parsed);
  const positionalId = parsed.positionals[1];
  if (positionalId !== undefined) settings.id = positionalId;
  if (!hasSettings(settings)) {
    io.err(
      "Usage: asterism config set <model-id> [--provider <p>] [--base-url <url>] " +
        "[--api <protocol>] [--agent <name>]",
    );
    return Promise.resolve(1);
  }
  const agentName = stringFlag(parsed.flags.agent);

  return withHomeStore(io, (store, home) => {
    // A per-agent override is keyed by agent name; require the agent to exist so a
    // typo'd name does not become a silently useless entry.
    if (agentName !== undefined && !findAgentByName(store, agentName)) {
      return noAgent(io, agentName);
    }
    const config = loadConfig(home);
    if (agentName !== undefined) {
      const agents = { ...(config.agents ?? {}) };
      agents[agentName] = { model: settings };
      config.agents = agents;
    } else {
      config.model = settings;
    }
    saveConfig(home, config);
    const where = agentName !== undefined ? `agent "${agentName}"` : "the install default";
    io.out(`Set the model for ${where}: ${describeModel(settings)}.`);
    io.out("API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).");
    return 0;
  });
}

/** `asterism config unset [--agent <name>]` — clear a default or override. */
function cmdConfigUnset(parsed: ParsedArgs, io: CliIO): Promise<number> {
  if (parsed.flags.agent === true) {
    io.err("The --agent option needs a value.");
    return Promise.resolve(1);
  }
  const agentName = stringFlag(parsed.flags.agent);

  return withHomeStore(io, (_store, home) => {
    const config = loadConfig(home);
    if (agentName !== undefined) {
      if (config.agents?.[agentName] === undefined) {
        io.out(`No model override set for agent "${agentName}".`);
        return 0;
      }
      const agents = { ...config.agents };
      delete agents[agentName];
      config.agents = agents;
      saveConfig(home, config);
      io.out(`Cleared the model override for agent "${agentName}".`);
      return 0;
    }
    if (config.model === undefined) {
      io.out("No install default model set.");
      return 0;
    }
    delete config.model;
    saveConfig(home, config);
    io.out("Cleared the install default model.");
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

  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Build the substrate the same way `run` does, resolving this agent's own
    // model. A missing model is not fatal for serving: the read endpoints work
    // regardless, and a run started without one is declined with a clear message
    // rather than failing to serve at all.
    const made = await resolveAdapter(io, home, agent.name);

    // Built once for the served agent, the same way `run` builds it — so a run
    // started over HTTP sees the identical tool catalog, confined to this agent's
    // workspace, that the command line would give it.
    const capabilities = io.capabilities?.(agent.workspaceDir);

    // The kernel store stays open for the server's lifetime — `withHomeStore`
    // closes it only after this callback returns, which it does once shutdown is
    // requested below. The HTTP surface is bound to THIS agent alone.
    const server = await startServer({
      store,
      agent,
      ...(made.adapter ? { adapter: made.adapter } : {}),
      ...(made.reason !== undefined ? { adapterReason: made.reason } : {}),
      readFile: (p) => readFileSync(p, "utf8"),
      ...(capabilities ? { capabilities } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { hostname: host } : {}),
    });

    io.out(`Serving agent "${agent.name}" at ${server.url}`);
    io.out(`  POST ${server.url}/agents/${agent.name}/runs    start a run  (JSON body: {"input":"<task>"})`);
    io.out(`  POST ${server.url}/agents/${agent.name}/runs/<run>/confirm    approve a paused run`);
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

// --- channel telegram (chat-app front door) --------------------------------

/** The env var holding the Telegram bot token. Secrets stay out of config/flags. */
const TELEGRAM_TOKEN_ENV = "ASTERISM_TELEGRAM_TOKEN";
/** The env var holding a comma-separated allow-list, combined with `--allow`. */
const TELEGRAM_ALLOW_ENV = "ASTERISM_TELEGRAM_ALLOW";

/** Split a comma-separated allow-list value into trimmed, non-empty chat ids. */
function parseAllowList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function cmdChannelTelegram(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.channel!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism channel telegram <agent> [--allow <chat-id>[,<chat-id>...]]");
    return 1;
  }
  // A value-bearing flag given bare parses as boolean `true`; reject it rather than
  // silently treating "--allow" as no allow-list.
  if (parsed.flags.allow === true) {
    io.err("The --allow option needs a value (a comma-separated list of chat ids).");
    return 1;
  }

  if (!io.startTelegram) {
    io.err("Chat channels are not available in this embedding.");
    return 1;
  }
  const startTelegram = io.startTelegram;

  // The bot token is a secret: it comes from the environment, never config or a flag.
  const token = io.env[TELEGRAM_TOKEN_ENV];
  if (!token) {
    io.err(
      `Set ${TELEGRAM_TOKEN_ENV} to your bot token (create a bot with @BotFather) before starting the channel.`,
    );
    return 1;
  }

  // The allow-list is the channel's access boundary — the chats permitted to drive
  // the agent. The flag and the env var are combined. An empty list is allowed: the
  // bot starts in discovery mode (it refuses every message but replies with the
  // sender's chat id), so you can learn your id and re-run with --allow. Nothing the
  // agent can do is ever exposed to an unauthorized chat either way.
  const allow = new Set<string>([
    ...parseAllowList(stringFlag(parsed.flags.allow)),
    ...parseAllowList(io.env[TELEGRAM_ALLOW_ENV]),
  ]);

  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Unlike `serve` (whose read endpoints work without one), a chat channel has no
    // value without a model — every message is a task. Require it, and decline
    // clearly rather than starting a bot that can answer nothing.
    const made = await resolveAdapter(io, home, agent.name);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }
    const adapter = made.adapter;

    // Built the same way `run`/`serve` build it, so a run started from chat sees the
    // identical tool catalog, confined to this agent's workspace.
    const capabilities = io.capabilities?.(agent.workspaceDir);

    const channel = await startTelegram({
      store,
      agent,
      adapter,
      readFile: (p) => readFileSync(p, "utf8"),
      ...(capabilities ? { capabilities } : {}),
      allow,
      token,
    });

    const who = channel.botUsername ? `@${channel.botUsername}` : "the bot";
    io.out(`Listening as ${who} for agent "${agent.name}".`);
    if (allow.size === 0) {
      io.out("  No authorized chats yet — every message is refused, but the bot replies");
      io.out("  with the sender's chat id. Re-run with --allow <id> to let a chat in.");
    } else {
      const s = allow.size === 1 ? "" : "s";
      io.out(`  ${allow.size} authorized chat${s}; messages from any other chat are refused.`);
    }
    io.out("  A destructive action pauses the run and asks the chat to reply /confirm.");
    io.out("Press Ctrl+C to stop.");

    // Block until shutdown, then stop the channel BEFORE returning — awaiting the
    // stop lets the in-flight poll unwind, so the store (closed once this callback
    // returns) is never pulled out from under a run still being handled.
    const waitForShutdown = io.waitForShutdown ?? (() => Promise.resolve());
    await waitForShutdown();
    await channel.stop();
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
    case "confirm":
      return cmdConfirm(rest, io);
    case "runs":
      return cmdRuns(rest, io);
    case "list":
      return cmdList(rest, io);
    case "reflect":
      return cmdReflect(rest, io);
    case "config":
      return cmdConfig(rest, io);
    case "serve":
      return cmdServe(rest, io);
    case "channel":
      return dispatchSub("channel", "telegram", cmdChannelTelegram, COMMAND_HELP.channel!, rest, io);
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
