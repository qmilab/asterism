// The `asterism` command surface. Thin by mandate (CLAUDE.md): every handler
// parses arguments, calls one or more kernel operations, and formats the result.
// No business logic, no scoping decisions, no trust reasoning — those live in the
// kernel and are merely invoked here. The dispatcher is injectable end-to-end
// (cwd, env, output sinks, store factory, adapter factory, confirm prompt,
// capability exposure) so the whole surface is testable without touching the
// real filesystem-of-record.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import {
  acceptProposedMemory,
  acceptProposedObjective,
  BUILTIN_SOULS,
  COGNITION_CAPTURE_MODES,
  COGNITION_PROVIDER_IDS,
  DEFAULT_RECALL_BUDGET,
  DEFAULT_STANDING_POLICY,
  DEFAULT_WORLD_FACT_CAP,
  executeRun,
  MEMORY_TYPES,
  MemoryFirewallError,
  proposeReviewableMemories,
  proposeReviewableObjectives,
  proposeStandingGrants,
  queueProposals,
  RECALL_PROVIDER_IDS,
  rejectProposedMemory,
  rejectProposedObjective,
  resolveStandingPolicy,
  resumeRun,
  REVIEW_STATES,
  screenMemory,
  TRUST_LEVELS,
  unreflectedRuns,
  validateEnum,
  WorldFactCapError,
} from "@qmilab/asterism-core";
import type {
  Action,
  Agent,
  Capability,
  CognitionCaptureMode,
  CognitionProviderId,
  FirewallFinding,
  Memory,
  MemoryQuery,
  Objective,
  ObjectiveStatus,
  RecallProvider,
  RecallProviderId,
  ReflectionProvider,
  ReviewableObjectiveProposal,
  ReviewableProposal,
  Run,
  RuntimeAdapter,
  StandingPolicy,
  StandingThresholds,
  TailOptions,
  TrustLevel,
} from "@qmilab/asterism-core";
import type { RunningServer, ServeConsoleOptions, ServeOptions } from "@qmilab/asterism-server";
import type { ChannelHandle, DiscordOptions, TelegramOptions } from "@qmilab/asterism-channels";

import { DashboardClient } from "./dashboard/client.js";
import { runDashboard } from "./dashboard/tui.js";
import type { TerminalIO } from "./dashboard/tui.js";

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
  formatObjectiveList,
  formatRunActivity,
  formatRunList,
  formatStandingList,
  formatWorldFactList,
  shortId,
} from "./format.js";
import { COMMAND_HELP, USAGE } from "./help.js";
import type { ModelResolutionContext } from "./model-config.js";
import { providerKeyEnvVar, resolveModelConfig } from "./model-config.js";
import {
  isServiceKind,
  launchdLabel,
  renderEnvFile,
  renderEnvTemplate,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWrapper,
  serviceCommand,
  SERVICE_KINDS,
  systemdUnitName,
} from "./service.js";
import type { EnvVarSpec, ServiceKind } from "./service.js";
import {
  agentWorkspace,
  configPath,
  createHome,
  dbPath,
  findHome,
  isValidAgentName,
  tracesDir,
} from "./paths.js";
import { HTTP_TOKEN_ENV, resolveConsoleToken, resolveHttpToken } from "./http-token.js";
import type { ResolvedHttpToken } from "./http-token.js";
import { VERSION } from "./version.js";

/** A proposed memory or objective presented for review, with any firewall findings on it. */
export interface ReviewItem {
  /** 1-based position in the batch. */
  index: number;
  total: number;
  /** What kind of proposal this is — the memory type for a memory, `"objective"` for an objective. */
  label: string;
  /**
   * The memory type, for a memory proposal; ABSENT for an objective. Kept (alongside `label`)
   * for backward compatibility — existing reviewers may branch on `memoryType`. Use `label`
   * as the discriminator when an objective must be told apart from a memory.
   */
  memoryType?: string;
  content: string;
  /** The provider's confidence, when known. Absent for a queued objective (objectives persist none). */
  confidence?: number;
  /** Firewall findings on the proposed content; empty when it screens clean. */
  findings: readonly FirewallFinding[];
}

/** The reviewer's verdict on one proposed memory or objective during `reflect --review`. */
export type ReviewDecision =
  | { kind: "accept" }
  | { kind: "edit"; content: string }
  | { kind: "reject" };

/** A proposed standing grant presented for ratification during `trust <agent> --review`. */
export interface StandingReviewItem {
  /** 1-based position in the batch. */
  index: number;
  total: number;
  /** The destructive capability proposed for an auto-approve grant. */
  capability: string;
  /** The references-only evidence basis (counts of clean executions / targets / regressions). */
  basis: string;
}

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
   * Build the opt-in recall provider for an agent that has selected one. Absent ⇒ the
   * default wiring builds the local-embeddings provider from the environment
   * (`recall-provider.ts`, lazily imported). Only consulted when the agent's
   * `recallProvider` setting is set; an unset agent always uses the kernel's built-in
   * lexical ranker and this is never called. `onDegrade` is wired to a loud stderr line
   * for the run-time fallback when the endpoint is unreachable.
   */
  makeRecallProvider?: (
    env: CliIO["env"],
    options: { onDegrade?: (error: unknown) => void },
  ) => {
    provider?: RecallProvider;
    reason?: string;
  };
  /**
   * Wrap a run adapter in an agent's opt-in cognition provider (the auditable trace).
   * Absent ⇒ the default wiring lazily imports `@qmilab/asterism-adapter-lodestar`.
   * Only consulted for an agent whose `cognitionProvider` setting is SET; an unset
   * agent's adapter is returned unchanged and this is never called. Observe-only: the
   * wrapper records a trace, it never gates. `captureContent` carries the agent's
   * resolved capture escalation (the `cognitionCapture` setting): true ⇒ also record
   * redacted output content, false ⇒ references only.
   */
  makeCognitionAdapter?: (
    adapter: RuntimeAdapter,
    agentId: string,
    captureContent: boolean,
  ) => RuntimeAdapter;
  /**
   * Render an agent's recorded cognition trace for `asterism trace`. Absent ⇒ the
   * default wiring lazily imports the Lodestar renderer. Returns `undefined` when the
   * agent has recorded no trace. The first argument is the host TRACE ROOT (the install
   * home's `traces/`, off the agent workspace); reads only the agent's own partition.
   */
  renderCognitionTrace?: (
    traceRoot: string,
    agentId: string,
  ) => Promise<string | undefined>;
  /**
   * Decide a proposed memory's fate during `reflect --review`. Absent ⇒ reject
   * every proposal, so nothing persists — the same safe default as `confirm`.
   */
  review?: (item: ReviewItem) => ReviewDecision | Promise<ReviewDecision>;
  /**
   * Ratify a proposed standing grant during `trust <agent> --review` — return true
   * to grant the capability an auto-approve standing, false to leave it gated. Absent
   * ⇒ reject every proposal, so nothing is granted without an explicit yes (the same
   * safe default as `confirm`/`review`; earning autonomy is itself a reviewable act).
   */
  reviewGrant?: (item: StandingReviewItem) => boolean | Promise<boolean>;
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
   * Start the install-wide operator console for `dashboard` (the TUI's thin backend,
   * and the server `--headless` runs). Absent ⇒ the dashboard cannot self-host in
   * this embedding (the default wiring in `bin.ts` supplies the real server). Like
   * {@link CliIO.startServer}, the store stays open for the console's lifetime.
   */
  startConsole?: (options: ServeConsoleOptions) => RunningServer | Promise<RunningServer>;
  /**
   * The interactive terminal the `dashboard` TUI draws to (raw input + sized output).
   * Absent ⇒ the dashboard's interactive view is unavailable here (a non-interactive
   * embedding), so `dashboard` reports that and exits rather than rendering to
   * nothing. The default wiring in `bin.ts` supplies one over stdin/stdout when
   * attached to a TTY.
   */
  terminal?: TerminalIO;
  /**
   * Start a Telegram chat channel for `channel telegram`. Absent ⇒ chat channels
   * are unavailable in this embedding (the default wiring in `bin.ts` supplies the
   * real transport). Like {@link CliIO.startServer}, the store stays open for the
   * channel's lifetime, so the handler returns only after
   * {@link CliIO.waitForShutdown} resolves.
   */
  startTelegram?: (options: TelegramOptions) => ChannelHandle | Promise<ChannelHandle>;
  /**
   * Start a Discord chat channel for `channel discord`. Absent ⇒ chat channels are
   * unavailable in this embedding (the default wiring in `bin.ts` supplies the real
   * transport). The same contract as {@link CliIO.startTelegram}: the store stays
   * open for the channel's lifetime, so the handler returns only after
   * {@link CliIO.waitForShutdown} resolves.
   */
  startDiscord?: (options: DiscordOptions) => ChannelHandle | Promise<ChannelHandle>;
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
  /**
   * The host platform, which decides the service manager `service` targets:
   * launchd on `darwin`, systemd on `linux`. Absent ⇒ unsupported (the default
   * wiring in `bin.ts` supplies `process.platform`). Injectable so a test can drive
   * either platform on any host.
   */
  platform?: string;
  /**
   * The absolute argv prefix that re-launches THIS CLI, e.g. `[node, bin.js]`. A
   * generated service runs with a minimal PATH, so `service install` bakes in an
   * absolute launcher rather than relying on `asterism` being found. Absent ⇒
   * `service install` declines. The default wiring supplies
   * `[process.execPath, <bin.js>]`.
   */
  selfInvocation?: readonly string[];
  /**
   * Run an external command and capture its result — how `service` reaches
   * `launchctl`/`systemctl`. Absent ⇒ the service files are still written, but
   * registering with the OS service manager is skipped. A non-zero `code` is data,
   * not a throw: callers read it (e.g. `is-active` reports state through its code).
   */
  runCommand?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
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
  agent: Agent,
  store: AsterismStore,
): Promise<{ adapter?: RuntimeAdapter; reason?: string }> {
  const context: ModelResolutionContext = { config: loadConfig(home), agentName: agent.name };
  const made = io.makeAdapter
    ? io.makeAdapter(io.env, context)
    : (await import("./model.js")).buildAdapter(io.env, context);
  if (!made.adapter) return made;
  // Cognition wrapping is applied HERE — the single seam every run-bearing surface
  // (run, confirm, serve, console, channels) resolves its adapter through — so they
  // cannot drift on whether a run is traced. An agent with no `cognitionProvider`
  // setting is returned unchanged (the default Pi loop, no trace); an opted-in agent
  // has its adapter wrapped, lazily, so the default install never loads Lodestar.
  return { ...made, adapter: await wrapCognition(io, store, agent, made.adapter, tracesDir(home)) };
}

/**
 * Wrap a run adapter in the agent's opt-in cognition provider, or return it unchanged
 * when the agent has not opted in. The selection is `agentId`-scoped
 * (`getCognitionProvider`), so it is resolved only from the agent's own setting. The
 * provider package is imported LAZILY and ONLY on the opted-in path, mirroring recall —
 * an install that never opts in never loads Lodestar. Observe-only: the wrapper records
 * an auditable trace, it never gates (the kernel stays the sole trust authority). The
 * trace is written under `traceRoot` (the install home's `traces/`), OUTSIDE the agent's
 * tool-writable workspace, so the agent cannot tamper with its own audit trail.
 */
async function wrapCognition(
  io: CliIO,
  store: AsterismStore,
  agent: Agent,
  adapter: RuntimeAdapter,
  traceRoot: string,
): Promise<RuntimeAdapter> {
  const selection = store.agentSettings.getCognitionProvider(agent.id);
  if (selection === undefined) return adapter; // default: the Pi loop, no trace
  // The capture escalation is a SEPARATE opt-in: references-only unless `cognitionCapture`
  // is "content". Resolved here (agentId-scoped) and passed as an explicit flag — the
  // wrapper reads no setting itself (golden rule 2). Inert without a provider, so it is
  // only consulted on this opted-in path.
  const captureContent = store.agentSettings.getCognitionCapture(agent.id) === "content";
  // Today the only selection is "lodestar"; the kernel validated it at the write boundary.
  if (io.makeCognitionAdapter) return io.makeCognitionAdapter(adapter, agent.id, captureContent);
  const { wrapWithLodestar } = await import("@qmilab/asterism-adapter-lodestar");
  return wrapWithLodestar(adapter, { agentId: agent.id, traceRoot, captureContent });
}

/**
 * Resolve the recall provider for a run. An agent with no `recallProvider` setting
 * uses the kernel's built-in lexical ranker — so this returns nothing and the run
 * omits `options.recall` (`executeRun` defaults to it). An agent opted into a provider
 * (today only `local`) has it built from the environment, LAZILY — the recall-local
 * package is imported only on this path, so an install that never opts in never loads
 * it. A `reason` means opted-in-but-misconfigured (no endpoint): the caller hard-fails
 * so the mistake is visible, never silently downgraded to keyword ranking.
 *
 * The read is `agentId`-scoped (`getRecallProvider`), so an agent's selection is
 * resolved only from its own setting, never another's.
 */
async function resolveRecall(
  io: CliIO,
  store: AsterismStore,
  agent: Agent,
): Promise<{ provider?: RecallProvider; reason?: string }> {
  const selection = store.agentSettings.getRecallProvider(agent.id);
  if (selection === undefined) return {}; // built-in lexical ranker
  const onDegrade = (error: unknown) =>
    io.err(
      `Recall: the local embeddings endpoint was unreachable (${errorMessage(error)}); ` +
        "framed memory by keyword instead.",
    );
  const made = io.makeRecallProvider
    ? io.makeRecallProvider(io.env, { onDegrade })
    : (await import("./recall-provider.js")).buildEmbeddingRecallProvider(io.env, { onDegrade });
  return made;
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

const TRUST_USAGE =
  "Usage: asterism trust <agent> <propose|notify|autonomous>  ·  --review  ·  show  ·  revoke <capability>  ·  threshold";

async function cmdTrust(args: string[], io: CliIO): Promise<number> {
  // `--unset` is boolean so `trust <agent> threshold --unset` never consumes a
  // following token as its value; `--clean` / `--targets` carry the threshold values.
  const parsed = parseArgs(args, ["help", "h", "review", "unset"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.trust!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err(TRUST_USAGE);
    return 1;
  }
  // `trust <agent> --review` ratifies EARNED per-capability standing grants; the
  // positional forms set the whole-agent level (`<level>`) or manage standing
  // (`show`, `revoke <capability>`, `threshold`). The level form is unchanged for
  // back-compat.
  if (parsed.flags.review === true) return cmdTrustReview(name, io);
  const sub = parsed.positionals[1];
  if (sub === "show") return cmdTrustShow(name, io);
  if (sub === "revoke") return cmdTrustRevoke(name, parsed.positionals[2], io);
  if (sub === "threshold") return cmdTrustThreshold(name, parsed, io);
  if (!sub) {
    io.err(TRUST_USAGE);
    return 1;
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    validateEnum(sub, TRUST_LEVELS, "trust level");
    const updated = store.setTrust(agent.id, sub as TrustLevel);
    io.out(`Set ${updated.name} to ${updated.trustLevel}.`);
    return 0;
  });
}

/**
 * `asterism trust <agent> --review` — ratify EARNED standing grants. The kernel
 * proposes which destructive capabilities have a clean enough track record (read
 * from the agent's own event log; no model needed — this is evidence, not
 * reflection); the human grants or declines each. A grant lets that capability
 * auto-approve from now on, exactly as if it had been allow-listed — nothing is
 * granted without an explicit yes (default reject), so earning autonomy stays a
 * reviewable, human-ratified act.
 */
async function cmdTrustReview(name: string, io: CliIO): Promise<number> {
  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    const candidates = proposeStandingGrants(store, agent);
    if (candidates.length === 0) {
      io.out(`${name}: no capabilities have earned a standing grant yet.`);
      io.out("An agent earns one by handling a destructive capability cleanly, several");
      io.out("times, across different targets, with nothing declined or failed in between.");
      return 0;
    }

    io.out(
      `Reviewing ${candidates.length} earned ${candidates.length === 1 ? "capability" : "capabilities"} for ${name}.`,
    );
    io.out("Granting one lets that capability act without pausing for you — until a");
    io.out("regression takes it back. Nothing is granted unless you accept it.");

    // Absent reviewer ⇒ reject everything: nothing is granted without an explicit yes.
    const review = io.reviewGrant ?? ((): boolean => false);
    let granted = 0;
    let declined = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      io.out("");
      io.out(`(${i + 1}/${candidates.length}) ${c.capability}`);
      io.out(`  ${c.basis}`);

      const accept = await review({ index: i + 1, total: candidates.length, capability: c.capability, basis: c.basis });
      if (!accept) {
        declined++;
        io.out("  ✗ left gated");
        continue;
      }
      store.setCapabilityStanding(agent.id, c.capability, "standing-grant", c.basis);
      granted++;
      io.out("  ✓ granted — acts without pausing from now on");
    }

    io.out("");
    io.out(`Done — ${granted} granted, ${declined} left gated.`);
    return 0;
  });
}

/** One line describing an earning bar — shared by `trust show` and `trust threshold`. */
function describeEarningBar(policy: StandingPolicy): string {
  const execs = `${policy.minCleanExecutions} clean execution${policy.minCleanExecutions === 1 ? "" : "s"}`;
  const targets = `${policy.minDistinctTargets} distinct target${policy.minDistinctTargets === 1 ? "" : "s"}`;
  return `${execs} across ${targets}`;
}

/** `asterism trust <agent> show` — the agent's whole-agent level plus its earned standings. */
async function cmdTrustShow(name: string, io: CliIO): Promise<number> {
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    io.out(formatStandingList(store.capabilityStanding.list(agent.id), agent.name, agent.trustLevel));
    // The earning bar a capability must clear to be PROPOSED — defaulted, or this
    // agent's own override (set via `trust <agent> threshold`).
    const overrides = store.agentSettings.getStandingThresholds(agent.id);
    const custom =
      overrides.minCleanExecutions !== undefined || overrides.minDistinctTargets !== undefined;
    io.out("");
    io.out(
      `Earning bar: ${describeEarningBar(resolveStandingPolicy(store, agent))} ${custom ? "[customized]" : "[default]"}.`,
    );
    return 0;
  });
}

/**
 * `asterism trust <agent> threshold [--clean <n>] [--targets <n>]` / `--unset` —
 * read or tune the bar a destructive capability must clear before it is PROPOSED for
 * an auto-approve grant. With `--clean` and/or `--targets`, sets the per-agent
 * override(s); with `--unset`, clears both back to the kernel default; with neither,
 * shows the current bar. The gate is never weakened — this only changes how much
 * track record review asks for; nothing auto-approves without a human grant.
 */
function cmdTrustThreshold(name: string, parsed: ParsedArgs, io: CliIO): Promise<number> {
  const cleanGiven = parsed.flags.clean !== undefined;
  const targetsGiven = parsed.flags.targets !== undefined;
  const unset = parsed.flags.unset === true;
  const DEFAULTS = describeEarningBar(DEFAULT_STANDING_POLICY);

  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    if (unset) {
      const had = store.agentSettings.getStandingThresholds(agent.id);
      if (had.minCleanExecutions === undefined && had.minDistinctTargets === undefined) {
        io.out(`${name} had no custom earning bar — it already uses the default (${DEFAULTS}).`);
        return 0;
      }
      store.clearStandingThresholds(agent.id);
      io.out(`Cleared ${name}'s earning bar — back to the default (${DEFAULTS}).`);
      return 0;
    }

    // No flags: show the effective bar and label each half's source.
    if (!cleanGiven && !targetsGiven) {
      const overrides = store.agentSettings.getStandingThresholds(agent.id);
      const effective = resolveStandingPolicy(store, agent);
      io.out(`${name}'s earning bar: ${describeEarningBar(effective)}.`);
      io.out(
        `  clean executions: ${effective.minCleanExecutions} [${overrides.minCleanExecutions !== undefined ? "set" : "default"}]`,
      );
      io.out(
        `  distinct targets: ${effective.minDistinctTargets} [${overrides.minDistinctTargets !== undefined ? "set" : "default"}]`,
      );
      return 0;
    }

    // Each provided value must be a positive whole number. `intFlag` parses a
    // non-negative integer; reject 0, a negative (parsed as a value, never a flag),
    // and anything non-numeric with a clear message rather than a raw kernel error.
    const thresholds: StandingThresholds = {};
    if (cleanGiven) {
      const value = intFlag(parsed.flags.clean);
      if (value === undefined || value <= 0) {
        io.err("--clean must be a positive whole number.");
        return 1;
      }
      thresholds.minCleanExecutions = value;
    }
    if (targetsGiven) {
      const value = intFlag(parsed.flags.targets);
      if (value === undefined || value <= 0) {
        io.err("--targets must be a positive whole number.");
        return 1;
      }
      thresholds.minDistinctTargets = value;
    }
    store.setStandingThresholds(agent.id, thresholds);
    io.out(`Set ${name}'s earning bar to ${describeEarningBar(resolveStandingPolicy(store, agent))}.`);
    return 0;
  });
}

/** `asterism trust <agent> revoke <capability>` — downgrade an earned grant back to gated. */
async function cmdTrustRevoke(
  name: string,
  capability: string | undefined,
  io: CliIO,
): Promise<number> {
  if (!capability) {
    io.err("Usage: asterism trust <agent> revoke <capability>");
    return 1;
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    const current = store.capabilityStanding.get(agent.id, capability);
    if (!current || current.standing !== "standing-grant") {
      io.out(`${name}: '${capability}' is not granted — nothing to revoke (it already pauses for confirmation).`);
      return 0;
    }
    store.setCapabilityStanding(agent.id, capability, "gated", "manually revoked");
    io.out(`Revoked '${capability}' for ${name} — it pauses for your confirmation again.`);
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

// --- objective -------------------------------------------------------------

const OBJECTIVE_USAGE =
  'Usage: asterism objective <add|list|done|drop>  ·  add <agent> "<text>"  ·  list <agent>  ·  done|drop <agent> <id>';

/** Objectives in one agent whose id equals, or uniquely begins with, `ref`. */
function matchObjectives(store: AsterismStore, agent: Agent, ref: string): Objective[] {
  const exact = store.objectives.get(agent.id, ref);
  if (exact) return [exact];
  return store.objectives.list(agent.id).filter((o) => o.id.startsWith(ref));
}

/**
 * Resolve an objective reference — a full id or a unique short-id prefix, the same
 * short id `objective list` prints — to one objective within a SINGLE agent's scope.
 * Resolution runs entirely through `store.objectives` (agent-scoped), so a reference
 * can only ever name one of this agent's own objectives, never reach across agents.
 */
type AgentObjectiveMatch =
  | { kind: "ok"; objective: Objective }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

function matchAgentObjective(store: AsterismStore, agent: Agent, ref: string): AgentObjectiveMatch {
  const objectives = matchObjectives(store, agent, ref);
  if (objectives.length === 0) return { kind: "not_found" };
  if (objectives.length > 1) return { kind: "ambiguous" };
  return { kind: "ok", objective: objectives[0]! };
}

async function cmdObjective(args: string[], io: CliIO): Promise<number> {
  const sub = args[0];
  if (sub === undefined) {
    io.err(OBJECTIVE_USAGE);
    return 1;
  }
  if (sub === "--help" || sub === "-h") {
    io.out(COMMAND_HELP.objective!);
    return 0;
  }
  // Each subcommand takes its remaining args RAW — deliberately NOT through
  // `parseArgs`. `objective add` carries free-form text, which `parseArgs` would eat
  // as flags the moment it begins with a dash (`--draft the proposal`, `- step one`),
  // dropping the very content the help tells the user to pass. There are no flags on
  // any objective verb, so positional handling loses nothing — the same discipline
  // `secrets add` uses to keep verbatim secret material intact.
  const rest = args.slice(1);
  if (sub === "add") return cmdObjectiveAdd(rest, io);
  if (sub === "list") return cmdObjectiveList(rest, io);
  if (sub === "done") return cmdObjectiveStatus(rest, "done", "done", io);
  if (sub === "drop") return cmdObjectiveStatus(rest, "dropped", "drop", io);
  io.err(`Unknown subcommand: objective ${sub}`);
  io.out(COMMAND_HELP.objective!);
  return 1;
}

/** Whether the first sub-arg asks for help (`objective <verb> --help`). */
function objectiveHelp(args: string[], io: CliIO): boolean {
  if (args[0] === "--help" || args[0] === "-h") {
    io.out(COMMAND_HELP.objective!);
    return true;
  }
  return false;
}

/** `asterism objective add <agent> "<text>"` — declare a standing objective. */
function cmdObjectiveAdd(args: string[], io: CliIO): Promise<number> {
  if (objectiveHelp(args, io)) return Promise.resolve(0);
  const name = args[0];
  // Every token after the agent, joined and taken VERBATIM — so multi-word text is
  // kept in full and content that begins with a dash is preserved, not mistaken for
  // an option (positional, exactly like `secrets add`'s value).
  const content = args.slice(1).join(" ").trim();
  if (!name || !content) {
    io.err('Usage: asterism objective add <agent> "<text>"');
    return Promise.resolve(1);
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    // The objective frames runs, so the kernel screens it through the SAME firewall
    // as memory on the write path. A blocked one is reported plainly (and the kernel
    // has already audited the refusal) — never saved.
    try {
      const objective = store.createObjective(agent.id, content);
      io.out(`Declared objective ${shortId(objective.id)} for ${name}.`);
      return 0;
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        io.err(
          `That objective can't be saved — it trips the safety screen (${err.findings
            .map((f) => `${f.category}:${f.rule}`)
            .join(", ")}).`,
        );
        return 1;
      }
      throw err;
    }
  });
}

/** `asterism objective list <agent>` — the agent's objectives (active first, then history). */
function cmdObjectiveList(args: string[], io: CliIO): Promise<number> {
  if (objectiveHelp(args, io)) return Promise.resolve(0);
  const name = args[0];
  if (!name) {
    io.err("Usage: asterism objective list <agent>");
    return Promise.resolve(1);
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    io.out(formatObjectiveList(store.listObjectives(agent.id), agent.name));
    return 0;
  });
}

/**
 * `asterism objective done|drop <agent> <id>` — advance an objective's lifecycle so it
 * stops framing runs. `verb` is the word the user typed (for the usage line); `status`
 * is the lifecycle state it maps to (`done`, or `dropped` for `drop`).
 */
function cmdObjectiveStatus(
  args: string[],
  status: ObjectiveStatus,
  verb: string,
  io: CliIO,
): Promise<number> {
  if (objectiveHelp(args, io)) return Promise.resolve(0);
  const name = args[0];
  const ref = args[1];
  if (!name || !ref || ref.trim() === "") {
    io.err(`Usage: asterism objective ${verb} <agent> <id>`);
    return Promise.resolve(1);
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    const match = matchAgentObjective(store, agent, ref);
    if (match.kind === "not_found") {
      io.err(`No objective matching "${ref}" for ${name}.`);
      return 1;
    }
    if (match.kind === "ambiguous") {
      io.err(`"${ref}" matches more than one of ${name}'s objectives — use a longer id.`);
      return 1;
    }
    if (match.objective.status === status) {
      io.out(`Objective ${shortId(match.objective.id)} is already ${status}.`);
      return 0;
    }
    store.setObjectiveStatus(agent.id, match.objective.id, status);
    io.out(`Marked objective ${shortId(match.objective.id)} ${status} for ${name}.`);
    return 0;
  });
}

// --- notes (world-facts) ---------------------------------------------------
//
// The agent writes its OWN working notes via the kernel-owned `record_note` /
// `forget_note` tools mid-run; these operator verbs are the inspect-and-revert side of
// that (§4: operator-visible and operator-revertible). `notes set` goes through the
// SAME `recordWorldFact` path the agent's tool does — firewall-screened and capped —
// so operator-authored content is screened too (defense-in-depth, as objectives screen
// operator content).

const NOTES_USAGE =
  'Usage: asterism notes <inspect|set|clear>  ·  inspect <agent>  ·  set <agent> "<subject>" "<value>"  ·  clear <agent> "<subject>"';

function cmdNotes(args: string[], io: CliIO): Promise<number> {
  const sub = args[0];
  if (sub === undefined) {
    io.err(NOTES_USAGE);
    return Promise.resolve(1);
  }
  if (sub === "--help" || sub === "-h") {
    io.out(COMMAND_HELP.notes!);
    return Promise.resolve(0);
  }
  // Raw positional args — deliberately NOT through `parseArgs`. A note's `subject` and
  // `value` are free-form and may begin with a dash, which `parseArgs` would eat as
  // flags; there are no flags on any notes verb, so positional handling loses nothing
  // (the same discipline `objective add` and `secrets add` use).
  const rest = args.slice(1);
  if (sub === "inspect") return cmdNotesInspect(rest, io);
  if (sub === "set") return cmdNotesSet(rest, io);
  if (sub === "clear") return cmdNotesClear(rest, io);
  io.err(`Unknown subcommand: notes ${sub}`);
  io.out(COMMAND_HELP.notes!);
  return Promise.resolve(1);
}

/** Whether the first sub-arg asks for help (`notes <verb> --help`). */
function notesHelp(args: string[], io: CliIO): boolean {
  if (args[0] === "--help" || args[0] === "-h") {
    io.out(COMMAND_HELP.notes!);
    return true;
  }
  return false;
}

/** `asterism notes inspect <agent>` — the agent's working notes (its own unverified record). */
function cmdNotesInspect(args: string[], io: CliIO): Promise<number> {
  if (notesHelp(args, io)) return Promise.resolve(0);
  const name = args[0];
  if (!name) {
    io.err("Usage: asterism notes inspect <agent>");
    return Promise.resolve(1);
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    io.out(formatWorldFactList(store.listWorldFacts(agent.id), agent.name, DEFAULT_WORLD_FACT_CAP));
    return 0;
  });
}

/**
 * `asterism notes set <agent> "<subject>" "<value>"` — operator-set or -correct a
 * working note. The subject is the first token after the agent; everything after it is
 * the value, joined VERBATIM so a multi-word value (and one beginning with a dash) is
 * preserved (positional, like `objective add`).
 */
function cmdNotesSet(args: string[], io: CliIO): Promise<number> {
  if (notesHelp(args, io)) return Promise.resolve(0);
  const name = args[0];
  const subject = args[1];
  const value = args.slice(2).join(" ").trim();
  if (!name || !subject || subject.trim() === "" || !value) {
    io.err('Usage: asterism notes set <agent> "<subject>" "<value>"');
    return Promise.resolve(1);
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    // A working note frames runs, so the kernel screens it through the SAME firewall as
    // memory, and caps it. A blocked or over-cap write is reported plainly (and the
    // firewall refusal already audited) — never saved.
    try {
      store.recordWorldFact(agent.id, subject, value);
      io.out(`Set working note "${subject}" for ${name}.`);
      return 0;
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        io.err(
          `That note can't be saved — it trips the safety screen (${err.findings
            .map((f) => `${f.category}:${f.rule}`)
            .join(", ")}).`,
        );
        return 1;
      }
      if (err instanceof WorldFactCapError) {
        io.err(
          `${name}'s working notes are full (${err.cap} max). Clear one with ` +
            `\`asterism notes clear ${name} "<subject>"\` before adding a new subject.`,
        );
        return 1;
      }
      throw err;
    }
  });
}

/** `asterism notes clear <agent> "<subject>"` — remove one working note (operator revert). */
function cmdNotesClear(args: string[], io: CliIO): Promise<number> {
  if (notesHelp(args, io)) return Promise.resolve(0);
  const name = args[0];
  const subject = args.slice(1).join(" ").trim();
  if (!name || !subject) {
    io.err('Usage: asterism notes clear <agent> "<subject>"');
    return Promise.resolve(1);
  }
  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    const removed = store.clearWorldFact(agent.id, subject);
    if (!removed) {
      io.err(`No working note named "${subject}" for ${name}.`);
      return 1;
    }
    io.out(`Cleared working note "${subject}" for ${name}.`);
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
    const made = await resolveAdapter(io, home, agent, store);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }

    // An agent opted into a recall provider has it resolved here; an unset agent uses
    // the kernel's built-in lexical ranker (no `recall` option). Opted-in-but-
    // unconfigured is a hard error — surface it before constructing the run.
    const recallMade = await resolveRecall(io, store, agent);
    if (recallMade.reason) {
      io.err(recallMade.reason);
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
      ...(recallMade.provider ? { recall: recallMade.provider } : {}),
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
    const made = await resolveAdapter(io, home, agent, store);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }

    // Resume re-frames the run, so it honors the agent's recall provider too — same
    // resolution and same hard-fail-on-misconfiguration as the initial run.
    const recallMade = await resolveRecall(io, store, agent);
    if (recallMade.reason) {
      io.err(recallMade.reason);
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
      ...(recallMade.provider ? { recall: recallMade.provider } : {}),
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
  const parsed = parseArgs(args, ["help", "h", "review", "propose"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.reflect!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism reflect <agent> --review   (or --propose to queue unattended)");
    return 1;
  }
  const review = parsed.flags.review === true;
  const propose = parsed.flags.propose === true;
  // The two modes are mutually exclusive and one must be chosen — reflection never
  // runs in a surprising auto mode. `--review` drains the queue for a human; `--propose`
  // is the non-interactive, schedule-from-cron path that fills it (and never accepts).
  if (review && propose) {
    io.err("Choose one: --review (drain the queue) or --propose (queue unattended).");
    return 1;
  }
  if (!review && !propose) {
    io.err(`Reflection runs in review or propose mode. Re-run with: asterism reflect ${name} --review`);
    return 1;
  }

  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);
    return propose
      ? runReflectPropose(io, store, home, agent, name)
      : runReflectReview(io, store, home, agent, name);
  });
}

/**
 * `reflect --review`: drain the agent's persisted PROPOSED queues when either has rows (the
 * proposals a scheduled `--propose` already computed — these need NO model), otherwise fall
 * back to a live compute of the latest run. Both memories AND standing objectives are reviewed
 * — memories first, then objectives — so one `reflect --review` drains everything reflection
 * proposed. Queue-if-present-else-live keeps the manual `run → reflect --review` flow unchanged.
 */
async function runReflectReview(
  io: CliIO,
  store: AsterismStore,
  home: string,
  agent: Agent,
  name: string,
): Promise<number> {
  const queuedMemories = store.memories.list(agent.id, { reviewState: "proposed" });
  const queuedObjectives = store.objectives.list(agent.id, { reviewState: "proposed" });
  // A persisted queue (from `--propose`) is drained, never re-computed: if EITHER queue has
  // rows we are in drain mode, and we drain whichever kinds have rows — no model needed.
  if (queuedMemories.length > 0 || queuedObjectives.length > 0) {
    let code = 0;
    if (queuedMemories.length > 0) {
      code = (await reviewQueueDrain(io, store, agent, name, queuedMemories)) || code;
    }
    if (queuedObjectives.length > 0) {
      code = (await reviewObjectiveQueueDrain(io, store, agent, name, queuedObjectives)) || code;
    }
    return code;
  }
  return reviewLive(io, store, home, agent, name);
}

/** The running tally a review loop returns, formatted into the closing `Done — …` line. */
interface ReviewCounts {
  accepted: number;
  rejected: number;
  blocked: number;
  errored: number;
  /** Proposals another surface settled mid-review — the write didn't happen here (queue only). */
  stale: number;
}

/**
 * The outcome of one persist a review-loop callback attempts: `ok` (the write happened) or
 * `stale` (the proposal was already settled by a concurrent drain — the queue path's CAS lost,
 * so nothing was written). The live path always returns `ok`; a stale result never happens there.
 */
type DrainOutcome = "ok" | "stale";

/** One proposal's display fields, the same for a live-computed and a queued proposal. */
interface ReviewableView {
  /** The kind label shown to the reviewer — a memory type, or `"objective"`. */
  label: string;
  /** The memory type, for a memory proposal; absent for an objective. Passed through to the reviewer hook. */
  memoryType?: string;
  content: string;
  /** The provider's confidence, when known. Absent for a queued objective. */
  confidence?: number;
  findings: readonly FirewallFinding[];
}

/**
 * Drive the accept / edit / reject loop over a batch of proposals — the SHARED presentation
 * for both review paths (live compute and queue drain), so they can never drift on prompting,
 * empty-edit handling, the firewall warning, or the per-proposal outcome accounting.
 * `view(i)` yields proposal `i`'s display fields; `reject(i)` records a rejection (a no-op for
 * the live path, a queue transition for the drain path); `accept(i, content, edited)` persists
 * an acceptance and MAY throw `MemoryFirewallError` — the hard gate — which is caught and
 * counted per-proposal so one bad write never aborts the batch. Both callbacks return a
 * {@link DrainOutcome}: a `stale` result (a queued proposal a concurrent surface settled first)
 * is reported as skipped, NOT counted as saved/rejected, so the summary never over-reports
 * writes that did not happen. With `warnEditRescreen`, an edit that still trips the firewall is
 * flagged before the accept is attempted.
 */
async function driveReviewLoop(
  io: CliIO,
  total: number,
  view: (i: number) => ReviewableView,
  reject: (i: number) => DrainOutcome,
  accept: (i: number, content: string, edited: boolean) => DrainOutcome,
  warnEditRescreen = false,
): Promise<ReviewCounts> {
  // Absent reviewer ⇒ reject everything: nothing is accepted without an explicit yes.
  const review = io.review ?? ((): ReviewDecision => ({ kind: "reject" }));
  const counts: ReviewCounts = { accepted: 0, rejected: 0, blocked: 0, errored: 0, stale: 0 };
  // Record a rejection, accounting a concurrent settle as skipped rather than rejected.
  const recordReject = (i: number, emptyEdit: boolean): void => {
    if (reject(i) === "stale") {
      counts.stale++;
      io.out("  · already reviewed elsewhere — skipped");
    } else {
      counts.rejected++;
      io.out(emptyEdit ? "  ✗ rejected (empty after edit)" : "  ✗ rejected");
    }
  };
  for (let i = 0; i < total; i++) {
    const v = view(i);

    io.out("");
    io.out(
      `(${i + 1}/${total}) ${v.label}` +
        (v.confidence !== undefined ? ` · confidence ${v.confidence}` : ""),
    );
    io.out(`  ${v.content}`);
    if (v.findings.length > 0) {
      io.out(
        `  ⚠ the memory firewall flagged this (${v.findings
          .map((f) => f.rule)
          .join(", ")}) — edit to remove the flagged content, or reject it.`,
      );
    }

    const decision = await review({
      index: i + 1,
      total,
      label: v.label,
      ...(v.memoryType !== undefined ? { memoryType: v.memoryType } : {}),
      content: v.content,
      ...(v.confidence !== undefined ? { confidence: v.confidence } : {}),
      findings: v.findings,
    });

    if (decision.kind === "reject") {
      recordReject(i, false);
      continue;
    }
    // Trim, and treat an empty/whitespace edit as a rejection — never accept a blank memory.
    const edited = decision.kind === "edit";
    const content = (edited ? decision.content : v.content).trim();
    if (content.length === 0) {
      recordReject(i, true);
      continue;
    }
    // Re-screen the EDITED content so the warning matches what is about to be persisted
    // (the original screen was on the proposal as offered).
    if (edited && warnEditRescreen) {
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
      // The firewall re-screens at persistence (the single hard chokepoint) and refuses a
      // poisoned write regardless of approval — caught below and counted, not fatal.
      if (accept(i, content, edited) === "stale") {
        counts.stale++;
        io.out("  · already reviewed elsewhere — skipped");
      } else {
        counts.accepted++;
        io.out(edited ? "  ✓ saved (edited)" : "  ✓ saved");
      }
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        counts.blocked++;
        io.out(
          `  ⛔ blocked by the memory firewall — not saved (${err.findings
            .map((f) => f.rule)
            .join(", ")})`,
        );
      } else {
        counts.errored++;
        io.out(`  ⛔ could not save: ${errorMessage(err)}`);
      }
    }
  }
  return counts;
}

/** Print the closing `Done — N saved, …` line shared by both review paths. */
function printReviewSummary(io: CliIO, c: ReviewCounts): void {
  io.out("");
  io.out(
    `Done — ${c.accepted} saved, ${c.rejected} rejected` +
      `${c.blocked > 0 ? `, ${c.blocked} blocked` : ""}` +
      `${c.errored > 0 ? `, ${c.errored} errored` : ""}` +
      `${c.stale > 0 ? `, ${c.stale} already reviewed elsewhere` : ""}.`,
  );
}

/**
 * Drain the persisted `proposed` queue: present each queued proposal and accept / edit /
 * reject it through the shared kernel helpers ({@link acceptProposedMemory} /
 * {@link rejectProposedMemory}), which the dashboard uses too — so the surfaces can never
 * drift on HOW a drain is applied. No model is needed: the proposals are already computed.
 */
async function reviewQueueDrain(
  io: CliIO,
  store: AsterismStore,
  agent: Agent,
  name: string,
  queued: Memory[],
): Promise<number> {
  // Draining a persisted proposal is a DURABLE decision: a reject transitions the row to
  // `rejected`, not a discard. So in a non-interactive session (no reviewer wired — e.g. a
  // piped or cron-launched `reflect --review`) the safe-default reject would silently wipe
  // the whole pile. Refuse to drain unattended; leave it intact for a real review. (The live
  // path's reject persists nothing, so it stays harmless without a reviewer.)
  if (!io.review) {
    io.out(
      `${queued.length} proposed ${queued.length === 1 ? "memory is" : "memories are"} waiting for ${name}.`,
    );
    io.out(`Run \`asterism reflect ${name} --review\` in an interactive terminal to go through them.`);
    return 0;
  }

  io.out(
    `Reviewing ${queued.length} queued ${queued.length === 1 ? "memory" : "memories"} for ${name}.`,
  );
  io.out("These were proposed unattended; nothing is active unless you accept it.");

  const counts = await driveReviewLoop(
    io,
    queued.length,
    // A queued proposal was firewall-screened at create, so it screens clean now; screen
    // again only so a display warning would still surface if the rules tightened since.
    (i) => {
      const m = queued[i]!;
      return {
        label: m.memoryType,
        memoryType: m.memoryType,
        content: m.content,
        confidence: m.confidence,
        findings: screenMemory(m.content).findings,
      };
    },
    // A `rejected` result is the write we made; anything else means a concurrent surface
    // already settled this proposal (the CAS lost) — report it stale, don't count a reject.
    (i) => (rejectProposedMemory(store, agent, queued[i]!.id).kind === "rejected" ? "ok" : "stale"),
    // Accept in place, or — for an edit — record the re-screened edit and supersede the
    // original (the kernel helper re-screens, the hard gate; a poisoned edit throws here).
    // A non-`accepted` result means it was settled elsewhere first — stale, not saved.
    (i, content, edited) =>
      acceptProposedMemory(store, agent, queued[i]!.id, edited ? content : undefined).kind ===
      "accepted"
        ? "ok"
        : "stale",
    true, // warn on a still-poisoned edit before persisting, same as the live path
  );

  printReviewSummary(io, counts);
  return 0;
}

/**
 * Drain the persisted `proposed` OBJECTIVE queue — the objective analogue of
 * {@link reviewQueueDrain}, through the shared kernel helpers ({@link acceptProposedObjective} /
 * {@link rejectProposedObjective}). No model is needed: the proposals are already computed. As
 * with memory, an unattended (no-reviewer) session refuses to drain — a reject is a DURABLE
 * transition, so a default-reject would wipe the pile — and leaves it intact for a real review.
 */
async function reviewObjectiveQueueDrain(
  io: CliIO,
  store: AsterismStore,
  agent: Agent,
  name: string,
  queued: Objective[],
): Promise<number> {
  if (!io.review) {
    io.out(
      `${queued.length} proposed ${queued.length === 1 ? "objective is" : "objectives are"} waiting for ${name}.`,
    );
    io.out(`Run \`asterism reflect ${name} --review\` in an interactive terminal to go through them.`);
    return 0;
  }

  io.out(
    `Reviewing ${queued.length} queued ${queued.length === 1 ? "objective" : "objectives"} for ${name}.`,
  );
  io.out("These were proposed unattended; nothing frames a run unless you accept it.");

  const counts = await driveReviewLoop(
    io,
    queued.length,
    // Objectives persist no confidence, so the view carries none (the display omits it). Re-screen
    // only so a display warning would surface if the firewall rules tightened since the proposal.
    (i) => {
      const o = queued[i]!;
      return { label: "objective", content: o.content, findings: screenMemory(o.content).findings };
    },
    (i) =>
      rejectProposedObjective(store, agent, queued[i]!.id).kind === "rejected" ? "ok" : "stale",
    (i, content, edited) =>
      acceptProposedObjective(store, agent, queued[i]!.id, edited ? content : undefined).kind ===
      "accepted"
        ? "ok"
        : "stale",
    true, // warn on a still-poisoned edit before persisting, same as the memory path
  );

  printReviewSummary(io, counts);
  return 0;
}

/**
 * The live, ephemeral review path: compute proposals for the agent's latest run with output,
 * present each, and persist only the accepted ones. Used when both persisted queues are empty,
 * so the manual `run → reflect --review` convenience is unchanged. Reviews memories then
 * objectives, building the model + selecting the run ONCE for both.
 */
async function reviewLive(
  io: CliIO,
  store: AsterismStore,
  home: string,
  agent: Agent,
  name: string,
): Promise<number> {
  // Check for a reflectable run BEFORE building the model, so an agent with nothing to reflect
  // on is told so without needing a model configured. Both sections re-select the same run (the
  // shared kernel helpers own that policy); this early check only gates the model build.
  const target = store.runs.latestWithOutput(agent.id);
  if (!target || target.output === undefined) {
    io.out(`${name} has no completed run with output to reflect on yet.`);
    return 0;
  }

  // Build the reflection provider (a hosted model) once — both the memory and objective sections
  // use it. Resolves this agent's own model, the same way `run` builds its adapter.
  const context: ModelResolutionContext = { config: loadConfig(home), agentName: agent.name };
  const made = io.makeReflectionProvider
    ? io.makeReflectionProvider(io.env, context)
    : (await import("./reflect-model.js")).buildReflectionProvider(io.env, context);
  if (!made.provider) {
    io.err(made.reason ?? "No model configured for reflection.");
    return 1;
  }
  const provider = made.provider;

  const memCode = await reviewMemoryLive(io, store, agent, name, target, provider);
  const objCode = await reviewObjectiveLive(io, store, agent, name, target, provider);
  // Either section failing (a model error) surfaces as a non-zero exit; both clean ⇒ 0.
  return memCode || objCode;
}

/** The live memory section of {@link reviewLive}: propose memories for `target`, review, persist accepts. */
async function reviewMemoryLive(
  io: CliIO,
  store: AsterismStore,
  agent: Agent,
  name: string,
  target: Run,
  provider: ReflectionProvider,
): Promise<number> {
  let usable: readonly ReviewableProposal[];
  let ignored: number;
  try {
    const result = await proposeReviewableMemories(store, agent, provider, { runId: target.id });
    if (result.kind === "no_run") {
      io.out(`${name} has no completed run with output to reflect on yet.`);
      return 0;
    }
    usable = result.proposals;
    ignored = result.ignored;
  } catch (err) {
    io.err(`Reflection failed: ${errorMessage(err)}`);
    return 1;
  }
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

  const counts = await driveReviewLoop(
    io,
    usable.length,
    (i) => {
      const p = usable[i]!;
      return {
        label: p.memoryType,
        memoryType: p.memoryType,
        content: p.content,
        confidence: p.confidence,
        findings: p.findings,
      };
    },
    // A live proposal persists nothing until accepted, so a rejection is a no-op — always `ok`.
    (): DrainOutcome => "ok",
    // Accepted memories are saved active + accepted, so they frame the agent's future runs.
    // A live compute is never concurrently settled, so the write always happens (`ok`).
    (i, content): DrainOutcome => {
      const p = usable[i]!;
      store.recordMemory(agent.id, {
        memoryType: p.memoryType,
        content,
        confidence: p.confidence,
        sourceRunId: p.sourceRunId,
        reviewState: "accepted",
        status: "active",
      });
      return "ok";
    },
    true, // warn on a still-poisoned edit before persisting
  );

  printReviewSummary(io, counts);
  return 0;
}

/** The live objective section of {@link reviewLive}: propose objectives for `target`, review, persist accepts. */
async function reviewObjectiveLive(
  io: CliIO,
  store: AsterismStore,
  agent: Agent,
  name: string,
  target: Run,
  provider: ReflectionProvider,
): Promise<number> {
  let usable: readonly ReviewableObjectiveProposal[];
  try {
    const result = await proposeReviewableObjectives(store, agent, provider, { runId: target.id });
    if (result.kind === "no_run") return 0;
    usable = result.proposals;
  } catch (err) {
    io.err(`Objective reflection failed: ${errorMessage(err)}`);
    return 1;
  }
  if (usable.length === 0) {
    io.out(`${name}: nothing worth proposing as a standing objective from run ${shortId(target.id)}.`);
    return 0;
  }

  io.out(
    `Reviewing ${usable.length} proposed ${usable.length === 1 ? "objective" : "objectives"} for ${name} (from run ${shortId(target.id)}).`,
  );
  io.out("Nothing frames a run unless you accept it.");

  const counts = await driveReviewLoop(
    io,
    usable.length,
    (i) => {
      const p = usable[i]!;
      return { label: "objective", content: p.content, confidence: p.confidence, findings: p.findings };
    },
    // A live proposal persists nothing until accepted, so a rejection is a no-op — always `ok`.
    (): DrainOutcome => "ok",
    // An accepted objective is saved active + accepted, so it frames the agent's future runs.
    (i, content): DrainOutcome => {
      store.createObjective(agent.id, content, "accepted");
      return "ok";
    },
    true, // warn on a still-poisoned edit before persisting
  );

  printReviewSummary(io, counts);
  return 0;
}

/**
 * `reflect --propose`: the non-interactive proposer an operator wires to cron / launchd /
 * a systemd timer. It reflects on the agent's un-reflected runs and PERSISTS each proposal
 * to the `proposed` queue — it NEVER accepts. A human drains the queue later with
 * `reflect --review`. Prints a one-line summary and exits; safe to re-run (idempotent).
 */
async function runReflectPropose(
  io: CliIO,
  store: AsterismStore,
  home: string,
  agent: Agent,
  name: string,
): Promise<number> {
  // Check for un-reflected work BEFORE building the model, so an agent with nothing new to
  // reflect on exits cleanly without needing a model configured.
  const pendingWork = unreflectedRuns(store, agent);
  if (pendingWork.runs.length === 0) {
    io.out(`${name}: no new runs to reflect on.`);
    return 0;
  }

  const context: ModelResolutionContext = { config: loadConfig(home), agentName: agent.name };
  const made = io.makeReflectionProvider
    ? io.makeReflectionProvider(io.env, context)
    : (await import("./reflect-model.js")).buildReflectionProvider(io.env, context);
  if (!made.provider) {
    io.err(made.reason ?? "No model configured for reflection.");
    return 1;
  }

  let result;
  try {
    result = await queueProposals(store, agent, made.provider);
  } catch (err) {
    io.err(`Reflection failed: ${errorMessage(err)}`);
    return 1;
  }

  const runWord = result.processedRuns.length === 1 ? "run" : "runs";
  const memWord = result.queued === 1 ? "memory" : "memories";
  io.out(
    `Queued ${result.queued} proposed ${memWord} for ${name} from ${result.processedRuns.length} ${runWord}` +
      `${result.withheld > 0 ? `, ${result.withheld} withheld` : ""}` +
      `${result.alreadyKnown > 0 ? `, ${result.alreadyKnown} already known` : ""}` +
      `${result.ignored > 0 ? `, ${result.ignored} ignored` : ""}.`,
  );
  const obj = result.objectives;
  const objWord = obj.queued === 1 ? "objective" : "objectives";
  io.out(
    `Queued ${obj.queued} proposed ${objWord}` +
      `${obj.withheld > 0 ? `, ${obj.withheld} withheld` : ""}` +
      `${obj.alreadyKnown > 0 ? `, ${obj.alreadyKnown} already known` : ""}` +
      `${obj.ignored > 0 ? `, ${obj.ignored} ignored` : ""}.`,
  );
  if (result.pendingRuns > 0) {
    io.out(`${result.pendingRuns} more run(s) still pending — re-run to continue.`);
  }
  if (result.queued > 0 || obj.queued > 0) {
    io.out(`Review them with: asterism reflect ${name} --review`);
  }
  return 0;
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

/**
 * `asterism trace <agent>` — render the agent's recorded cognition trace as a Lodestar
 * trust report. Only meaningful for an agent opted into a cognition provider (`config
 * cognition-provider <agent> lodestar`); an agent with no trace gets a friendly pointer
 * rather than an empty report. Reads only the agent's OWN trace, under its confined
 * workspace, scoped by its id — it cannot surface another agent's trace. The renderer is
 * imported lazily, so a `trace` on an agent that never opted in still does not pull
 * Lodestar into the default path until this command actually runs.
 */
async function cmdTrace(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.trace!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism trace <agent>");
    return 1;
  }
  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    const renderTrace =
      io.renderCognitionTrace ??
      (await import("@qmilab/asterism-adapter-lodestar")).renderTrace;
    // Read from the host trace root (the install home's `traces/`), the SAME place the
    // wrapper wrote to — never the agent workspace. A read failure (corrupt log, schema
    // mismatch, unreadable file) is surfaced as an error, NOT silently reported as "no
    // trace", which would hide the corruption.
    let report: string | undefined;
    try {
      report = await renderTrace(tracesDir(home), agent.id);
    } catch (err) {
      io.err(`Could not read ${name}'s trace (the log may be corrupt): ${errorMessage(err)}`);
      return 1;
    }
    if (report === undefined) {
      const optedIn = store.agentSettings.getCognitionProvider(agent.id) !== undefined;
      io.out(
        optedIn
          ? `${name} has recorded no trace yet — run it once and check back.`
          : `${name} records no trace. Opt in with:  asterism config cognition-provider ${name} lodestar`,
      );
      return 0;
    }
    io.out(report);
    return 0;
  });
}

async function cmdConfig(args: string[], io: CliIO): Promise<number> {
  // `--unset` and `--default` are booleans here so `config recall-budget <agent> --unset`
  // and `config recall-budget --default <n>` never consume a following token as a value
  // (the budget `<n>` must stay a positional).
  const parsed = parseArgs(args, ["help", "h", "unset", "default"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.config!);
    return 0;
  }
  const sub = parsed.positionals[0];
  if (sub === undefined || sub === "show") return cmdConfigShow(io);
  if (sub === "set") return cmdConfigSet(parsed, io);
  if (sub === "unset") return cmdConfigUnset(parsed, io);
  if (sub === "recall-budget") return cmdConfigRecallBudget(parsed, io);
  if (sub === "recall-provider") return cmdConfigRecallProvider(parsed, io);
  if (sub === "cognition-provider") return cmdConfigCognitionProvider(parsed, io);
  if (sub === "cognition-capture") return cmdConfigCognitionCapture(parsed, io);
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
    // The install-wide default sits between the built-in constant and a per-agent override;
    // surface it so the per-agent lines below can name where an un-set agent's value comes from.
    const installBudget = store.installSettings.getRecallBudget();
    const constant = DEFAULT_RECALL_BUDGET.maxMemories;
    io.out(
      installBudget !== undefined
        ? `Install-wide recall budget: ${installBudget}  (built-in fallback: ${constant})`
        : `Install-wide recall budget: (none — built-in default ${constant})`,
    );
    io.out("Per-agent recall budget:");
    if (agents.length === 0) {
      io.out("  (no agents yet)");
    } else {
      // How many memories each agent's runs may frame. An unset agent resolves to the
      // install-wide default if one is set, else the kernel constant; the kernel owns that
      // resolution (`resolveRecallBudget`), so this only reads the stored values and labels
      // the source.
      for (const agent of agents) {
        const budget = store.agentSettings.getRecallBudget(agent.id);
        if (budget !== undefined) {
          io.out(`  ${agent.name}  →  ${budget}  [set]`);
        } else if (installBudget !== undefined) {
          io.out(`  ${agent.name}  →  ${installBudget}  [install-wide default]`);
        } else {
          io.out(`  ${agent.name}  →  ${constant}  [default]`);
        }
      }
    }

    io.out("");
    io.out("Per-agent recall provider:");
    if (agents.length === 0) {
      io.out("  (no agents yet)");
    } else {
      // Which ranker selects an agent's framing memories. Unset ⇒ the built-in keyword
      // ranker; an opted-in agent names its provider (e.g. local embeddings).
      for (const agent of agents) {
        const provider = store.agentSettings.getRecallProvider(agent.id);
        io.out(
          provider !== undefined
            ? `  ${agent.name}  →  ${provider}  [set]`
            : `  ${agent.name}  →  ${DEFAULT_RECALL_PROVIDER_LABEL}  [default]`,
        );
      }
      const embedSet = ["ASTERISM_RECALL_EMBED_URL", "ASTERISM_RECALL_EMBED_MODEL"].filter(
        (k) => io.env[k] !== undefined,
      );
      if (embedSet.length > 0) {
        io.out(`  (local-embeddings endpoint configured: ${embedSet.join(", ")})`);
      }
    }

    io.out("");
    io.out("Per-agent cognition provider:");
    if (agents.length === 0) {
      io.out("  (no agents yet)");
    } else {
      // Whether an agent's runs record an auditable trace. Unset ⇒ the default Pi loop
      // with no trace; an opted-in agent names its provider (e.g. lodestar).
      for (const agent of agents) {
        const provider = store.agentSettings.getCognitionProvider(agent.id);
        io.out(
          provider !== undefined
            ? `  ${agent.name}  →  ${provider}  [set]`
            : `  ${agent.name}  →  ${DEFAULT_COGNITION_PROVIDER_LABEL}  [default]`,
        );
      }
    }

    io.out("");
    io.out("API keys are never stored here — set them in the environment (e.g. OPENAI_API_KEY).");
    return 0;
  });
}

/**
 * `asterism config recall-budget <agent> [<n>]` / `--unset` — read or set how many
 * memories an agent's runs may frame. With a value, sets the per-agent override;
 * with `--unset`, clears it back to the kernel default; with neither, shows the
 * current setting. The kernel validates and stores it (agentId-scoped) and owns the
 * effective-value resolution — this surface only parses, calls, and formats.
 */
function cmdConfigRecallBudget(parsed: ParsedArgs, io: CliIO): Promise<number> {
  // `--default` operates on the INSTALL-WIDE default (no agent), which sits between the
  // kernel constant and a per-agent override; otherwise it's a per-agent setting. Route on
  // the flag being DEFINED, not `=== true`: the parser records `--default 30` as `true` (it
  // is registered boolean) but the inline `--default=30` as the string `"30"`, and BOTH mean
  // install-wide mode.
  if (parsed.flags.default !== undefined) return cmdConfigInstallRecallBudget(parsed, io);

  const agentName = parsed.positionals[1];
  if (!agentName) {
    io.err("Usage: asterism config recall-budget <agent> <n>  ·  --unset  ·  --default <n>");
    return Promise.resolve(1);
  }
  const unset = parsed.flags.unset === true;
  const valueRaw = parsed.positionals[2];
  // The tiny arg parser turns a bare negative number (`-5`) into a short boolean flag
  // (key `5`), not a positional, so a digit-only flag key is a negative budget the user
  // tried to set. Catch it as an invalid value rather than letting it vanish and fall
  // through to the read-only "show" path as a silent no-op.
  const negativeValue = Object.keys(parsed.flags).some((k) => /^\d+$/.test(k));
  const CONSTANT = DEFAULT_RECALL_BUDGET.maxMemories;

  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, agentName);
    if (!agent) return noAgent(io, agentName);

    // The effective default an un-set agent falls back to: the install-wide default if one
    // is configured, else the kernel constant — so the messages name the value the agent
    // ACTUALLY uses, not always the built-in 20.
    const installDefault = store.installSettings.getRecallBudget();
    const effective = installDefault ?? CONSTANT;
    const effectiveLabel = installDefault !== undefined ? "install-wide default" : "default";

    if (unset) {
      // Decide the message from the PRIOR value, not row existence: a cleared row
      // persists (with a NULL budget) to keep its created_at, so "is there a row" is
      // not "was something set". Skip the write entirely when nothing was set.
      const had = store.agentSettings.getRecallBudget(agent.id);
      if (had === undefined) {
        io.out(`${agentName} had no recall budget set — it already uses the ${effectiveLabel} (${effective}).`);
        return 0;
      }
      store.clearRecallBudget(agent.id);
      io.out(`Cleared ${agentName}'s recall budget — it uses the ${effectiveLabel} (${effective}) again.`);
      return 0;
    }

    // No value and no `--unset`: read the current setting rather than change it.
    if (valueRaw === undefined && !negativeValue) {
      const current = store.agentSettings.getRecallBudget(agent.id);
      io.out(
        current !== undefined
          ? `${agentName}'s recall budget: ${current} ${current === 1 ? "memory" : "memories"}.`
          : `${agentName} uses the ${effectiveLabel} recall budget (${effective} memories).`,
      );
      return 0;
    }

    // A budget must be a positive whole number. `intFlag` parses a non-negative
    // integer; reject 0, a negative (the `negativeValue` case above), and anything
    // non-numeric here with a clear message rather than letting the kernel's
    // write-boundary validation surface as a raw error.
    const budget = valueRaw !== undefined ? intFlag(valueRaw) : undefined;
    if (budget === undefined || budget <= 0) {
      io.err("The recall budget must be a positive whole number.");
      return 1;
    }
    store.setRecallBudget(agent.id, budget);
    io.out(`Set ${agentName}'s recall budget to ${budget} ${budget === 1 ? "memory" : "memories"}.`);
    return 0;
  });
}

/**
 * `asterism config recall-budget --default <n>` / `--default --unset` / `--default` —
 * set, clear, or read the INSTALL-WIDE default recall budget. It applies to every agent
 * without its own per-agent override, and itself sits above the kernel's built-in constant
 * — so the precedence an operator sees is: per-agent setting > this install-wide default >
 * built-in. The kernel resolves all three in one place (`resolveRecallBudget`), so this verb
 * only stores the value; every run surface picks it up without further wiring.
 */
function cmdConfigInstallRecallBudget(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const unset = parsed.flags.unset === true;
  // The budget can arrive two ways: `--default 30` (registered boolean ⇒ `30` is the next
  // positional after `recall-budget`) or `--default=30` (the parser's inline form ⇒ the value
  // is the flag's own string). A bare negative (`--default -5`) still arrives as a digit-only
  // flag key, caught by `negativeValue` below.
  const valueRaw =
    typeof parsed.flags.default === "string" ? parsed.flags.default : parsed.positionals[1];
  const negativeValue = Object.keys(parsed.flags).some((k) => /^\d+$/.test(k));
  const CONSTANT = DEFAULT_RECALL_BUDGET.maxMemories;

  return withHomeStore(io, (store) => {
    if (unset) {
      const had = store.installSettings.getRecallBudget();
      if (had === undefined) {
        io.out(`No install-wide recall budget was set — agents already use the built-in default (${CONSTANT}).`);
        return 0;
      }
      store.installSettings.clearRecallBudget();
      io.out(`Cleared the install-wide recall budget — agents without their own setting use the built-in default (${CONSTANT}) again.`);
      return 0;
    }

    if (valueRaw === undefined && !negativeValue) {
      const current = store.installSettings.getRecallBudget();
      io.out(
        current !== undefined
          ? `Install-wide recall budget: ${current} ${current === 1 ? "memory" : "memories"} (for any agent without its own).`
          : `No install-wide recall budget set — agents use the built-in default (${CONSTANT} memories).`,
      );
      return 0;
    }

    const budget = valueRaw !== undefined ? intFlag(valueRaw) : undefined;
    if (budget === undefined || budget <= 0) {
      io.err("The recall budget must be a positive whole number.");
      return 1;
    }
    store.installSettings.setRecallBudget(budget);
    io.out(`Set the install-wide recall budget to ${budget} ${budget === 1 ? "memory" : "memories"} — every agent without its own override now uses it.`);
    return 0;
  });
}

/** How the default (unset) recall ranker is described in CLI output. */
const DEFAULT_RECALL_PROVIDER_LABEL = "keyword (built-in)";

/**
 * `asterism config recall-provider <agent> [local]` / `--unset` — opt an agent into a
 * recall provider, or read the current one. `local` selects local-embeddings recall
 * (ranks memory by meaning against a local endpoint — see ASTERISM_RECALL_EMBED_*);
 * `--unset` returns to the built-in keyword ranker; neither shows the current setting.
 * The kernel validates the id (agentId-scoped) and stores it; this surface only parses,
 * calls, and formats. It does not build the provider — that happens at run time, only
 * for an opted-in agent.
 */
function cmdConfigRecallProvider(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const agentName = parsed.positionals[1];
  if (!agentName) {
    io.err(`Usage: asterism config recall-provider <agent> ${RECALL_PROVIDER_IDS.join("|")}  ·  --unset`);
    return Promise.resolve(1);
  }
  const unset = parsed.flags.unset === true;
  const valueRaw = parsed.positionals[2];

  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, agentName);
    if (!agent) return noAgent(io, agentName);

    if (unset) {
      // Decide the message from the PRIOR value, not row existence (a cleared row
      // persists with a NULL selection to keep created_at) — mirrors recall-budget.
      const had = store.agentSettings.getRecallProvider(agent.id);
      if (had === undefined) {
        io.out(
          `${agentName} was already using ${DEFAULT_RECALL_PROVIDER_LABEL} recall — nothing to unset.`,
        );
        return 0;
      }
      store.clearRecallProvider(agent.id);
      io.out(`Cleared ${agentName}'s recall provider — it uses ${DEFAULT_RECALL_PROVIDER_LABEL} recall again.`);
      return 0;
    }

    // No value and no `--unset`: read the current setting rather than change it.
    if (valueRaw === undefined) {
      const current = store.agentSettings.getRecallProvider(agent.id);
      io.out(
        current !== undefined
          ? `${agentName}'s recall provider: ${current}.`
          : `${agentName} uses ${DEFAULT_RECALL_PROVIDER_LABEL} recall (the default).`,
      );
      return 0;
    }

    // Validate the id here so a typo gets a clear CLI message naming the choices,
    // rather than surfacing the kernel's write-boundary error.
    if (!(RECALL_PROVIDER_IDS as readonly string[]).includes(valueRaw)) {
      io.err(
        `Unknown recall provider "${valueRaw}". Choose one of: ${RECALL_PROVIDER_IDS.join(", ")} ` +
          "(or --unset for the built-in keyword ranker).",
      );
      return 1;
    }
    store.setRecallProvider(agent.id, valueRaw as RecallProviderId);
    const hint =
      valueRaw === "local"
        ? " Configure the endpoint with ASTERISM_RECALL_EMBED_URL and ASTERISM_RECALL_EMBED_MODEL."
        : "";
    io.out(`Set ${agentName}'s recall provider to ${valueRaw}.${hint}`);
    return 0;
  });
}

/** How the default (unset) cognition provider is described in CLI output. */
const DEFAULT_COGNITION_PROVIDER_LABEL = "none (no trace)";

/**
 * `asterism config cognition-provider <agent> [lodestar]` / `--unset` — opt an agent
 * into a cognition provider that records an auditable trace of its runs, or read the
 * current one. `lodestar` wraps the agent's runs in the Lodestar cognition layer (see
 * `asterism trace`); `--unset` returns to the default (no trace); neither shows the
 * current setting. Observe-only: the trace records what a run did, it never gates — the
 * kernel stays the sole trust authority. The kernel validates the id (agentId-scoped)
 * and stores it; this surface only parses, calls, and formats. It does not build the
 * wrapper — that happens at run time, only for an opted-in agent.
 */
function cmdConfigCognitionProvider(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const agentName = parsed.positionals[1];
  if (!agentName) {
    io.err(
      `Usage: asterism config cognition-provider <agent> ${COGNITION_PROVIDER_IDS.join("|")}  ·  --unset`,
    );
    return Promise.resolve(1);
  }
  const unset = parsed.flags.unset === true;
  const valueRaw = parsed.positionals[2];

  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, agentName);
    if (!agent) return noAgent(io, agentName);

    if (unset) {
      // Decide the message from the PRIOR value, not row existence (a cleared row
      // persists with a NULL selection to keep created_at) — mirrors recall-provider.
      const had = store.agentSettings.getCognitionProvider(agent.id);
      if (had === undefined) {
        io.out(`${agentName} was already recording no trace — nothing to unset.`);
        return 0;
      }
      store.clearCognitionProvider(agent.id);
      io.out(`Cleared ${agentName}'s cognition provider — its runs record no trace again.`);
      return 0;
    }

    // No value and no `--unset`: read the current setting rather than change it.
    if (valueRaw === undefined) {
      const current = store.agentSettings.getCognitionProvider(agent.id);
      io.out(
        current !== undefined
          ? `${agentName}'s cognition provider: ${current}.`
          : `${agentName} records ${DEFAULT_COGNITION_PROVIDER_LABEL} (the default).`,
      );
      return 0;
    }

    // Validate the id here so a typo gets a clear CLI message naming the choices,
    // rather than surfacing the kernel's write-boundary error.
    if (!(COGNITION_PROVIDER_IDS as readonly string[]).includes(valueRaw)) {
      io.err(
        `Unknown cognition provider "${valueRaw}". Choose one of: ${COGNITION_PROVIDER_IDS.join(", ")} ` +
          "(or --unset for no trace).",
      );
      return 1;
    }
    store.setCognitionProvider(agent.id, valueRaw as CognitionProviderId);
    const hint =
      valueRaw === "lodestar"
        ? ` Its runs now record an auditable trace — read it with \`asterism trace ${agentName}\`.`
        : "";
    io.out(`Set ${agentName}'s cognition provider to ${valueRaw}.${hint}`);
    return 0;
  });
}

/**
 * `asterism config cognition-capture <agent> [content|references]` / `--unset` — escalate
 * HOW MUCH an agent's cognition trace records, or read the current setting. `content` ALSO
 * records each tool output's redacted content (behind the kernel's redaction boundary —
 * secret-aware, bounded, firewall-screened); `references` (the default) records references
 * only — tool name, size, a keyed fingerprint, the error flag — never content. `references`
 * and `--unset` both return to that baseline. Capture is a SEPARATE opt-in from the trace
 * itself (`config cognition-provider`): it is inert until a cognition provider is set, since
 * there is no trace to enrich otherwise. The kernel validates and stores the selection
 * (agentId-scoped); this surface only parses, calls, and formats.
 */
function cmdConfigCognitionCapture(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const agentName = parsed.positionals[1];
  if (!agentName) {
    io.err("Usage: asterism config cognition-capture <agent> content|references  ·  --unset");
    return Promise.resolve(1);
  }
  const unset = parsed.flags.unset === true;
  const valueRaw = parsed.positionals[2];

  return withHomeStore(io, (store) => {
    const agent = findAgentByName(store, agentName);
    if (!agent) return noAgent(io, agentName);

    // `references` is the operator-facing name for the baseline, which the kernel stores as
    // "unset" (NULL) — so both `--unset` and an explicit `references` clear the column.
    if (unset || valueRaw === "references") {
      const had = store.agentSettings.getCognitionCapture(agent.id);
      if (had === undefined) {
        io.out(`${agentName} already captures references only — nothing to change.`);
        return 0;
      }
      store.clearCognitionCapture(agent.id);
      io.out(`${agentName}'s trace captures references only again (no content).`);
      return 0;
    }

    // No value and no `--unset`: read the current setting rather than change it.
    if (valueRaw === undefined) {
      const current = store.agentSettings.getCognitionCapture(agent.id);
      io.out(
        current !== undefined
          ? `${agentName}'s cognition capture: ${current} (redacted output content is recorded).`
          : `${agentName} captures references only (the default — no content).`,
      );
      return 0;
    }

    if (!(COGNITION_CAPTURE_MODES as readonly string[]).includes(valueRaw)) {
      io.err(
        `Unknown cognition capture mode "${valueRaw}". Choose: content, references ` +
          "(or --unset for references only).",
      );
      return 1;
    }
    store.setCognitionCapture(agent.id, valueRaw as CognitionCaptureMode);
    // Honest UX: content capture does nothing until a cognition provider is also set, since
    // there is no trace for it to enrich. Point the operator at the missing half.
    const note =
      store.agentSettings.getCognitionProvider(agent.id) === undefined
        ? ` Note: this is inert until you opt in to a trace — \`asterism config cognition-provider ${agentName} lodestar\`.`
        : "";
    io.out(
      `Set ${agentName}'s cognition capture to content — its trace now records redacted output content.${note}`,
    );
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
    const made = await resolveAdapter(io, home, agent, store);

    // Resolve the agent's opt-in recall provider once, the same way `run` does — so a
    // run over HTTP frames memory identically. An unset agent uses the built-in
    // lexical ranker (no provider); opted-in-but-unconfigured carries a reason the
    // server surfaces as a 503, like a missing model.
    const recallMade = await resolveRecall(io, store, agent);

    // Built once for the served agent, the same way `run` builds it — so a run
    // started over HTTP sees the identical tool catalog, confined to this agent's
    // workspace, that the command line would give it.
    const capabilities = io.capabilities?.(agent.workspaceDir);

    // The front door is default-deny: resolve the bearer token every request must
    // carry. Sourced from ASTERISM_HTTP_TOKEN if set (the injected secret for an
    // unattended/exposed run), else a per-agent token saved under the home — minted
    // and printed once on first serve, reused silently after. The kernel never sees
    // it; the surface only verifies it.
    const httpToken = resolveHttpToken(home, agent.name, io.env);

    // The kernel store stays open for the server's lifetime — `withHomeStore`
    // closes it only after this callback returns, which it does once shutdown is
    // requested below. The HTTP surface is bound to THIS agent alone.
    const server = await startServer({
      store,
      agent,
      authToken: httpToken.token,
      ...(made.adapter ? { adapter: made.adapter } : {}),
      ...(made.reason !== undefined ? { adapterReason: made.reason } : {}),
      ...(recallMade.provider ? { recall: recallMade.provider } : {}),
      ...(recallMade.reason !== undefined ? { recallReason: recallMade.reason } : {}),
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
    reportHttpToken(io, httpToken);
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

/**
 * Tell the operator how to authenticate to the endpoint they just started — every
 * request needs `Authorization: Bearer <token>`. The token VALUE is printed at most
 * once, the moment it is generated; a token that already exists (env or a saved file)
 * is referred to, never re-echoed, so it does not pile up in scrollback or logs.
 */
function reportHttpToken(io: CliIO, tok: ResolvedHttpToken): void {
  if (tok.source === "generated") {
    io.out("  Access token (generated, save it — shown only once):");
    io.out(`    ${tok.token}`);
    io.out("    Send it on every request:  Authorization: Bearer <token>");
    io.out(`    Stored owner-only at ${tok.path}; set ${HTTP_TOKEN_ENV} to override.`);
    return;
  }
  if (tok.source === "file") {
    io.out("  Requests need the saved access token:  Authorization: Bearer <token>");
    io.out(`    Read it from ${tok.path}, or set ${HTTP_TOKEN_ENV} to override.`);
    return;
  }
  io.out(`  Requests need the ${HTTP_TOKEN_ENV} token:  Authorization: Bearer <token>`);
}

// --- dashboard (the operator's terminal console) ---------------------------

const NO_TERMINAL =
  "The dashboard needs an interactive terminal. Run it in a TTY, or use --headless to " +
  "host the console for a dashboard on another machine.";

/**
 * `asterism dashboard` — the operator's live TUI over ALL their agents. Three shapes,
 * one command:
 *   - default: open the local install, self-host the install-wide console in-process
 *     on an ephemeral loopback port, and run the TUI as a thin client of it.
 *   - `dashboard <url> [--token]`: attach the TUI to a remote console (no local store).
 *   - `dashboard --headless [--host --port]`: run the console server only (no TUI) —
 *     the endpoint a remote `dashboard <url>` connects to.
 * The TUI holds no behavior of its own: every action is one call to the console, the
 * same kernel-backed surface the CLI uses, so it inherits the exact guarantees.
 */
async function cmdDashboard(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h", "headless"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.dashboard!);
    return 0;
  }
  for (const flag of ["token", "port", "host"] as const) {
    if (parsed.flags[flag] === true) {
      io.err(`The --${flag} option needs a value.`);
      return 1;
    }
  }
  const headless = parsed.flags.headless === true;
  const urlArg = parsed.positionals[0];
  const tokenFlag = stringFlag(parsed.flags.token);
  const host = stringFlag(parsed.flags.host);
  let port: number | undefined;
  if (typeof parsed.flags.port === "string") {
    port = intFlag(parsed.flags.port);
    if (port === undefined || port > 65535) {
      io.err("The --port option must be a whole number between 0 and 65535.");
      return 1;
    }
  }

  // Remote client mode: a URL was given ⇒ pure client, no local store or server.
  if (urlArg !== undefined) {
    if (headless) {
      io.err("Pass a URL to attach to a console, or use --headless to host one — not both.");
      return 1;
    }
    if (!io.terminal) {
      io.err(NO_TERMINAL);
      return 1;
    }
    let baseUrl: string;
    try {
      baseUrl = new URL(urlArg).toString();
    } catch {
      io.err(`Not a valid console URL: ${urlArg}`);
      return 1;
    }
    const token = tokenFlag ?? io.env[HTTP_TOKEN_ENV]?.trim();
    if (!token) {
      io.err(`A remote console needs an access token. Pass --token <token>, or set ${HTTP_TOKEN_ENV}.`);
      return 1;
    }
    await runDashboard(new DashboardClient(baseUrl, token), io.terminal, { connection: urlArg });
    return 0;
  }

  // Local: self-host the console (and, unless --headless, run the TUI over it).
  if (!headless && !io.terminal) {
    io.err(NO_TERMINAL);
    return 1;
  }
  if (!io.startConsole) {
    io.err("The dashboard console is not available in this embedding.");
    return 1;
  }
  if (!headless && (port !== undefined || host !== undefined)) {
    io.err("--port and --host apply to --headless only; the local dashboard binds an ephemeral loopback port.");
    return 1;
  }
  const startConsole = io.startConsole;

  return withHomeStore(io, async (store, home) => {
    // Per-agent substrate factories, resolving each agent's own model the same way
    // `run`/`reflect` do — pre-imported so the console's factories stay synchronous.
    const config = loadConfig(home);
    const buildAdapterFn = io.makeAdapter ?? (await import("./model.js")).buildAdapter;
    const buildReflectionFn =
      io.makeReflectionProvider ?? (await import("./reflect-model.js")).buildReflectionProvider;

    // The console's front door is default-deny like `serve`'s, but install-wide: one
    // token for the operator's whole console (ASTERISM_HTTP_TOKEN, else a saved file,
    // else minted once). The kernel never sees it; the surface only verifies it.
    const consoleToken = resolveConsoleToken(home, io.env);

    const server = await startConsole({
      store,
      authToken: consoleToken.token,
      readFile: (p) => readFileSync(p, "utf8"),
      ...(io.capabilities ? { capabilities: io.capabilities } : {}),
      // Wrap each opted-in agent's adapter in its cognition provider — the SAME
      // `wrapCognition` the CLI's run/serve/channel paths use — so a run resumed from
      // the dashboard is traced exactly like one started from the CLI (no surface drifts
      // on whether a run is recorded). An agent that has not opted in is unaffected and
      // loads no Lodestar.
      makeAdapter: async (agentName) => {
        const made = buildAdapterFn(io.env, { config, agentName });
        const a = findAgentByName(store, agentName);
        if (!made.adapter || !a) return made;
        return { ...made, adapter: await wrapCognition(io, store, a, made.adapter, tracesDir(home)) };
      },
      makeReflectionProvider: (agentName) => buildReflectionFn(io.env, { config, agentName }),
      // Resolve each agent's opt-in recall provider through the SAME `resolveRecall`
      // the CLI's run/serve/channel paths use, so the dashboard cannot drift on what
      // "opted in" means or how a misconfiguration is reported. Returns `{}` for an
      // agent on the built-in lexical ranker.
      makeRecall: async (agentName) => {
        const a = findAgentByName(store, agentName);
        return a ? resolveRecall(io, store, a) : {};
      },
      // Headless binds a stable port (default) so a remote dashboard can find it; the
      // self-hosted TUI binds an ephemeral loopback port it reads straight back.
      ...(headless
        ? { ...(port !== undefined ? { port } : {}), ...(host !== undefined ? { hostname: host } : {}) }
        : { port: 0 }),
    });

    if (headless) {
      io.out(`Console for all agents at ${server.url}`);
      io.out(`  GET  ${server.url}/agents                       the roster (every agent + trust)`);
      io.out(`  PUT  ${server.url}/agents/<agent>/trust         set autonomy`);
      io.out(`  POST ${server.url}/agents/<agent>/runs/<run>/confirm | /decline`);
      io.out(`  POST ${server.url}/agents/<agent>/reflect       propose memories to review`);
      reportHttpToken(io, consoleToken);
      // What "attach" means depends on where it bound. On loopback (the default) only
      // THIS machine can reach it; a dashboard elsewhere needs it bound beyond loopback
      // with --host (behind a TLS-terminating proxy — there is no TLS here).
      const loopback =
        server.hostname === "127.0.0.1" ||
        server.hostname === "localhost" ||
        server.hostname === "::1";
      if (loopback) {
        io.out(`  Attach a dashboard on this machine:  asterism dashboard ${server.url} --token <token>`);
        io.out("  Bound to loopback (this machine only). To reach it from another machine,");
        io.out("  re-run with --host <addr> behind a TLS-terminating proxy.");
      } else {
        io.out("  note: bound beyond loopback — put a TLS-terminating proxy in front (see docs).");
        io.out(`  Attach a dashboard from elsewhere:  asterism dashboard ${server.url} --token <token>`);
      }
      io.out("Press Ctrl+C to stop.");
      const waitForShutdown = io.waitForShutdown ?? (() => Promise.resolve());
      await waitForShutdown();
      await server.stop();
      io.out("Stopped.");
      return 0;
    }

    // Self-hosted TUI. The terminal was required above; re-bind it for the closure.
    const terminal = io.terminal;
    if (!terminal) {
      io.err(NO_TERMINAL);
      return 1;
    }
    const client = new DashboardClient(server.url, consoleToken.token);
    try {
      await runDashboard(client, terminal, { connection: "local" });
    } finally {
      // Stop the server before returning so the store (closed by `withHomeStore`)
      // is never pulled from under an in-flight request.
      await server.stop();
    }
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
    const made = await resolveAdapter(io, home, agent, store);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }
    const adapter = made.adapter;

    // Resolve the agent's opt-in recall provider (built-in lexical ranker when unset).
    // A channel requires a working config to be useful, so an opted-in-but-
    // unconfigured provider fails the launch rather than starting a bot that would
    // decline every task — the same fail-fast stance as the missing-model check above.
    const recallMade = await resolveRecall(io, store, agent);
    if (recallMade.reason) {
      io.err(recallMade.reason);
      return 1;
    }

    // Built the same way `run`/`serve` build it, so a run started from chat sees the
    // identical tool catalog, confined to this agent's workspace.
    const capabilities = io.capabilities?.(agent.workspaceDir);

    const channel = await startTelegram({
      store,
      agent,
      adapter,
      ...(recallMade.provider ? { recall: recallMade.provider } : {}),
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

// --- channel discord (chat-app front door) ---------------------------------

/** The env var holding the Discord bot token. Secrets stay out of config/flags. */
const DISCORD_TOKEN_ENV = "ASTERISM_DISCORD_TOKEN";
/** The env var holding a comma-separated allow-list, combined with `--allow`. */
const DISCORD_ALLOW_ENV = "ASTERISM_DISCORD_ALLOW";

async function cmdChannelDiscord(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.channel!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism channel discord <agent> [--allow <channel-id>[,<channel-id>...]]");
    return 1;
  }
  // A value-bearing flag given bare parses as boolean `true`; reject it rather than
  // silently treating "--allow" as no allow-list.
  if (parsed.flags.allow === true) {
    io.err("The --allow option needs a value (a comma-separated list of channel ids).");
    return 1;
  }

  if (!io.startDiscord) {
    io.err("Chat channels are not available in this embedding.");
    return 1;
  }
  const startDiscord = io.startDiscord;

  // The bot token is a secret: it comes from the environment, never config or a flag.
  const token = io.env[DISCORD_TOKEN_ENV];
  if (!token) {
    io.err(
      `Set ${DISCORD_TOKEN_ENV} to your bot token (create one in the Discord Developer Portal) before starting the channel.`,
    );
    return 1;
  }

  // The allow-list is the channel's access boundary — the Discord channels (a DM
  // channel or a server channel) permitted to drive the agent. The flag and the env
  // var are combined. An empty list is allowed: the bot starts in discovery mode (it
  // refuses every message but replies with the sender's channel id), so you can learn
  // the id and re-run with --allow. Nothing the agent can do is exposed to an
  // unauthorized channel either way.
  const allow = new Set<string>([
    ...parseAllowList(stringFlag(parsed.flags.allow)),
    ...parseAllowList(io.env[DISCORD_ALLOW_ENV]),
  ]);

  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    // Like Telegram, a chat channel has no value without a model — every message is
    // a task. Require it, and decline clearly rather than starting an idle bot.
    const made = await resolveAdapter(io, home, agent, store);
    if (!made.adapter) {
      io.err(made.reason ?? "No model configured.");
      return 1;
    }
    const adapter = made.adapter;

    // Resolve the agent's opt-in recall provider; fail the launch if it opted in but
    // is unconfigured, the same fail-fast stance as the missing-model check above.
    const recallMade = await resolveRecall(io, store, agent);
    if (recallMade.reason) {
      io.err(recallMade.reason);
      return 1;
    }

    // Built the same way `run`/`serve`/`channel telegram` build it, so a run started
    // from Discord sees the identical tool catalog, confined to this agent's workspace.
    const capabilities = io.capabilities?.(agent.workspaceDir);

    const channel = await startDiscord({
      store,
      agent,
      adapter,
      ...(recallMade.provider ? { recall: recallMade.provider } : {}),
      readFile: (p) => readFileSync(p, "utf8"),
      ...(capabilities ? { capabilities } : {}),
      allow,
      token,
      // A fatal Gateway close (e.g. the MESSAGE CONTENT intent isn't enabled) is
      // reported here, so the operator sees the cause instead of silence.
      log: (m) => io.err(m),
    });

    const who = channel.botUsername ? `@${channel.botUsername}` : "the bot";
    io.out(`Listening as ${who} for agent "${agent.name}".`);
    if (allow.size === 0) {
      io.out("  No authorized channels yet — every message is refused, but the bot replies");
      io.out("  with the sender's channel id. Re-run with --allow <id> to let a channel in.");
    } else {
      const s = allow.size === 1 ? "" : "s";
      io.out(`  ${allow.size} authorized channel${s}; messages from any other channel are refused.`);
    }
    io.out("  In a server, @mention the bot; a DM needs no mention.");
    io.out("  A destructive action pauses the run and asks the channel to reply /confirm.");
    io.out("Press Ctrl+C to stop.");

    // Block until shutdown OR the bot dies on its own (a fatal close, which `log`
    // has just reported) — without the race a dead bot would sit at "Listening…"
    // until Ctrl+C. Then stop the channel BEFORE returning, so the store (closed
    // once this callback returns) is never pulled from under a run still in flight.
    const waitForShutdown = io.waitForShutdown ?? (() => Promise.resolve());
    await Promise.race([waitForShutdown(), channel.closed ?? new Promise<void>(() => {})]);
    await channel.stop();
    io.out("Stopped.");
    return 0;
  });
}

/** Route `channel <telegram|discord> …` to the right transport. */
async function cmdChannel(rest: string[], io: CliIO): Promise<number> {
  const sub = rest[0];
  // `channel` alone prints help and is an error (no transport chosen); `--help` is not.
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.out(COMMAND_HELP.channel!);
    return sub === undefined ? 1 : 0;
  }
  if (sub === "telegram") return cmdChannelTelegram(rest.slice(1), io);
  if (sub === "discord") return cmdChannelDiscord(rest.slice(1), io);
  io.err(`Unknown subcommand: channel ${sub}`);
  io.out(COMMAND_HELP.channel!);
  return 1;
}

// --- service (keep an agent's long-lived command running as an OS service) --

/** Where this install keeps the per-service wrapper, env file, and log. */
function configHomeDir(io: CliIO): string {
  const xdg = io.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  const home = io.env.HOME;
  if (!home) throw new Error("Cannot find your home directory (HOME is not set).");
  return join(home, ".config");
}

interface ServicePaths {
  baseDir: string;
  wrapper: string;
  envFile: string;
  logFile: string;
  /** The unit/plist the OS service manager loads — platform-specific location. */
  unitFile: string;
}

function servicePaths(
  io: CliIO,
  platform: string,
  agentName: string,
  kind: ServiceKind,
): ServicePaths {
  const baseDir = join(configHomeDir(io), "asterism", "services", `${agentName}.${kind}`);
  let unitFile: string;
  if (platform === "darwin") {
    const home = io.env.HOME;
    if (!home) throw new Error("Cannot find your home directory (HOME is not set).");
    unitFile = join(home, "Library", "LaunchAgents", `${launchdLabel(agentName, kind)}.plist`);
  } else {
    unitFile = join(configHomeDir(io), "systemd", "user", systemdUnitName(agentName, kind));
  }
  return {
    baseDir,
    wrapper: join(baseDir, "run.sh"),
    envFile: join(baseDir, "service.env"),
    logFile: join(baseDir, "service.log"),
    unitFile,
  };
}

/** The platform `service` targets, or undefined when this host is unsupported. */
function servicePlatform(io: CliIO): "darwin" | "linux" | undefined {
  const platform = io.platform ?? "";
  return platform === "darwin" || platform === "linux" ? platform : undefined;
}

const UNSUPPORTED_PLATFORM =
  "Running an agent as a service is supported on macOS (launchd) and Linux (systemd).";

/** A human label for one agent's service of a given kind. */
function serviceTitle(agentName: string, kind: ServiceKind): string {
  return `${agentName} (${kind})`;
}

/** Resolve a `--kind` flag into a ServiceKind. A bare/unknown value is an error. */
function parseServiceKind(value: string | true | undefined): { kind?: ServiceKind; error?: string } {
  if (value === undefined) return { kind: "serve" };
  if (value === true) {
    return { error: "The --kind option needs a value (serve, telegram, or discord)." };
  }
  if (!isServiceKind(value)) {
    return { error: `Unknown service kind "${value}". Use serve, telegram, or discord.` };
  }
  return { kind: value };
}

/** The platform-native command to restart a service after editing its env file. */
function restartHint(platform: string, agentName: string, kind: ServiceKind): string {
  return platform === "darwin"
    ? `launchctl kickstart -k "gui/$(id -u)/${launchdLabel(agentName, kind)}"`
    : `systemctl --user restart ${systemdUnitName(agentName, kind)}`;
}

/** Whether the resolved launcher path looks like a throwaway `npx`/`bunx` cache. */
function looksEphemeral(argv: readonly string[]): boolean {
  return argv.some((a) => /[/\\](?:tmp|temp|\.cache|caches|_npx|\.npm|\.bun)[/\\]/i.test(a));
}

/** One thing a service must have in its environment to run, for the install hint. */
interface ServiceEnvNeed {
  /** What to show the operator (may name a variable or an either/or pair). */
  label: string;
  note: string;
  /** Whether the current environment already supplies it (only with --capture-env). */
  satisfied: boolean;
}

/** The environment a service of this kind reads: the variables to template/capture,
 *  and the required needs for the install hint. */
interface ServiceEnvPlan {
  vars: EnvVarSpec[];
  needs: ServiceEnvNeed[];
}

/**
 * Build the env plan for a service, mirroring EXACTLY how the foreground CLI
 * resolves a model and its key ({@link resolveModelConfig} / {@link resolveApiKey}):
 * the provider-specific key OR the `ASTERISM_API_KEY` fallback, plus the
 * `ASTERISM_MODEL_*` coordinates for anyone who configures the model through the
 * environment instead of `asterism config`. Listing (and, with `--capture-env`,
 * capturing) all of them is what keeps an installed service working in the same
 * setups that work in the user's shell — a service starts from a clean environment
 * and reads only this file (plus the on-disk config).
 */
function serviceEnvPlan(
  io: CliIO,
  home: string,
  agentName: string,
  kind: ServiceKind,
  captureEnv: boolean,
): ServiceEnvPlan {
  const config = loadConfig(home);
  const { model } = resolveModelConfig(io.env, { config, agentName });
  const keyVar = providerKeyEnvVar(model?.provider ?? "openai");
  const has = (name: string): boolean => io.env[name] !== undefined;

  const vars: EnvVarSpec[] = [];
  const needs: ServiceEnvNeed[] = [];

  // Channel bot token — required for a channel, and only reachable from the env.
  if (kind === "telegram" || kind === "discord") {
    const tokenVar = kind === "telegram" ? "ASTERISM_TELEGRAM_TOKEN" : "ASTERISM_DISCORD_TOKEN";
    const source = kind === "telegram" ? "@BotFather" : "the Discord Developer Portal";
    const app = kind === "telegram" ? "Telegram" : "Discord";
    vars.push({ name: tokenVar, required: true, note: `your ${app} bot token (from ${source}).` });
    needs.push({ label: tokenVar, note: `the ${app} bot token.`, satisfied: captureEnv && has(tokenVar) });
  }

  // HTTP access token — optional, not a blocking need: a loopback `serve` service
  // falls back to the saved per-agent token under the home (the same user, the same
  // home), so it starts fine without this. Set it to pin a STABLE secret across
  // restarts — the right move for an exposed endpoint, where the token should be
  // injected rather than read off the generated file (and found in the service log).
  if (kind === "serve") {
    vars.push({
      name: HTTP_TOKEN_ENV,
      required: false,
      note: "your HTTP access token. Optional — without it a saved per-agent token is used; set it to pin a stable secret for an exposed endpoint.",
    });
  }

  // A channel needs a model — every message is a task, so the wrapped `channel`
  // command exits at once without one. The model comes from `asterism config` (read
  // off disk, so nothing is needed here) or from ASTERISM_MODEL_* in this file. Add
  // the need only when the config file alone does not already supply it; otherwise an
  // operator can fill in every listed variable and still hit a restart loop.
  if (kind !== "serve") {
    const modelOnDisk = resolveModelConfig({}, { config, agentName }).model !== undefined;
    if (!modelOnDisk) {
      needs.push({
        label: "a configured model",
        note:
          model !== undefined
            ? "keep ASTERISM_MODEL_ID set here, or run `asterism config set <model-id>`."
            : "run `asterism config set <model-id>`, or set ASTERISM_MODEL_ID here.",
        satisfied: captureEnv && model !== undefined,
      });
    }
  }

  // Model API key — the provider-specific variable, or the ASTERISM_API_KEY fallback.
  vars.push({
    name: keyVar,
    required: kind !== "serve",
    note:
      kind === "serve"
        ? "your model API key — needed to start runs; the read endpoints work without it."
        : "your model API key — every chat message is a task, so a channel needs one.",
  });
  vars.push({
    name: "ASTERISM_API_KEY",
    required: false,
    note: `an alternative to ${keyVar} if you keep one key across providers.`,
  });
  if (kind !== "serve") {
    needs.push({
      label: `${keyVar} (or ASTERISM_API_KEY)`,
      note: "your model API key.",
      satisfied: captureEnv && (has(keyVar) || has("ASTERISM_API_KEY")),
    });
  }

  // Model coordinates — needed only when the model is chosen through the environment
  // rather than `asterism config` (the service reads the config file on disk either
  // way). Never required here, but captured when set so the env setup carries over.
  for (const name of [
    "ASTERISM_MODEL_ID",
    "ASTERISM_MODEL_PROVIDER",
    "ASTERISM_MODEL_BASE_URL",
    "ASTERISM_MODEL_API",
  ]) {
    vars.push({
      name,
      required: false,
      note: "set only if you choose your model with environment variables, not `asterism config`.",
    });
  }

  // Channel allow-list — optional access boundary.
  if (kind === "telegram") {
    vars.push({ name: "ASTERISM_TELEGRAM_ALLOW", required: false, note: "comma-separated chat ids allowed to use the bot." });
  } else if (kind === "discord") {
    vars.push({ name: "ASTERISM_DISCORD_ALLOW", required: false, note: "comma-separated channel ids allowed to use the bot." });
  }

  return { vars, needs };
}

/**
 * Write a file atomically at an exact mode. Content lands in a fresh temp file
 * (`flag: "wx"` so a planted file/symlink is never written through, and the create
 * mode is never looser than `mode`), then a rename replaces the destination — so a
 * secret env file is never momentarily world-readable, even when overwriting an
 * existing file, and a partial write is never left behind.
 */
function writeFileAtomic(filePath: string, content: string, mode: number): void {
  const tmp = `${filePath}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { mode, flag: "wx" });
  chmodSync(tmp, mode);
  renameSync(tmp, filePath);
}

/**
 * Tighten an existing private file to owner-only. Used on a re-install that keeps an
 * env file the operator filled in, so a file left at loose permissions is hardened.
 * A symlink is left untouched — that is the operator's deliberate indirection to
 * their own secret store, and we must not chmod its target.
 */
function hardenPrivateFile(filePath: string): void {
  try {
    if (lstatSync(filePath).isFile()) chmodSync(filePath, 0o600);
  } catch {
    // Best-effort: a missing or unusual file is handled by the write paths above.
  }
}

async function cmdServiceInstall(args: string[], io: CliIO): Promise<number> {
  // Split off passthrough args after `--` BEFORE parsing, so flags meant for the
  // supervised command (e.g. `serve --port 8080`) are forwarded verbatim rather than
  // read as `service`'s own flags.
  const sep = args.indexOf("--");
  const head = sep === -1 ? args : args.slice(0, sep);
  const passthrough = sep === -1 ? [] : args.slice(sep + 1);

  const parsed = parseArgs(head, ["help", "h", "capture-env"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.service!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err(
      "Usage: asterism service install <agent> [--kind serve|telegram|discord] [--capture-env] [-- <args>]",
    );
    return 1;
  }
  const captureEnv = parsed.flags["capture-env"] === true;
  const { kind, error } = parseServiceKind(parsed.flags.kind);
  if (error || !kind) {
    io.err(error ?? "A service kind is required.");
    return 1;
  }

  const platform = servicePlatform(io);
  if (!platform) {
    io.err(UNSUPPORTED_PLATFORM);
    return 1;
  }
  if (!io.selfInvocation || io.selfInvocation.length === 0) {
    io.err("Cannot determine how to launch asterism for a service in this embedding.");
    return 1;
  }
  const selfInvocation = io.selfInvocation;

  return withHomeStore(io, async (store, home) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    const workingDir = dirname(home);
    const paths = servicePaths(io, platform, agent.name, kind);
    const argv = [...selfInvocation, ...serviceCommand(kind, agent.name), ...passthrough];

    // A service references asterism by absolute path; warn if that path looks
    // ephemeral (a one-off `npx`/`bunx` cache) since the service would break once the
    // cache is cleaned. Non-fatal — the operator may know better.
    if (looksEphemeral(selfInvocation)) {
      io.err("warning: asterism appears to be running from a temporary install path, so this");
      io.err("         service may stop working later. Install asterism durably (globally or in");
      io.err("         the project) before relying on it.");
    }

    // Write the service's files. By default the env file is a TEMPLATE — variable
    // names only, no values — and is never overwritten once it exists, so a
    // re-install keeps the secrets you filled in. `--capture-env` is the explicit
    // opt-in to instead write the values present in your environment NOW into the
    // 0600 file (overwriting it). The wrapper and unit are always regenerated.
    mkdirSync(paths.baseDir, { recursive: true });
    chmodSync(paths.baseDir, 0o700); // the dir holds the private env file and wrapper
    const envPlan = serviceEnvPlan(io, home, agent.name, kind, captureEnv);
    if (captureEnv) {
      writeFileAtomic(paths.envFile, renderEnvFile(serviceTitle(agent.name, kind), envPlan.vars, (n) => io.env[n]), 0o600);
    } else if (!existsSync(paths.envFile)) {
      writeFileAtomic(paths.envFile, renderEnvTemplate(serviceTitle(agent.name, kind), envPlan.vars), 0o600);
    } else {
      // Keep the operator's filled-in file, but make sure it stays owner-only.
      hardenPrivateFile(paths.envFile);
    }
    writeFileAtomic(
      paths.wrapper,
      renderWrapper({ label: serviceTitle(agent.name, kind), argv, workingDir, envFile: paths.envFile }),
      0o700,
    );

    mkdirSync(dirname(paths.unitFile), { recursive: true });
    const unit =
      platform === "darwin"
        ? renderLaunchdPlist({
            label: launchdLabel(agent.name, kind),
            wrapperPath: paths.wrapper,
            workingDir,
            logFile: paths.logFile,
          })
        : renderSystemdUnit({
            description: `Asterism — ${serviceTitle(agent.name, kind)}`,
            wrapperPath: paths.wrapper,
            workingDir,
          });
    writeFileAtomic(paths.unitFile, unit, 0o644);

    // Register with the service manager so it starts now and on login. Registration
    // failing is fatal; the service merely failing to STAY up (e.g. an env file not
    // filled in yet) is reported as a note, not an install failure.
    const run = io.runCommand;
    if (!run) {
      io.err("note: the service files were written, but registering with the service manager");
      io.err("      is not available in this embedding.");
    } else if (platform === "darwin") {
      // Unload first so a re-install cleanly replaces a previously-loaded job.
      await run("launchctl", ["unload", paths.unitFile]).catch(() => undefined);
      const loaded = await run("launchctl", ["load", "-w", paths.unitFile]);
      if (loaded.code !== 0) {
        io.err(`launchctl could not load the service: ${loaded.stderr.trim() || `exit ${loaded.code}`}`);
        return 1;
      }
    } else {
      const reloaded = await run("systemctl", ["--user", "daemon-reload"]);
      if (reloaded.code !== 0) {
        io.err(`systemctl could not reload units: ${reloaded.stderr.trim() || `exit ${reloaded.code}`}`);
        return 1;
      }
      const unitName = systemdUnitName(agent.name, kind);
      const enabled = await run("systemctl", ["--user", "enable", unitName]);
      if (enabled.code !== 0) {
        io.err(`systemctl could not enable the service: ${enabled.stderr.trim() || `exit ${enabled.code}`}`);
        return 1;
      }
      const started = await run("systemctl", ["--user", "restart", unitName]);
      if (started.code !== 0) {
        io.err("note: the service is registered but did not start — often a value still missing");
        io.err(`      from its env file. Check it with: asterism service status ${agent.name}`);
      }
    }

    const display = [...serviceCommand(kind, agent.name), ...passthrough].join(" ");
    io.out(`Installed service "${serviceTitle(agent.name, kind)}".`);
    io.out(`  Keeps \`asterism ${display}\` running and restarts it if it fails.`);
    io.out(`  Env file (0600): ${paths.envFile}`);
    if (captureEnv) {
      const captured = envPlan.vars.filter((v) => io.env[v.name] !== undefined).map((v) => v.name);
      io.out(
        captured.length > 0
          ? `  Captured from your environment: ${captured.join(", ")}`
          : "  --capture-env: none of the variables this service needs are set right now.",
      );
    }
    // What the service still lacks to run: required needs capture did not satisfy (or,
    // without --capture-env, all of them — the operator fills the template in by hand).
    // The API-key need is satisfied by EITHER the provider key or ASTERISM_API_KEY.
    const missing = envPlan.needs.filter((n) => !n.satisfied);
    if (missing.length > 0) {
      io.out("  Before it can work, set these in that file:");
      for (const n of missing) io.out(`    ${n.label}   ${n.note}`);
      io.out(`  Edit it, then restart: ${restartHint(platform, agent.name, kind)}`);
    }
    io.out(`  Review it: asterism service status ${agent.name}`);
    io.out(
      `  Remove it: asterism service uninstall ${agent.name}${kind === "serve" ? "" : ` --kind ${kind}`}`,
    );
    if (platform === "linux") {
      io.out("  To start before you log in (at boot), enable lingering: loginctl enable-linger");
    }
    return 0;
  });
}

/** Describe one installed service's current state via the OS service manager. */
async function serviceState(
  io: CliIO,
  platform: string,
  agentName: string,
  kind: ServiceKind,
): Promise<string> {
  const run = io.runCommand;
  if (!run) return "installed (state unavailable in this embedding)";
  if (platform === "darwin") {
    const res = await run("launchctl", ["list", launchdLabel(agentName, kind)]);
    if (res.code !== 0) return "installed, not loaded";
    const pid = /"PID"\s*=\s*(\d+)/.exec(res.stdout);
    if (pid) return `running (pid ${pid[1]})`;
    const last = /"LastExitStatus"\s*=\s*(\d+)/.exec(res.stdout);
    if (last && last[1] !== "0") return `loaded, not running (last exit ${last[1]} — check the log)`;
    return "loaded, not running";
  }
  const unitName = systemdUnitName(agentName, kind);
  const active = await run("systemctl", ["--user", "is-active", unitName]);
  const enabled = await run("systemctl", ["--user", "is-enabled", unitName]);
  const activeWord = active.stdout.trim() || `exit ${active.code}`;
  const enabledWord = enabled.stdout.trim() || `exit ${enabled.code}`;
  return `${activeWord} (${enabledWord})`;
}

async function cmdServiceStatus(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.service!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism service status <agent> [--kind serve|telegram|discord]");
    return 1;
  }
  // With no --kind, status reports across every kind; with one, only that kind.
  let filterKind: ServiceKind | undefined;
  if (parsed.flags.kind !== undefined) {
    const { kind, error } = parseServiceKind(parsed.flags.kind);
    if (error || !kind) {
      io.err(error ?? "A service kind is required.");
      return 1;
    }
    filterKind = kind;
  }
  const platform = servicePlatform(io);
  if (!platform) {
    io.err(UNSUPPORTED_PLATFORM);
    return 1;
  }

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    const kinds = filterKind ? [filterKind] : SERVICE_KINDS;
    const installed = kinds.filter((k) => existsSync(servicePaths(io, platform, agent.name, k).unitFile));
    if (installed.length === 0) {
      io.out(
        filterKind
          ? `No "${filterKind}" service installed for "${agent.name}".`
          : `No services installed for "${agent.name}".`,
      );
      return 0;
    }
    for (const k of installed) {
      const paths = servicePaths(io, platform, agent.name, k);
      const state = await serviceState(io, platform, agent.name, k);
      io.out(`${serviceTitle(agent.name, k)} — ${state}`);
      io.out(`  env:  ${paths.envFile}`);
      io.out(
        platform === "darwin"
          ? `  log:  ${paths.logFile}`
          : `  logs: journalctl --user -u ${systemdUnitName(agent.name, k)}`,
      );
    }
    return 0;
  });
}

async function cmdServiceUninstall(args: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, ["help", "h"]);
  if (helpRequested(parsed)) {
    io.out(COMMAND_HELP.service!);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) {
    io.err("Usage: asterism service uninstall <agent> [--kind serve|telegram|discord]");
    return 1;
  }
  let filterKind: ServiceKind | undefined;
  if (parsed.flags.kind !== undefined) {
    const { kind, error } = parseServiceKind(parsed.flags.kind);
    if (error || !kind) {
      io.err(error ?? "A service kind is required.");
      return 1;
    }
    filterKind = kind;
  }
  const platform = servicePlatform(io);
  if (!platform) {
    io.err(UNSUPPORTED_PLATFORM);
    return 1;
  }

  return withHomeStore(io, async (store) => {
    const agent = findAgentByName(store, name);
    if (!agent) return noAgent(io, name);

    const kinds = filterKind ? [filterKind] : SERVICE_KINDS;
    const installed = kinds.filter((k) => existsSync(servicePaths(io, platform, agent.name, k).unitFile));
    if (installed.length === 0) {
      io.out(
        filterKind
          ? `No "${filterKind}" service installed for "${agent.name}".`
          : `No services installed for "${agent.name}".`,
      );
      return 0;
    }
    const run = io.runCommand;
    for (const k of installed) {
      const paths = servicePaths(io, platform, agent.name, k);
      if (run) {
        if (platform === "darwin") {
          await run("launchctl", ["unload", "-w", paths.unitFile]).catch(() => undefined);
        } else {
          await run("systemctl", ["--user", "disable", "--now", systemdUnitName(agent.name, k)]).catch(
            () => undefined,
          );
        }
      }
      // Remove the unit + the wrapper and log we generated. LEAVE the env file: it
      // may hold the operator's secrets, so deleting it is their call, not ours.
      rmSync(paths.unitFile, { force: true });
      rmSync(paths.wrapper, { force: true });
      rmSync(paths.logFile, { force: true });
      if (platform === "linux" && run) await run("systemctl", ["--user", "daemon-reload"]);
      io.out(`Removed service "${serviceTitle(agent.name, k)}".`);
      if (existsSync(paths.envFile)) {
        io.out(`  Left its env file in place (it may hold secrets): ${paths.envFile}`);
      }
    }
    return 0;
  });
}

/** Route `service <install|status|uninstall> …` to its handler. */
async function cmdService(rest: string[], io: CliIO): Promise<number> {
  const sub = rest[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.out(COMMAND_HELP.service!);
    return sub === undefined ? 1 : 0;
  }
  if (sub === "install") return cmdServiceInstall(rest.slice(1), io);
  if (sub === "status") return cmdServiceStatus(rest.slice(1), io);
  if (sub === "uninstall") return cmdServiceUninstall(rest.slice(1), io);
  io.err(`Unknown subcommand: service ${sub}`);
  io.out(COMMAND_HELP.service!);
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
    case "dashboard":
      return cmdDashboard(rest, io);
    case "channel":
      return cmdChannel(rest, io);
    case "service":
      return cmdService(rest, io);
    case "secrets":
      return dispatchSub("secrets", "add", cmdSecretsAdd, COMMAND_HELP.secrets!, rest, io);
    case "skill":
      return dispatchSub("skill", "add", cmdSkillAdd, COMMAND_HELP.skill!, rest, io);
    case "objective":
      return cmdObjective(rest, io);
    case "notes":
      return cmdNotes(rest, io);
    case "memory":
      return dispatchSub("memory", "inspect", cmdMemoryInspect, COMMAND_HELP.memory!, rest, io);
    case "events":
      return dispatchSub("events", "tail", cmdEventsTail, COMMAND_HELP.events!, rest, io);
    case "trace":
      return cmdTrace(rest, io);
    default:
      io.err(`Unknown command: ${command}`);
      io.out(USAGE);
      return 1;
  }
}
