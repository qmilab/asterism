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
  auditTrustHooks,
  BUILTIN_SOULS,
  frameRun,
  resolveSoul,
  resolveToolRegistry,
  trustProfile,
  TRUST_LEVELS,
  validateEnum,
} from "@qmilab/asterism-core";
import type {
  Action,
  Agent,
  Capability,
  RuntimeAdapter,
  SkillContext,
  TailOptions,
  TrustHooks,
  TrustLevel,
} from "@qmilab/asterism-core";

import { helpRequested, intFlag, parseArgs, stringFlag } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { formatEventList, formatMemoryList } from "./format.js";
import { COMMAND_HELP, USAGE } from "./help.js";
import {
  agentWorkspace,
  createHome,
  dbPath,
  findHome,
  isValidAgentName,
} from "./paths.js";
import { VERSION } from "./version.js";

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
  /** Read piped standard input (for `secrets add` without an inline value). */
  readStdin?: () => Promise<string | undefined>;
  /** Build the run adapter. Absent ⇒ the default wiring reads it from the environment. */
  makeAdapter?: (env: CliIO["env"]) => {
    adapter?: RuntimeAdapter;
    reason?: string;
  };
  /** Open the kernel store at a path. Absent ⇒ the real local SQLite store. */
  openStore?: (path: string) => AsterismStore;
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
  const role = stringFlag(parsed.flags.role) ?? "";
  const trustLevel = stringFlag(parsed.flags.trust) ?? "propose";

  // Resolve the soul reference now, while we still know the directory the user
  // invoked from. A built-in name is stored verbatim; anything else is a file
  // path, captured as an absolute path so `run` reads the same soul no matter
  // which subdirectory it is later invoked from (the home is discovered upward).
  let soulRef = stringFlag(parsed.flags.soul) ?? "casual-helper";
  let soulNote: string | undefined;
  if (!(soulRef in BUILTIN_SOULS)) {
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

/** Read a file's text, or undefined if it cannot be read (skills are optional). */
function readMaybe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

async function cmdRun(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.run!);
    return 0;
  }
  const name = parsed.positionals[0];
  const task = parsed.positionals[1];
  if (!name || !task) {
    io.err('Usage: asterism run <agent> "<task>"');
    return 1;
  }

  const made = io.makeAdapter
    ? io.makeAdapter(io.env)
    : (await import("./model.js")).buildAdapterFromEnv(io.env);
  if (!made.adapter) {
    io.err(made.reason ?? "No model configured.");
    return 1;
  }
  const adapter = made.adapter;

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Record the run and move it to `running` (each transition is logged by the
    // kernel). Then resolve the agent's trust into the tool set this run may use.
    const run = store.startRun(agent.id, { input: task });
    store.setRunStatus(agent.id, run.id, "running");

    const abortController = new AbortController();
    const profile = trustProfile({ level: agent.trustLevel });
    // Phase 0 registers no capabilities yet — confined by default means an empty
    // tool set. The gate wiring below is in place for when tools land.
    const capabilities: Capability[] = [];
    const baseHooks: TrustHooks = {
      onAwaitConfirmation: () => {
        store.setRunStatus(agent.id, run.id, "awaiting_confirmation");
      },
      abortController,
      ...(io.confirm ? { confirm: io.confirm } : {}),
    };
    const hooks = auditTrustHooks(store.events, agent.id, { runId: run.id }, baseHooks);
    const tools = resolveToolRegistry(profile, capabilities, hooks);

    // Frame the run from the agent's identity: soul, role, scoped skills, and the
    // memories it has accepted (framing filters to active + accepted).
    const soulText = resolveSoul(agent.soulRef, {
      readFile: (p) => readFileSync(p, "utf8"),
    });
    const skills: SkillContext[] = store.skills.list(agent.id).map((s) => {
      const content = readMaybe(s.path);
      return { name: s.name, ...(content !== undefined ? { content } : {}) };
    });
    const memories = store.memories.list(agent.id);
    const request = frameRun({
      agent,
      ...(soulText !== undefined ? { soulText } : {}),
      skills,
      memories,
      input: task,
      tools,
      signal: abortController.signal,
    });

    const handle = adapter.run(request);
    const output = await handle.output;

    // If a destructive action paused the run, the kernel already flipped it to
    // awaiting_confirmation — leave it there rather than forcing a terminal state.
    const current = store.runs.get(agent.id, run.id);
    if (current?.status === "awaiting_confirmation") {
      io.out("Run paused: a destructive action needs your confirmation before it can proceed.");
      return 0;
    }
    if (output.status === "done") {
      store.setRunStatus(agent.id, run.id, "done");
      io.out(output.text.trim().length > 0 ? output.text : "(the agent produced no output)");
      return 0;
    }
    store.setRunStatus(agent.id, run.id, "failed");
    io.err(`Run failed: ${output.error ?? "unknown error"}`);
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

// --- reflect / serve (surface present; engines land in later build steps) ---

async function cmdReflect(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h", "review"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.reflect!);
    return 0;
  }
  io.err("Reviewing proposed memories is coming soon — it is not wired up in this build yet.");
  return 1;
}

async function cmdServe(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.serve!);
    return 0;
  }
  io.err("Serving an agent over HTTP is coming soon — it is not wired up in this build yet.");
  return 1;
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
