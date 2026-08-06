// Run orchestration — the kernel's "execute a run" flow, shared by every surface.
//
// Starting a run is never a single store write. It is a sequence the KERNEL owns:
// record the run, move it to `running`, resolve the agent's trust level into a
// gated tool registry (with every gate decision audited to the event log), frame
// the run from the agent's identity (soul, role, scoped skills, accepted
// memories), hand the framed request to the substrate, then persist the outcome —
// a terminal status, or a pause when the destructive-action gate fires.
//
// Surfaces must NOT reimplement this. Drift here would be drift in the trust/gate
// path — the one place that must behave identically no matter how a run was
// triggered (CLI, HTTP, or a future surface). So it lives in core behind one call.
// The surfaces supply only host concerns they legitimately own — the substrate, a
// file reader for soul/skill bodies, an optional confirmation prompt — and format
// the structured result. Filesystem and environment access stay at the surface;
// this function takes an injected `readFile` and never imports `node:fs`.

import type { RuntimeAdapter, RunOutput, RunEvent, ToolResult } from "./adapter.js";
import { frameRun, resolveSoul } from "./framing.js";
import type { SkillContext } from "./framing.js";
import { DEFAULT_RECALL_BUDGET, defaultRecallProvider, enforceRecall } from "./recall.js";
import type { RecallBudget, RecallProvider } from "./recall.js";
import { auditTrustHooks } from "./audit.js";
import { actionFingerprint, classifyEffect, resolveToolRegistry, trustProfile } from "./trust.js";
import type { Action, Capability, EffectClass, PreApprovalVerdict, TrustHooks } from "./trust.js";
import {
  worldFactCapabilities,
  WORLD_FACT_RECORD_KEY,
  WORLD_FACT_FORGET_KEY,
  WORLD_FACT_RECORD_TOOL,
  WORLD_FACT_FORGET_TOOL,
} from "./world-facts.js";
import { harvestWorldFactCandidates } from "./world-fact-harvest.js";
import type { ObservedEffect } from "./world-fact-harvest.js";
import { collectArtifactManifest, parseArtifactReference } from "./artifact-manifest.js";
import type { ArtifactRef } from "./artifact-manifest.js";
import { WorldFactCapError } from "./repositories/world-facts.js";
import { MemoryFirewallError } from "./firewall.js";
import type { AsterismStore } from "./store.js";
import type { Agent, Connection, ConnectionMode, Run, RunStatus } from "./types.js";

/** Host concerns a run needs that the kernel does not own — all injectable. */
export interface ExecuteRunOptions {
  /** The substrate that runs the agent loop (the surface builds it from config). */
  adapter: RuntimeAdapter;
  /**
   * Reads a file's text — used to resolve the agent's soul and inline its skill
   * bodies. Injected so core stays free of `node:fs`. Absent ⇒ souls resolve to
   * built-ins only and skills are framed by name without their bodies.
   */
  readFile?: (path: string) => string;
  /**
   * Resolve a destructive action's confirmation. Absent ⇒ the action stays paused
   * and the run ends `awaiting_confirmation` — the safe default for a
   * non-interactive caller (e.g. the HTTP surface). The destructive-action gate
   * fires at every trust level regardless of this callback.
   */
  confirm?: (action: Action) => boolean | Promise<boolean>;
  /**
   * Capabilities to expose to this run. Confined by default: absent ⇒ an empty
   * tool set. A host supplies the real catalog (the CLI ships workspace-scoped
   * file tools); the kernel filters it by trust level and gates whatever it is
   * handed — it never constructs a tool itself.
   */
  capabilities?: readonly Capability[];
  /**
   * Selects which of the agent's accepted memories frame this run. Absent ⇒ the
   * default lexical ranker ({@link defaultRecallProvider}). The kernel resolves
   * the agent's own candidates and hands them in, so a provider only ranks within
   * one agent's memory — it never reaches the store or another agent's rows.
   */
  recall?: RecallProvider;
  /**
   * An explicit, host-level recall budget override — the HIGHEST-precedence source.
   * Absent ⇒ the kernel resolves the effective budget from the agent's own setting
   * (`resolveRecallBudget`: the per-agent override, else {@link DEFAULT_RECALL_BUDGET}).
   * So a host can still force a budget per call, but the normal path is the
   * operator-configured per-agent value, not a hard-coded default. When the agent
   * holds fewer memories than the resolved budget, framing is unchanged — the budget
   * only bites once memory grows past it.
   */
  recallBudget?: RecallBudget;
  /**
   * Optional sink for the substrate's lifecycle events as they arrive, so a
   * surface can show a run's activity live (CLI progress, HTTP SSE). The kernel
   * is the single consumer of the adapter's event stream and only forwards each
   * event here — it never acts on one. Payloads are references-only by the
   * adapter contract (event type, counts, tool names), never transcript text, so
   * forwarding cannot leak what a run read or produced. A sink that throws is
   * isolated per event and never fails the run.
   */
  onEvent?: (event: RunEvent) => void;
}

/**
 * One gate decision taken during a run, as a reference-only record for the
 * post-run summary a surface shows ("what it did" — the `notify`/`autonomous`
 * notification). It carries the capability key and the action's *classified*
 * effect (escalated to `destructive` when the command tripped the taxonomy) and
 * nothing else — never the action's arguments, which can hold a live secret.
 * Sourced from the same gate hooks that feed the event log.
 */
export interface ActionRecord {
  capability: string;
  effect: EffectClass;
  /**
   * - `executed` — the action ran: an ordinary side effect, or a destructive one
   *   the human confirmed.
   * - `withheld` — a side effect not run under `propose` (recorded as a plan step).
   * - `paused`   — a destructive action that stopped the run awaiting confirmation
   *   and was never approved.
   */
  decision: "executed" | "withheld" | "paused";
}

/**
 * The outcome of harvesting a run's state-changing observations into proposed working
 * notes (#84 T3). All references-only counts — never the harvested subjects/values.
 * `proposed` notes are INERT until the operator accepts them (`notes accept`).
 */
export interface HarvestSummary {
  /** New/superseded working notes proposed for review. */
  proposed: number;
  /** Candidates dropped because the agent's working notes were full (the cap — no silent loss). */
  dropped: number;
  /**
   * Candidates skipped without proposing — a no-op (the accepted note or a pending proposal
   * already holds this value, so there is nothing to review — world-model.md §12) or a value
   * the firewall blocked (already audited `world_fact.blocked`).
   */
  skipped: number;
}

/** The outcome of {@link executeRun}: the final run row, its status, and output. */
export interface ExecuteRunResult {
  /** The run row in its final persisted state. */
  run: Run;
  /**
   * The run's resulting status: `done` / `failed`, or `awaiting_confirmation`
   * when a destructive action paused it (the gate fired and no confirmation
   * resolved it).
   */
  status: RunStatus;
  /** The agent's final text output (may be empty). */
  output: string;
  /** Present when the run failed — the substrate's error message. */
  error?: string;
  /**
   * The gate decisions taken during the run, in order — what the agent did
   * (executed), what it withheld under `propose`, and any destructive action that
   * paused it. References only (capability + classified effect). A surface renders
   * these as the post-run summary; the empty array means the run took no actions.
   */
  actions: readonly ActionRecord[];
  /**
   * The working-note harvest outcome (#84 T3), present when a terminal run derived any
   * proposed notes from its state-changing observations. Absent for a run that produced
   * none, and for a run paused `awaiting_confirmation` (harvest runs only at a terminal
   * exit — the resumed run harvests). References-only counts.
   */
  harvest?: HarvestSummary;
  /**
   * The workspace artifacts this run produced — references only (path/kind/exists/size),
   * never file contents. Absent when the run produced none. Derived from the SAME
   * state-changing observation stream the working-note harvest reduces, so it describes
   * only what actually executed under the gate: an action withheld under `propose`, or
   * paused and never confirmed, contributes no observation and therefore no artifact.
   *
   * This is the payload of the `artifact-only` collaboration mode (Phase 3 · T2a), and is
   * populated for every run — an ordinary direct run simply has no surface that renders it.
   */
  artifacts?: readonly ArtifactRef[];
}

/**
 * Resolve the effective recall budget for an agent's run, in precedence order:
 *
 *   1. the agent's own per-agent override (`agent_settings.recall_budget`), else
 *   2. the install-wide default (`install_settings.recall_budget`), else
 *   3. the kernel's built-in constant ({@link DEFAULT_RECALL_BUDGET}).
 *
 * The kernel owns this resolution so every surface (CLI, HTTP, the dashboard, channels)
 * gets the same effective value from one place and can never drift on it — the same reason
 * the run flow itself lives in one call, and why the install-wide default is read HERE from
 * the kernel store rather than threaded in by each surface. The per-agent read is
 * `agentId`-scoped, so an agent's own override is resolved only from its own setting; the
 * install-wide row carries no agent data.
 *
 * An explicit `options.recallBudget` still wins over all three (see {@link ExecuteRunOptions});
 * this is the resolution for the normal path where no host override is supplied.
 */
export function resolveRecallBudget(store: AsterismStore, agent: Agent): RecallBudget {
  const perAgent = store.agentSettings.getRecallBudget(agent.id);
  if (perAgent !== undefined) return { maxMemories: perAgent };
  const installDefault = store.installSettings.getRecallBudget();
  if (installDefault !== undefined) return { maxMemories: installDefault };
  return DEFAULT_RECALL_BUDGET;
}

/** Read a file's text via the injected reader, or undefined if it cannot be read. */
function readMaybe(
  readFile: ((path: string) => string) | undefined,
  path: string,
): string | undefined {
  if (!readFile) return undefined;
  try {
    return readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Forward a run's lifecycle events to a sink as they arrive. Best-effort and
 * isolated from the run's result: the event stream is progress, never the
 * outcome (that travels via `RunOutput`), so neither a substrate that errors its
 * stream nor a sink that throws may fail the run or mask its real output. A
 * faulty sink is guarded per event so one bad call cannot stop the rest of the
 * stream. With no sink there is nothing to forward, so we never iterate at all.
 *
 * Resolves only when the stream CLOSES. The {@link RunHandle} contract settles
 * output and events independently, so the caller must not let this gate the run's
 * result (see {@link flushEvents}) — a non-conforming adapter could leave its
 * stream open forever.
 */
async function drainEvents(
  events: AsyncIterable<RunEvent>,
  onEvent: ((event: RunEvent) => void) | undefined,
): Promise<void> {
  if (!onEvent) return;
  try {
    for await (const event of events) {
      try {
        onEvent(event);
      } catch {
        // A faulty sink never breaks streaming or the run.
      }
    }
  } catch {
    // The stream itself errored — ignore; the real result travels via `output`.
  }
}

/** Resolves on the next macrotask — after every currently-pending microtask. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the event drain to finish, but never let it gate the run's result. By
 * the time this is called the run's output has already settled, so a conforming
 * adapter has closed its stream and `drained` resolves within microtasks — winning
 * this race, so every event is flushed before the surface formats its result. A
 * non-conforming adapter that leaves its stream open loses to the macrotask tick,
 * so it cannot hang the kernel past the run's completion; its late events are
 * dropped, which the contract permits (events are progress, not the outcome).
 */
function flushEvents(drained: Promise<void>): Promise<void> {
  return Promise.race([drained, nextMacrotask()]);
}

/**
 * Execute one task for `agent` through the substrate, persisting every transition
 * to the agent-scoped store and event log. Returns the final run, its status, and
 * the agent's output — the surface decides how to present them. The agent and
 * store must already be resolved by the caller; this owns everything from
 * `startRun` onward.
 */
export async function executeRun(
  store: AsterismStore,
  agent: Agent,
  input: string,
  options: ExecuteRunOptions,
): Promise<ExecuteRunResult> {
  // Record the run and move it to `running`; the kernel logs each transition.
  const run = store.startRun(agent.id, { input });
  store.setRunStatus(agent.id, run.id, "running");
  // A fresh run has nothing executed and nothing confirmed, so every destructive
  // action gates (pauses) regardless of trust level. The resume path (`resumeRun`) is
  // the only caller that supplies prior state.
  return runAndPersist(store, agent, run, input, options, {
    executedCount: new Map(),
    confirmedCount: new Map(),
  });
}

/**
 * The shared run loop: trust-resolve + gate → frame → substrate → persist, for a
 * run that is ALREADY recorded and `running`. Both starting a run (`executeRun`)
 * and resuming a parked one (`resumeRun`) funnel through here, so the trust/gate
 * path is identical whether a run is fresh or resumed — there is one place where
 * the agent's identity, trust level, and tools turn into an executed (and audited)
 * outcome.
 *
 * `preApproved` is the ONLY difference between the two callers: empty maps for a
 * fresh run (every destructive action pauses), or per-invocation counts for a resume
 * — how many times each exact invocation has already EXECUTED (skip those on replay)
 * and how many a human has CONFIRMED (run up to that, pause the rest). So resuming
 * clears exactly the confirmed invocations, never re-executes one already done, and
 * still pauses a different capability, the same capability aimed at a new target, or
 * an identical call beyond the confirmed count. A resume never widens the gate into a
 * blanket grant.
 */
async function runAndPersist(
  store: AsterismStore,
  agent: Agent,
  run: Run,
  input: string,
  options: ExecuteRunOptions,
  preApproved: {
    executedCount: ReadonlyMap<string, number>;
    confirmedCount: ReadonlyMap<string, number>;
  },
): Promise<ExecuteRunResult> {
  // Resolve the agent's trust level into the tool set this run may use, with the
  // destructive-action gate wired into every tool's `execute` closure and each
  // gate decision audited to the event log. Confined by default — the exposure
  // list is derived from exactly the capabilities the caller handed in (an empty
  // set if none).
  const abortController = new AbortController();
  // The kernel-owned world-fact tools (`record_note` / `forget_note`) are injected on
  // EVERY run — they are the agent's own bounded, firewalled, capped, audited,
  // operator-revertible self-state, not a host-environment capability (so "confined by
  // default", which governs the host catalog, does not gate them; the agent already
  // always has memory/objectives framing it, and working notes are the writable
  // sibling). They are appended to whatever the host supplied so they ride the SAME
  // trust resolution and gate as every other capability: both are `effect: "write"`, so
  // a `propose` agent withholds them and a `notify`/`autonomous` agent executes +
  // audits them. The host's `CliIO.capabilities` seam stays store-free — these are the
  // kernel's own tools over its own state, built where the store lives. Both fresh runs
  // and resumes funnel through here, so a resumed run keeps them too.
  //
  // The world-fact keys AND tool names are RESERVED for the kernel: any host capability
  // colliding on either is dropped before the kernel's own is appended, so the registry
  // never carries two tools with the same key OR the same name. The name check matters
  // independently — the adapter forwards tools to the provider by `tool.name`, so a host
  // capability reusing `record_note`/`forget_note` under a different key would still
  // produce a duplicate name that a tool-calling provider rejects. The kernel's tool over
  // its own state is authoritative for its reserved namespace.
  const reservedKeys = new Set<string>([WORLD_FACT_RECORD_KEY, WORLD_FACT_FORGET_KEY]);
  const reservedToolNames = new Set<string>([WORLD_FACT_RECORD_TOOL, WORLD_FACT_FORGET_TOOL]);
  const hostCapabilities = (options.capabilities ?? []).filter(
    (c) => !reservedKeys.has(c.key) && !reservedToolNames.has(c.tool.name),
  );
  // Pass `run.id` so the tools' `world_fact.*` events are tagged with the originating run
  // (per-run audit completeness, incl. a firewall-blocked record the gate never logs).
  const capabilities = [...hostCapabilities, ...worldFactCapabilities(store, agent.id, run.id)];
  const profile = trustProfile({
    level: agent.trustLevel,
    capabilities: capabilities.map((c) => c.key),
    // Earned standing is the FIRST real producer of the destructive gate's
    // `autoApprove` allow-list: a destructive capability the agent has EARNED — and a
    // human has RATIFIED — a `standing-grant` on auto-approves, exactly as a
    // statically-configured allow-list entry would (`decideGate` is untouched). This
    // only ever ADDS keys the gate already knows how to honor; it never weakens
    // classification, never crosses capabilities, and — `grantedKeys` is
    // agentId-scoped — never crosses agents. With no grants it is the empty set, so
    // the gate behaves exactly as before.
    autoApprove: store.capabilityStanding.grantedKeys(agent.id),
  });
  // The agent's secret key for fingerprinting a paused action's arguments. The same
  // key feeds the audit (which records the fingerprint on a pause) and the gate
  // (which recomputes it to match a pre-approval), so the two agree, and a reader of
  // the event log cannot guess the fingerprint without it.
  const fingerprintKey = store.actionFingerprintKey(agent.id);
  // The resume's per-invocation disposition. For the k-th occurrence of an invocation
  // (key = capability + arguments fingerprint) in THIS replay: SKIP the first
  // `executedCount` (they already ran on an earlier confirm — never repeat them), RUN
  // the next up to `confirmedCount` (the occurrences a human confirmed), and GATE the
  // rest (pause). `replayOccurrence` counts occurrences seen so far this replay; both
  // count maps are empty for a fresh run, so every destructive action gates.
  const { executedCount, confirmedCount } = preApproved;
  const replayOccurrence = new Map<string, number>();
  const preApproval = (action: Action): PreApprovalVerdict => {
    const key = approvalKey(action.capability, actionFingerprint(action.args, fingerprintKey));
    const k = (replayOccurrence.get(key) ?? 0) + 1;
    replayOccurrence.set(key, k);
    if (k <= (executedCount.get(key) ?? 0)) return "skip";
    if (k <= (confirmedCount.get(key) ?? 0)) return "run";
    return "gate";
  };
  // Accumulate the run's gate decisions for the post-run summary, sourced from the
  // same hooks that feed the event log. EVERY decision is pushed into `actions` in
  // the order it happened — a pause included — so the summary is "one entry per gate
  // decision, in order" no matter how many actions overlap. The gate records a pause
  // only when an action is actually denied confirmation (it consults `confirm`
  // first), so a single invocation triggers `onAwaitConfirmation` OR `onExecute`,
  // never both — there is nothing to reclassify.
  const actions: ActionRecord[] = [];
  const record = (action: Action, decision: ActionRecord["decision"]): ActionRecord => ({
    capability: action.capability,
    effect: classifyEffect(action),
    decision,
  });
  const collectActions = (): readonly ActionRecord[] => actions;

  // Collect the structured observations of the run's SUCCESSFUL tool calls, in execution
  // order, for the end-of-run working-note harvest (#84 T3). The gate fires `onObservation`
  // only after a tool ran without error and returned one, so a withheld (`propose`) or
  // paused action contributes nothing — a `propose` agent harvests nothing. Pure data here;
  // selection (state-changing only) and rendering live in the pure `harvestWorldFactCandidates`.
  const collected: ObservedEffect[] = [];

  // Harvest the collected observations into PROPOSED working notes, called at EVERY exit of
  // this invocation (terminal AND a pause). Why every exit, not only terminal: an
  // observation lives in `collected` ONLY during the invocation whose tool produced it. A
  // run that executes a confirmed destructive action and then PAUSES on a later one would,
  // if harvest skipped the pause, discard that first action's observation — and the next
  // resume SKIPS the already-performed destructive call (`alreadyPerformedResult`, the tool
  // never re-runs), so it never re-observes it. Harvesting at the pause too captures each
  // change at the first exit after it ran. Re-harvesting on a resume is safe because
  // `proposeWorldFact` is idempotent per subject (a still-`proposed` subject supersedes in
  // place; a re-observation matching the accepted value is a no-op), so the re-run of
  // reversible actions across resumes does not duplicate notes — at most a redundant
  // `world_fact.recorded` for a changed proposed value.
  // [Codex review R1 P2: terminal-only dropped an intermediate destructive action's change.]
  //
  // COEXISTENCE (world-model.md §12): a proposed UPDATE now COEXISTS with the accepted note it
  // would supersede (the accepted one keeps framing until the operator accepts the update) —
  // so the harvest keeps an already-accepted subject CURRENT instead of skipping it (the old
  // conservative-skip). Each candidate is screened + capped + audited by
  // `store.proposeWorldFact` (the kernel re-enforcing on derived, not-self-authored content);
  // the proposals are inert until the operator accepts them (`notes accept`). Returns a
  // references-only summary, or undefined when there was nothing to harvest (so the result
  // field is absent for an empty harvest). Resilient by design: one candidate failing never
  // aborts the rest.
  //   - undefined return — a no-op: the accepted note (or a pending proposal) already holds
  //     this value, so nothing was queued. Count it as skipped.
  //   - WorldFactCapError — the agent's notes are full for a brand-NEW subject; count this one
  //     as dropped and CONTINUE (no silent loss — the cap rejects, never evicts). Not a `break`:
  //     a later candidate for an already-tracked subject is an update that takes no slot, so it
  //     must still apply even after the cap was hit on an earlier new subject. [Codex R3 P2.]
  //   - MemoryFirewallError — a poisoned subject/value (e.g. an injection-shaped filename);
  //     already audited `world_fact.blocked` by the store, so skip and continue.
  const harvestWorkingNotes = (): HarvestSummary | undefined => {
    const candidates = harvestWorldFactCandidates(collected);
    if (candidates.length === 0) return undefined;
    let proposed = 0;
    let dropped = 0;
    let skipped = 0;
    for (const { subject, value } of candidates) {
      try {
        const fact = store.proposeWorldFact(agent.id, subject, value, run.id);
        if (fact === undefined) skipped += 1;
        else proposed += 1;
      } catch (err) {
        if (err instanceof WorldFactCapError) {
          dropped += 1;
          continue;
        }
        if (err instanceof MemoryFirewallError) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    return { proposed, dropped, skipped };
  };

  // The SECOND pure projection of the same observation stream (Phase 3 · T2a): the
  // references-only manifest of workspace artifacts this run produced, which is what an
  // `artifact-only` exchange returns to the caller in place of the callee's text. Called at
  // every exit alongside the harvest, and for the same reason — an observation lives in
  // `collected` only during the invocation whose tool produced it, so a run that acts and
  // then pauses would otherwise lose the artifact it already made. Unlike the harvest this
  // writes nothing; it is a pure reduction, so recomputing it on a resume is free.
  const collectArtifacts = (): readonly ArtifactRef[] => collectArtifactManifest(collected);

  // Fail-safe asymmetry — autonomy is lost faster than it is earned. A run that
  // EXECUTED an earned (granted) destructive capability and then FAILED loses that
  // grant: the capability is downgraded to `gated`, so its next invocation pauses for
  // confirmation again until it re-earns standing from a fresh track record (the
  // evidence window resets at the downgrade). Scoped to exactly the granted
  // capabilities that ran in THIS run — a failure that never touched a granted
  // capability leaves every grant intact. Only the terminal/catch FAILED exits call
  // this; a paused or declined run never does, so neither revokes.
  const revokeFailedGrants = (): void => {
    const executedDestructive = new Set(
      actions
        .filter((a) => a.decision === "executed" && a.effect === "destructive")
        .map((a) => a.capability),
    );
    if (executedDestructive.size === 0) return;
    for (const capability of store.capabilityStanding.grantedKeys(agent.id)) {
      if (executedDestructive.has(capability)) {
        store.setCapabilityStanding(
          agent.id,
          capability,
          "gated",
          "revoked after a failed run",
          run.id,
        );
      }
    }
  };

  const baseHooks: TrustHooks = {
    onAwaitConfirmation: (action) => {
      store.setRunStatus(agent.id, run.id, "awaiting_confirmation");
      actions.push(record(action, "paused"));
    },
    onExecute: (action) => {
      actions.push(record(action, "executed"));
    },
    onObservation: (observation, effect) => {
      collected.push({ observation, effect });
    },
    onWithhold: (action) => {
      actions.push(record(action, "withheld"));
    },
    preApproval,
    abortController,
    ...(options.confirm ? { confirm: options.confirm } : {}),
  };
  const hooks = auditTrustHooks(store.events, agent.id, { runId: run.id, fingerprintKey }, baseHooks);
  const tools = resolveToolRegistry(profile, capabilities, hooks);

  // Frame the run from the agent's identity: soul, role, scoped skills, and the
  // memories it has accepted (framing filters to active + accepted).
  const soulText = resolveSoul(
    agent.soulRef,
    options.readFile ? { readFile: options.readFile } : {},
  );
  const skills: SkillContext[] = store.skills.list(agent.id).map((s) => {
    const content = readMaybe(options.readFile, s.path);
    return { name: s.name, ...(content !== undefined ? { content } : {}) };
  });
  // The agent's standing objectives — its durable current purpose, framed as standing
  // context on every run. Only the `active` AND `accepted` ones (the framing set); a
  // reflection-PROPOSED objective is inert until a human accepts it. A scoped read in the
  // same place skills are resolved, no new seam. Not recall-ranked or budget-bounded —
  // objectives are few and all-relevant by definition.
  const objectives = store.objectives.listActiveAccepted(agent.id);
  // The agent's working notes — its own running record of the current situation, framed
  // as standing context on every run (a scoped read in the same place objectives/skills
  // are resolved, no new seam). Only the `accepted` ones (the framing set); a derived,
  // reflection-style PROPOSED note (#84 T3) is inert until a human accepts it, exactly as a
  // proposed objective is. Framed LAST and clearly labelled as unverified, so a self-written
  // note is never mistaken for a ratified memory.
  const worldFacts = store.worldFacts.listAccepted(agent.id);
  // Everything that can fail while turning the agent's identity + task into an
  // executed outcome — recall, framing, and the substrate run — sits INSIDE one
  // guard, so a throw anywhere drives the run to a terminal state instead of
  // stranding it `running`. The run is already persisted `running` above; an
  // unguarded throw here would surface as an opaque rejection with the row stuck
  // mid-flight (over HTTP, a 500 with no terminal status). So `run(request)` AND the
  // recall/framing before it stay inside the guard, not just the `await`.
  //
  // Recall in particular can fail for a real reason: an injected provider (a later
  // embeddings / vector backend) may be unavailable, or reject. That is a failed run,
  // exactly like a substrate failure — caught here and finished `failed`, never left
  // `running`. The default lexical provider never rejects, so this changes nothing
  // for the default path; it makes the seam safe for the providers it exists to admit.
  //
  // `streamed` is the event-drain promise: starts as a resolved no-op so the catch
  // can flush it unconditionally even when the throw happened before any handle —
  // including before recall returned, when nothing was ever streamed — and is
  // reassigned the moment we have a handle. Forwarding is kicked off NOW (not awaited
  // yet) so activity streams while the run is in flight; it is flushed (NOT blindly
  // awaited — see `flushEvents`) at each exit below so the stream is drained before
  // the surface formats its result without a non-closing stream being able to hang
  // the run. The kernel is the single consumer and only forwards — it never acts.
  let output: RunOutput;
  let streamed: Promise<void> = Promise.resolve();
  try {
    // Structured recall: rank the agent's accepted memories against this task and
    // frame at most a budget's worth, instead of inlining all of them. The kernel
    // resolves the candidates (the agent's OWN active+accepted memories) and hands
    // them to the provider, which only ranks within that set. Under budget the
    // selection is the full set unchanged, so framing is identical to before.
    //
    // The provider is injectable and untrusted, so the kernel never shares a mutable
    // object with it that it later trusts — it keeps the boundary on its own side,
    // three ways:
    //   1. It hands the provider per-object CLONES of the candidates and keeps this
    //      pristine `candidates` array for itself. A provider that mutates its input
    //      in place (tampering with a real memory's content) only touches its own
    //      copies — the objects the kernel frames are ones the provider never held a
    //      reference to. (Memory is a flat record of primitives, so a spread is a full
    //      clone.)
    //   2. It snapshots the budget to a primitive BEFORE calling the provider and gives
    //      the provider (and enforceRecall) their own fresh budget objects — never the
    //      caller's, which may be the shared DEFAULT_RECALL_BUDGET. A provider that
    //      mutates `input.budget` cannot raise the cap or poison the default.
    //   3. `enforceRecall` re-imposes the guarantees on the provider's OUTPUT against
    //      the pristine candidates: every framed memory must be one the kernel resolved
    //      (no other agent's row, no fabricated one), framed from the kernel's own
    //      object, deduped, and truncated to the budget.
    const recall = options.recall ?? defaultRecallProvider;
    const candidates = store.memories.listActiveAccepted(agent.id);
    // The effective budget: an explicit host override, else the agent's own resolved
    // setting (per-agent value → kernel default). Snapshotted to a primitive here, so
    // the provider never receives the shared DEFAULT_RECALL_BUDGET object to mutate.
    const maxMemories = (options.recallBudget ?? resolveRecallBudget(store, agent)).maxMemories;
    const selected = await recall.recall({
      agentId: agent.id,
      query: input,
      candidates: candidates.map((memory) => ({ ...memory })),
      budget: { maxMemories },
      now: run.startedAt,
    });
    const memories = enforceRecall(selected, candidates, { maxMemories });
    const request = frameRun({
      agent,
      ...(soulText !== undefined ? { soulText } : {}),
      skills,
      memories,
      objectives,
      worldFacts,
      input,
      tools,
      signal: abortController.signal,
    });

    const handle = options.adapter.run(request);
    streamed = drainEvents(handle.events, options.onEvent);
    output = await handle.output;
  } catch (err) {
    await flushEvents(streamed);
    // A gate pause aborts the run via the signal, which some adapters surface as a
    // rejection. If the gate paused it, preserve `awaiting_confirmation` rather
    // than masking it as a failure; otherwise the substrate genuinely failed.
    const paused = store.runs.get(agent.id, run.id);
    if (paused?.status === "awaiting_confirmation") {
      // Pause exit — harvest what ran BEFORE the pause (its observations exist only in this
      // invocation's `collected`; a later resume that skips the already-performed action
      // would never re-observe it). Idempotent per subject on the eventual resume.
      const harvest = harvestWorkingNotes();
      const artifacts = collectArtifacts();
      return {
        run: paused,
        status: "awaiting_confirmation",
        output: "",
        actions: collectActions(),
        ...(harvest ? { harvest } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    }
    const failed = store.finishRun(agent.id, run.id, "", "failed");
    revokeFailedGrants();
    // Harvest the state-changing observations the run produced before it failed (a write
    // that landed is a true current-state fact worth proposing, even on a failed run).
    const harvest = harvestWorkingNotes();
    const artifacts = collectArtifacts();
    return {
      run: failed ?? run,
      status: "failed",
      output: "",
      error: err instanceof Error ? err.message : String(err),
      actions: collectActions(),
      ...(harvest ? { harvest } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }
  await flushEvents(streamed);

  // If a destructive action paused the run, the gate already flipped it to
  // awaiting_confirmation — leave it there rather than forcing a terminal state,
  // but still persist whatever it produced so a paused run is reflectable.
  const current = store.runs.get(agent.id, run.id);
  if (current?.status === "awaiting_confirmation") {
    const persisted =
      output.text.length > 0
        ? store.recordRunOutput(agent.id, run.id, output.text)
        : current;
    // Pause exit — harvest what ran before the pause (see the catch-pause exit above).
    const harvest = harvestWorkingNotes();
    const artifacts = collectArtifacts();
    return {
      run: persisted ?? current,
      status: "awaiting_confirmation",
      output: output.text,
      actions: collectActions(),
      ...(harvest ? { harvest } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }

  // Persist output and the terminal status atomically (and audited): the two can
  // never drift, and a crash between them cannot leave output without a status.
  //
  // Store contract: the scoped writes/reads here (`finishRun`, `recordRunOutput`,
  // `runs.get`) return `Run | undefined` — `undefined` ONLY for a cross-agent or
  // unknown run, which the run created at the top of this function can never be.
  // So the `?? current ?? run` fallbacks below (and at the paused/failed returns
  // above) are the type-required guard for that contract, not dead defensiveness;
  // do not "simplify" them away.
  const status: RunStatus = output.status === "done" ? "done" : "failed";
  const finished = store.finishRun(agent.id, run.id, output.text, status);
  if (status === "failed") revokeFailedGrants();
  // Terminal exit — harvest the run's state-changing observations into proposed working
  // notes (#84 T3) for the operator to review. Both `done` and `failed` harvest (a write
  // that landed is a true current-state fact either way); the pause exits above harvest too,
  // so an intermediate confirmed action's change is never lost (idempotent per subject).
  const harvest = harvestWorkingNotes();
  const artifacts = collectArtifacts();
  return {
    run: finished ?? current ?? run,
    status,
    output: output.text,
    ...(output.error !== undefined ? { error: output.error } : {}),
    actions: collectActions(),
    ...(harvest ? { harvest } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

// A decision keys an action by capability AND a fingerprint of its arguments,
// joined by a NUL (which a capability key can never contain), so it is tied to a
// specific invocation rather than a whole capability. The fingerprint comes from the
// run's events (recorded by `audit.ts`) when reconstructing prior state, and is
// recomputed from the live action on the gate side; the two agree because both use
// {@link actionFingerprint}.
const APPROVAL_KEY_SEP = "\u0000";
function approvalKey(capability: string, fingerprint: string): string {
  return `${capability}${APPROVAL_KEY_SEP}${fingerprint}`;
}
/** A destructive invocation — a reference: capability + a one-way fingerprint of its args. */
interface ActionRef {
  capability: string;
  fingerprint: string;
}

/** One invocation a confirm has approved, with how many of it (multiplicity) — recorded on `run.resumed`. */
export interface GrantedAction extends ActionRef {
  count: number;
}

/**
 * The reconstructed resume state a confirm produces — enough for the gate to decide
 * each destructive invocation on the replay, and the record the next confirm reads.
 */
interface ResumeApproval {
  /** Per invocation (cap+fingerprint key) → how many times it has ALREADY executed (prior cycles). */
  executedCount: Map<string, number>;
  /** Per invocation → how many of it a human has confirmed (cumulative, incl. this confirm). */
  confirmedCount: Map<string, number>;
  /** `confirmedCount` as references, recorded on `run.resumed` so the next confirm reads prior confirmations. */
  granted: GrantedAction[];
}

/** Pull a `{capability, fingerprint}` pair out of an event payload, if both are present. */
function actionRef(payload: unknown): ActionRef | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const cap = (payload as { capability?: unknown }).capability;
  const fingerprint = (payload as { fingerprint?: unknown }).fingerprint;
  if (typeof cap !== "string" || typeof fingerprint !== "string") return undefined;
  return { capability: cap, fingerprint };
}

/**
 * Reconstruct what a single confirm authorizes for a run, from its own event log
 * (scoped to the agent AND run; references only — capability keys and one-way
 * argument fingerprints, never the args). Two counts per invocation drive the gate:
 *
 *   - `executedCount` — how many times this exact invocation has already executed
 *     (counted from `action.executed` events). Re-running the loop replays these, so
 *     the gate SKIPS the first `executedCount` occurrences rather than repeating a
 *     confirmed destructive action.
 *   - `confirmedCount` — how many a human has confirmed (carried across confirms via
 *     `run.resumed`), grown by ONE for the next paused invocation each confirm.
 *
 * On the replay the gate runs occurrences in `(executedCount, confirmedCount]` and
 * pauses the rest. So a multi-step run is cleared one action per confirm, a confirmed
 * action never re-executes, and two identical paused invocations each get their own
 * confirm — without a single "yes" ever approving more than one new action.
 */
function resumeApproval(
  store: AsterismStore,
  agentId: string,
  runId: string,
): ResumeApproval {
  const events = store.events.listForRun(agentId, runId);
  const executedCount = new Map<string, number>();
  const confirmedCount = new Map<string, number>();
  const refByKey = new Map<string, ActionRef>();
  let lastResumedIdx = -1;
  events.forEach((e, i) => {
    if (e.type === "run.resumed") lastResumedIdx = i;
  });
  for (const event of events) {
    if (event.type === "action.executed") {
      const ref = actionRef(event.payload);
      if (!ref) continue;
      const key = approvalKey(ref.capability, ref.fingerprint);
      executedCount.set(key, (executedCount.get(key) ?? 0) + 1);
      refByKey.set(key, ref);
    } else if (event.type === "run.resumed") {
      const granted = (event.payload as { granted?: unknown } | null)?.granted;
      if (Array.isArray(granted)) {
        for (const g of granted) {
          const ref = actionRef(g);
          const count = (g as { count?: unknown } | null)?.count;
          if (!ref || typeof count !== "number") continue;
          const key = approvalKey(ref.capability, ref.fingerprint);
          // Confirmations only grow per invocation, so the max across confirms wins.
          confirmedCount.set(key, Math.max(confirmedCount.get(key) ?? 0, count));
          refByKey.set(key, ref);
        }
      }
    } else if (event.type === "action.awaiting_confirmation") {
      const ref = actionRef(event.payload);
      if (ref) refByKey.set(approvalKey(ref.capability, ref.fingerprint), ref);
    }
  }

  // Confirm the FIRST invocation that paused in the latest cycle (after the last
  // `run.resumed`) — that pause is the run's next un-confirmed occurrence. Granting
  // exactly one keeps a single confirm bounded to one new action, even when several
  // paused at once.
  for (let i = lastResumedIdx + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== "action.awaiting_confirmation") continue;
    const ref = actionRef(event.payload);
    if (!ref) continue;
    const key = approvalKey(ref.capability, ref.fingerprint);
    confirmedCount.set(key, (confirmedCount.get(key) ?? 0) + 1);
    break;
  }

  const granted: GrantedAction[] = [];
  for (const [key, count] of confirmedCount) {
    const ref = refByKey.get(key);
    if (ref && count > 0) granted.push({ ...ref, count });
  }
  return { executedCount, confirmedCount, granted };
}

/**
 * The outcome of {@link resumeRun}. A discriminated union so a surface can map each
 * case to its own response (CLI exit code, HTTP status) without guessing:
 * - `resumed`    — the run was parked, was re-entered, and reached a terminal (or
 *                  re-paused) state; `result` is the same shape `executeRun` returns.
 * - `not_found`  — no such run for this agent (unknown id, or another agent's run —
 *                  the lookup is scoped, so a foreign run is indistinguishable from
 *                  a missing one, which is the point).
 * - `not_paused` — the run exists but is not `awaiting_confirmation`, so there is
 *                  nothing to confirm; `run` carries its actual current state.
 */
export type ResumeOutcome =
  | { kind: "resumed"; result: ExecuteRunResult }
  | { kind: "not_found" }
  | { kind: "not_paused"; run: Run };

/**
 * Resume a run that paused at `awaiting_confirmation`, after an explicit
 * out-of-band confirmation (CLI `asterism confirm`, the HTTP confirm endpoint, or
 * a future chat reply). This is how a gate pause is cleared from a surface where
 * no one was at the keyboard when the run first stopped.
 *
 * The substrate holds no resumable loop state, so resuming RE-ENTERS the loop on the
 * same run row: the kernel re-frames the agent's original task and re-runs it, this
 * time letting through exactly the destructive invocation a human confirmed (see
 * {@link resumeApproval}). The agent re-derives the action with full context.
 *
 * The gate is not weakened, and re-execution is made safe per invocation (keyed by a
 * fingerprint of the args): a confirmed action runs at most once — on a later confirm
 * the replay SKIPS it rather than repeating it (no double payment or double delete) —
 * and a destructive invocation the human has not confirmed still pauses, whether a
 * new capability, the same capability aimed at a new target, or one more identical
 * call. Classification is unchanged. Each confirm records what it granted on the
 * event log via `run.resumed` before re-running, so the audit names what a human
 * authorized and the next confirm can read it back.
 *
 * One honest cost remains: a parked run's NON-destructive side effects (ordinary
 * writes done before the gate stopped it) DO run again on resume — only destructive
 * actions are tracked and skipped.
 */
export async function resumeRun(
  store: AsterismStore,
  agent: Agent,
  runId: string,
  options: ExecuteRunOptions,
): Promise<ResumeOutcome> {
  // CLAIM first — a single compare-and-set (awaiting_confirmation → running) that
  // serializes confirms: exactly one wins, the loser is declined below. Claiming
  // BEFORE reconstructing the approval is what keeps the counts fresh. A prior
  // confirm that resumed and re-paused must commit its execution events before it
  // releases the run (back to `awaiting_confirmation`) for us to claim it — so by
  // the time we own the run and read its events, every earlier execution is visible
  // and gets skipped, never re-run. Reconstructing first and claiming after would
  // let a confirm act on counts taken before a concurrent confirm's executions
  // landed, and re-run an already-executed destructive action.
  const claimed = store.claimRunForResume(agent.id, runId);
  if (!claimed) {
    const current = store.runs.get(agent.id, runId);
    return current ? { kind: "not_paused", run: current } : { kind: "not_found" };
  }

  // Now under exclusive ownership, reconstruct what this confirm authorizes: which
  // invocations have already executed (skip them on replay) and which are confirmed
  // (run up to that, including ONE new paused action), each bound to its exact
  // invocation by a fingerprint. A run paused on several actions at once is thus
  // cleared one confirm at a time, and a confirmed action is never re-executed.
  const { executedCount, confirmedCount, granted } = resumeApproval(store, agent.id, runId);
  const confirmed = [...new Set(granted.map((g) => g.capability))];
  // Record the grant (`run.resumed`): the human-readable capabilities, plus the
  // per-invocation references the NEXT confirm reads back to know what is already
  // confirmed. We already own the run, so this just appends the audit record.
  store.recordRunResumed(agent.id, runId, confirmed, granted);

  const result = await runAndPersist(store, agent, claimed, claimed.input, options, {
    executedCount,
    confirmedCount,
  });
  return { kind: "resumed", result };
}

/**
 * The outcome of {@link declineRun}, parallel to {@link ResumeOutcome}:
 * - `declined`   — the run was parked and has been refused, ending `failed`; the
 *                  destructive action it stopped on never ran.
 * - `not_found`  — no such run for this agent (scoped lookup, so a foreign run is
 *                  indistinguishable from a missing one).
 * - `not_paused` — the run exists but is not `awaiting_confirmation` (already
 *                  terminal, or a concurrent confirm claimed it first); `run`
 *                  carries its actual current state.
 */
export type DeclineOutcome =
  | { kind: "declined"; run: Run }
  | { kind: "not_found" }
  | { kind: "not_paused"; run: Run };

/**
 * Decline a run that paused at `awaiting_confirmation` — the operator refused the
 * destructive action, so the run ends `failed` and the action never executes. The
 * counterpart to {@link resumeRun}, and deliberately the same shape.
 *
 * The store does an atomic compare-and-set straight to `failed` (it never goes
 * through `running`), so a decline and a confirm race safely over one parked run —
 * exactly one wins — and the run's `output` is PRESERVED (a transcript produced
 * before the gate paused it survives, unlike on a resume, which re-runs from the
 * start and clears it). A miss means the run is unknown/foreign or no longer awaiting
 * confirmation (already terminal, or a concurrent confirm claimed it first): you
 * cannot decline a run that is already being resumed. No adapter is needed — nothing
 * re-enters the loop.
 */
export function declineRun(store: AsterismStore, agent: Agent, runId: string): DeclineOutcome {
  const declined = store.declineRun(agent.id, runId);
  if (declined) return { kind: "declined", run: declined };
  const current = store.runs.get(agent.id, runId);
  return current ? { kind: "not_paused", run: current } : { kind: "not_found" };
}

/**
 * The outcome of {@link performHandoff} — a discriminated union so a surface maps each
 * case to its own response without guessing:
 * - `ok`            — an active connection authorized the handoff and the callee ran; the
 *                     `result` is the SAME shape {@link executeRun} returns, carrying only
 *                     the callee's final output and references (never its memory/secrets).
 * - `no_connection` — there is no ACTIVE `from → to` connection in `handoff` mode, so the
 *                     handoff is refused: default isolation holds (golden rule 5,
 *                     invariant 1). The caller's only recourse is to have the operator
 *                     create the connection (`asterism connect from to --mode handoff`).
 */
export type HandoffOutcome =
  | { kind: "ok"; result: ExecuteRunResult }
  | { kind: "no_connection" };

/**
 * What an `artifact-only` exchange returns to the caller (Phase 3 · T2a) — REFERENCES ONLY.
 *
 * Deliberately NOT an {@link ExecuteRunResult}, and deliberately not a superset of one. The
 * mode's whole contract is that the callee's words do not cross, so this type is the
 * boundary that enforces it: there is no field that can carry the callee's text, which
 * makes invariant 2 a property of the TYPE rather than of a caller remembering not to read
 * `output`.
 *
 * Three exclusions are load-bearing:
 *   - **No `output`.** The callee's final text is the thing this mode withholds.
 *   - **No `run` row.** {@link Run} carries `output` (the run's final text, persisted so a
 *     later reflect has a transcript). Handing back the row would leak the callee's text
 *     through the back door, so only the run ID crosses — a reference the caller can quote
 *     in an audit but cannot read the callee's run through (every read is `agentId`-scoped).
 *   - **No `error`.** A substrate error message is free-form callee-side text. The caller
 *     learns `failed` from `status`; the operator reads the detail from the CALLEE's own
 *     surfaces, where it never crossed an agent boundary to begin with.
 *
 * `actions` DOES cross: it is references-only (capability key + classified effect +
 * decision) and is how an operator understands a short manifest — "the run paused before
 * the delete" — without seeing anything the callee said. The callee's working-note harvest
 * does not cross: it describes the callee's own review pile and is no business of the
 * caller's.
 */
export interface ArtifactExchangeResult {
  /** The callee's run id — a reference for audit, not a handle to read the run through. */
  runId: string;
  /** How the callee's run ended: `done` / `failed` / `awaiting_confirmation`. */
  status: RunStatus;
  /** The callee's gate decisions, in order — references only (capability + effect). */
  actions: readonly ActionRecord[];
  /** The workspace artifacts the callee produced — paths and sizes, never contents. */
  artifacts: readonly ArtifactRef[];
}

/**
 * The outcome of {@link performArtifactExchange} — the same discriminated shape as
 * {@link HandoffOutcome}, so a surface maps each case without guessing. `no_connection`
 * means there is no ACTIVE `from → to` connection **in `artifact-only` mode**: a
 * `handoff`-mode connection between the same pair does NOT authorize this exchange, because
 * a connection grants exactly its mode's form and nothing wider.
 */
export type ArtifactExchangeOutcome =
  | { kind: "ok"; result: ArtifactExchangeResult }
  | { kind: "no_connection" };

/**
 * Perform an OPERATOR-DIRECTED handoff: `from` asks `to` to do `input`, over an explicit,
 * permissioned connection. This is Phase 3's first cross-agent operation, and it preserves
 * every golden-rule-5 invariant by construction rather than by a special code path:
 *
 *   1. **No connection → no interaction.** The active `from → to` connection in `handoff`
 *      mode IS the permission. With none, this returns `no_connection` and nothing runs —
 *      the default-isolation refusal. (Using an existing connection is logged, not
 *      re-gated: the human-created connection is the permission, settled decision D3.)
 *   2/3. **The callee's gate is sovereign; only the mode's artifact crosses.** A handoff is
 *      just an {@link executeRun} on the CALLEE (`to`): the run is recorded as `to`'s, in
 *      `to`'s workspace, under `to`'s trust profile and scoped tools, framed by `to`'s own
 *      memory/objectives/notes. `to`'s destructive-action gate fires identically whether
 *      `to` is run directly or via a handoff — a handoff can neither raise nor lower it.
 *      The caller receives back only the callee's {@link ExecuteRunResult} (its final
 *      output text + references); `to`'s memory rows, transcript, and secrets never cross.
 *      Critically, the CALLER passes the CALLEE's host concerns in `options` (the callee's
 *      adapter, the callee's workspace capabilities, the callee's recall) — the run is the
 *      callee's in every dimension.
 *   5. **Initiating is audited.** `handoff.requested` is recorded on BOTH logs before the
 *      run and `handoff.completed` after, content-free references both (the connection id,
 *      agent ids, the callee's run id, the final status) — never the task input or the
 *      callee's output.
 *
 * `from` and `to` are the resolved agents; the caller (a surface) has already looked them
 * up and built `options` from `to`. This entry point is the `handoff` mode specifically;
 * {@link performArtifactExchange} is the stricter `artifact-only` form over the same shared
 * {@link performExchange}, and the remaining modes are later threads.
 */
export async function performHandoff(
  store: AsterismStore,
  from: Agent,
  to: Agent,
  input: string,
  options: ExecuteRunOptions,
): Promise<HandoffOutcome> {
  const exchanged = await performExchange(store, from, to, input, "handoff", options);
  if (exchanged === undefined) return { kind: "no_connection" };
  // `handoff` is the least-curated mode: the callee's full ExecuteRunResult crosses (its
  // final text + references), and nothing behind it (settled decision D2). Nothing is
  // recorded in `exchanges`: what crossed is the callee's TEXT, which is not a durable
  // reference and which nothing resolves later — the both-logs `handoff.*` audit is the
  // whole record. Only a mode whose crossing can be DEREFERENCED needs a row.
  return { kind: "ok", result: exchanged.result };
}

/**
 * Perform an OPERATOR-DIRECTED `artifact-only` exchange: `from` asks `to` to do `input`,
 * and receives back only the REFERENCES-ONLY manifest of the workspace artifacts `to`
 * produced — never `to`'s words, memory, secrets, or the file bytes (Phase 3 · T2a; design
 * note §9, decision D8).
 *
 * Mechanically this is {@link performHandoff} with a different connection mode and a
 * different projection: the callee still drives the entire run, so invariants 1, 3, 4 and 5
 * hold for exactly the reasons documented there — they are properties of running the task
 * AS the callee, not of this mode. What differs is invariant 2, and it is enforced HERE, at
 * the kernel boundary, by returning a type that has nowhere to put the callee's text
 * ({@link ArtifactExchangeResult}).
 *
 * Enforcing it at the boundary rather than in the CLI is the point: a surface-level filter
 * would leave the callee's text one field access away for the next caller (the HTTP console,
 * a channel, or the agent-initiated delegation of T5). The kernel owns what crosses.
 */
export async function performArtifactExchange(
  store: AsterismStore,
  from: Agent,
  to: Agent,
  input: string,
  options: ExecuteRunOptions,
): Promise<ArtifactExchangeOutcome> {
  const exchanged = await performExchange(store, from, to, input, "artifact-only", options);
  if (exchanged === undefined) return { kind: "no_connection" };
  const { connection, result } = exchanged;
  // Absent when the run produced nothing; an empty manifest is the honest answer for a run
  // that acted on nothing (or whose every action the callee's gate withheld).
  const artifacts = result.artifacts ?? [];
  // Persist the manifest as resolvable references, so the caller can later DEREFERENCE what
  // it was told about (`artifact fetch`) instead of being handed a list it has no way to
  // act on. Recorded at EVERY outcome for the same reason the CLI renders the manifest at
  // every outcome: a file written before a later failure or a pause genuinely exists, and a
  // reference that crossed but was never recorded would be un-fetchable for no honest
  // reason. Recording does not move a byte — it only makes an already-crossed reference
  // resolvable, and every byte still waits on the caller's own gate.
  store.recordArtifactExchange(connection, result.run.id, artifacts);
  return {
    kind: "ok",
    result: {
      // The run ID only — never the Run row, which carries the callee's output text.
      runId: result.run.id,
      status: result.status,
      actions: result.actions,
      artifacts,
    },
  };
}

// --- artifact fetch --------------------------------------------------------
//
// Materializing an artifact the callee produced INTO the caller's workspace — the deferred
// half of decision D8 and the completion of the `artifact-only` mode. This is the one
// operation in Phase 3 where file BYTES cross an agent boundary, so it is also the one that
// carries the most enforcement. Three properties are load-bearing, and each is enforced in a
// different place on purpose:
//
//   1. THE CALLER NEVER SUPPLIES A PATH. What a surface passes in is a REFERENCE, matched
//      exactly against the `exchanges` rows for this connection. The path that reaches the
//      filesystem is the one the KERNEL recorded when the manifest crossed. There is no code
//      path in which a caller-chosen string becomes a path, which is what keeps `fetch` from
//      being a cross-agent file-read primitive. Its consequence is worth stating positively:
//      a fetch reveals nothing the caller did not already learn from the manifest it was
//      handed — a reference that never crossed misses exactly as an unknown one does.
//   2. THE BYTES ARE READ KERNEL-SIDE. The caller's tool registry gains nothing: the fetch
//      capability below is built here, gated here, and handed to no adapter, ever. No agent
//      is ever offered a tool that can see out of its own workspace.
//   3. THE CALLER'S OWN GATE DECIDES. The write lands in the CALLER's workspace, so it is
//      the caller's trust profile and the caller's destructive-action gate that govern it —
//      never the callee's, and never the connection's existence alone (golden rule 4).

/** The capability key the caller's gate governs a fetch by. */
export const EXCHANGE_FETCH_KEY = "exchange.fetch";

/**
 * What a host must do for a fetch that the kernel cannot: touch the filesystem. `core` owns
 * no `node:fs` (the same rule that makes `executeRun` take an injected `readFile`), so the
 * kernel decides WHETHER a byte may move and the host performs the move.
 *
 * The host's obligation is confinement in both directions, and it is not optional: `read`
 * must refuse a source that resolves outside the CALLEE's workspace, and `write` a
 * destination that resolves outside the CALLER's — including through a symlink, which a
 * lexical check cannot see. The host that ships with Asterism satisfies this by reusing the
 * very same guards its workspace file tools use, rather than writing fresh path logic.
 */
export interface ArtifactFetchHost {
  /**
   * Look at the source and destination WITHOUT writing anything: the source's size, and
   * whether the destination already holds a file. Called after authorization and before the
   * gate, so a fetch that cannot succeed fails before a human is asked to approve it, and so
   * the confirmation can say plainly whether it overwrites.
   *
   * `destExists` informs the PROMPT, never the classification — a fetch is destructive
   * either way (design note §11, decision D12). That is what makes the gap between this call
   * and {@link materialize} harmless: a destination that appears in between changes the
   * wording of a question already answered, not whether the question was asked.
   */
  inspect(request: ArtifactFetchRequest): ArtifactInspection;
  /**
   * Copy the source's bytes to the destination, creating parent folders as needed and
   * replacing an existing file. Only ever called once the caller's gate has authorized it.
   */
  materialize(request: ArtifactFetchRequest): ArtifactMaterialization;
}

/**
 * One fetch, in host terms: copy `path` from the callee's workspace into the caller's, at
 * the SAME workspace-relative location. `path` comes from a recorded reference, never from a
 * surface's argument.
 */
export interface ArtifactFetchRequest {
  /** The callee's workspace — where the bytes are read from. */
  sourceWorkspaceDir: string;
  /** The caller's workspace — where the bytes land. */
  destWorkspaceDir: string;
  /** The recorded, workspace-relative path, identical on both sides. */
  path: string;
}

/** The result of {@link ArtifactFetchHost.inspect} — sizes and presence, never contents. */
export type ArtifactInspection =
  | { ok: true; sizeBytes: number; destExists: boolean }
  | { ok: false; reason: string };

/** The result of {@link ArtifactFetchHost.materialize} — how many bytes landed. */
export type ArtifactMaterialization = { ok: true; bytes: number } | { ok: false; reason: string };

/** Host concerns a fetch needs. Both are the caller's; the kernel supplies everything else. */
export interface ArtifactFetchOptions {
  /** The filesystem side of the operation (see {@link ArtifactFetchHost}). */
  host: ArtifactFetchHost;
  /**
   * Resolve the caller's destructive-action confirmation. Absent ⇒ nothing is fetched and
   * the outcome is `not_confirmed` — the same safe default every other destructive action
   * has for a non-interactive caller. Asterism never moves bytes across an agent boundary on
   * an agent's behalf.
   */
  confirm?: (action: Action) => boolean | Promise<boolean>;
}

/** What a successful fetch did — references and counts only. */
export interface ArtifactFetchResult {
  /** The reference that was resolved, exactly as it was recorded. */
  ref: string;
  /** The workspace-relative path the bytes landed at, in the CALLER's workspace. */
  path: string;
  /** How many bytes were written. */
  bytes: number;
  /** Whether the write replaced a file the caller already had there. */
  overwrote: boolean;
}

/**
 * The outcome of {@link performArtifactFetch} — a discriminated union so a surface maps each
 * case to its own message without guessing, and so a refusal is never mistaken for a
 * failure:
 *
 * - `ok`            — the caller's gate authorized it and the bytes landed.
 * - `no_connection` — no ACTIVE `from → to` connection in `artifact-only` mode (invariant 1).
 * - `not_exchanged` — the reference never crossed this connection, so there is nothing to
 *                     dereference (invariant 2 — the sharp one).
 * - `unavailable`   — authorized, but the artifact cannot be materialized: recorded as
 *                     deleted, a directory, since removed, or unreadable. `reason` is
 *                     host-supplied and path-free.
 * - `withheld`      — the caller's trust level is `propose`, so the side effect was not
 *                     performed; the fetch is reported as a plan step instead.
 * - `not_confirmed` — the destructive gate fired and no human approved it. Nothing was
 *                     written, and nothing is parked: re-run the fetch to be asked again.
 */
export type ArtifactFetchOutcome =
  | { kind: "ok"; result: ArtifactFetchResult }
  | { kind: "no_connection" }
  | { kind: "not_exchanged" }
  | { kind: "unavailable"; reason: string }
  | { kind: "withheld"; ref: string; path: string; sizeBytes: number }
  | { kind: "not_confirmed"; ref: string; path: string; sizeBytes: number };

/**
 * Materialize an artifact the callee produced into the CALLER's workspace, under the
 * caller's own destructive-action gate.
 *
 * The order of the four steps is itself the design, and each step is a refusal point:
 *
 *   1. **The connection.** An ACTIVE `from → to` connection in `artifact-only` mode is the
 *      permission, re-checked here at fetch time rather than inherited from the exchange
 *      that produced the artifact. So revoking a channel stops future fetches over it, and
 *      a caller cannot dereference a manifest it received through a channel it has lost.
 *   2. **The record.** The reference must resolve to something the callee actually produced
 *      over THIS connection — and to something that still existed when the exchange ended
 *      (`present`). Only a `file:` reference can be fetched; a directory is a tree, not an
 *      artifact, and is out of scope by design rather than by omission.
 *   3. **The gate.** The caller's trust profile decides, through the SAME
 *      `resolveToolRegistry` chokepoint every capability passes through — classification,
 *      decision, confirmation, and audit are the kernel's one implementation, not a second
 *      one written for this op. A fetch is declared `destructive` unconditionally (D12), so
 *      it confirms at `notify` and `autonomous` alike and is withheld under `propose`.
 *   4. **The move.** Only now does the host copy bytes, and only then is `artifact.fetched`
 *      recorded on both logs.
 *
 * Deliberately NOT a run. There is no model call, no framing, and nothing to resume — a
 * `Run` row would claim the caller "ran" when it did not, and would drag in the
 * at-most-once replay accounting that exists for actions a re-entered agent loop repeats. A
 * declined fetch simply does not happen; the operator runs the command again. That is also
 * why the gate audit here carries no run id and no argument fingerprint: a fingerprint
 * exists to bind an out-of-band confirmation to one invocation of a *parked run*, and
 * nothing is parked.
 *
 * The caller's standing grants are deliberately NOT consulted (D15): `autoApprove` is empty,
 * so no earned or configured grant can make a byte cross without a human. Earned standing is
 * built from a track record of in-run executions under the agent's own gate, and this is not
 * that — it is the one payload D8 exists to keep from moving on its own. Stricter than
 * golden rule 4 requires, never looser.
 *
 * Two independent things hold that line, which is worth naming because either alone would be
 * enough and neither is a coincidence. (a) The empty `autoApprove` above: even a grant
 * written straight into the store leaves this gate untouched. (b) `exchange.fetch` cannot
 * BECOME a grant candidate in the first place — standing evidence is read from gate events
 * that carry a `runId` (`standing.ts` skips the rest), and a fetch has no run, so its
 * executions never enter an earning window and `trust --review` can never propose it. So the
 * confusing state "the operator granted it and it still asks" is not merely refused, it is
 * unreachable.
 */
export async function performArtifactFetch(
  store: AsterismStore,
  from: Agent,
  to: Agent,
  ref: string,
  options: ArtifactFetchOptions,
): Promise<ArtifactFetchOutcome> {
  // 1. The connection is the permission — the same directional, mode-specific read every
  //    exchange makes, at the moment the bytes would move rather than when they were made.
  const connection = store.connections.findActive(from.id, to.id, "artifact-only");
  if (!connection) return { kind: "no_connection" };

  // 2. The reference must be one that actually crossed this connection. This is the check
  //    that keeps `fetch` from being a cross-agent read: the path used below comes from the
  //    RECORD, and the surface's argument only ever selected which record.
  const exchanged = store.findExchangedArtifact(connection, ref);
  if (!exchanged) return { kind: "not_exchanged" };
  if (!exchanged.present) {
    return { kind: "unavailable", reason: `'${ref}' was deleted by ${to.name} in that exchange.` };
  }
  const parsed = parseArtifactReference(exchanged.ref);
  if (!parsed) return { kind: "unavailable", reason: `'${ref}' is not a fetchable reference.` };
  if (parsed.kind !== "file") {
    return {
      kind: "unavailable",
      reason: `'${parsed.path}' is a folder — fetch materializes single files.`,
    };
  }
  const request: ArtifactFetchRequest = {
    sourceWorkspaceDir: to.workspaceDir,
    destWorkspaceDir: from.workspaceDir,
    path: parsed.path,
  };

  // Look before asking: an artifact the callee has since deleted, or one the host refuses to
  // read, is reported as unavailable instead of prompting a human to approve a write that
  // cannot happen. Read-only, and reached only after both authorization checks passed.
  const inspection = options.host.inspect(request);
  if (!inspection.ok) return { kind: "unavailable", reason: inspection.reason };
  const { sizeBytes, destExists } = inspection;

  // 3. The caller's gate. Exposure is exactly this one capability, and `autoApprove` is
  //    EMPTY by decision (see the doc comment) — so `decideGate` withholds under `propose`
  //    and confirms at every other level, with no grant able to skip it.
  const profile = trustProfile({ level: from.trustLevel, capabilities: [EXCHANGE_FETCH_KEY] });
  let decision: "executed" | "withheld" | "paused" | undefined;
  let materialized: ArtifactMaterialization | undefined;
  const capability: Capability = {
    key: EXCHANGE_FETCH_KEY,
    // Declared destructive, unconditionally. Not "destructive when the destination exists":
    // that would make the classification depend on a filesystem state that can change
    // between the check and the write, and would let the byte-crossing this whole mode is
    // built around happen silently in the common case. The overwrite risk changes what the
    // human is TOLD, never whether they are asked. (Design note §11, decision D12.)
    effect: "destructive",
    tool: {
      // Never handed to an adapter — this registry is built, consumed, and discarded inside
      // this function, so the name and schema exist only to satisfy the shared shape. No
      // agent is ever offered a tool that reaches outside its own workspace.
      name: "fetch_artifact",
      description: "Kernel-internal: materialize an exchanged artifact into the caller's workspace.",
      inputSchema: { type: "object", properties: {} },
      execute: (): Promise<ToolResult> => {
        materialized = options.host.materialize(request);
        return Promise.resolve(
          materialized.ok
            ? { output: `Fetched ${materialized.bytes} bytes.`, isError: false }
            : { output: materialized.reason, isError: true },
        );
      },
    },
  };
  const baseHooks: TrustHooks = {
    onExecute: () => {
      decision = "executed";
    },
    onWithhold: () => {
      decision = "withheld";
    },
    onAwaitConfirmation: () => {
      decision = "paused";
    },
    ...(options.confirm ? { confirm: options.confirm } : {}),
  };
  // Audited to the CALLER's log — the gate decision is the caller's own policy, so it
  // belongs on the caller's log whichever way it goes. Nothing is emitted to the callee's
  // log unless bytes actually cross (`artifact.fetched`, below): a withheld or unconfirmed
  // fetch touched the callee not at all.
  const tools = resolveToolRegistry(
    profile,
    [capability],
    auditTrustHooks(store.events, from.id, {}, baseHooks),
  );
  const gated = tools.list()[0];
  // The exposure filter cannot drop a capability whose key this function just put in the
  // profile, so this is the type-required guard for `list()[0]`, not a real branch.
  if (!gated) return { kind: "unavailable", reason: "the fetch capability was not resolved." };
  // The arguments the human sees on the prompt, and the only thing the gate is told about
  // this invocation: references and counts. `overwrites` is why the operator is not
  // approving "a fetch" but this fetch, of this size, over this file.
  await gated.execute({
    args: { from: to.name, ref: exchanged.ref, bytes: sizeBytes, overwrites: destExists },
  });

  if (decision === "withheld") {
    return { kind: "withheld", ref: exchanged.ref, path: parsed.path, sizeBytes };
  }
  if (decision !== "executed" || materialized === undefined) {
    return { kind: "not_confirmed", ref: exchanged.ref, path: parsed.path, sizeBytes };
  }
  if (!materialized.ok) return { kind: "unavailable", reason: materialized.reason };

  // 4. The bytes crossed — record it on BOTH logs, references only.
  store.recordArtifactFetched(connection, exchanged.ref, materialized.bytes);
  return {
    kind: "ok",
    result: {
      ref: exchanged.ref,
      path: parsed.path,
      bytes: materialized.bytes,
      overwrote: destExists,
    },
  };
}

/**
 * The shared cross-agent exchange: check the permission, audit, run AS THE CALLEE, audit.
 * Returns the callee's raw {@link ExecuteRunResult}, or `undefined` when no active
 * connection in `mode` authorizes it.
 *
 * Every mode routes through this one function so the invariants cannot drift between modes:
 * the connection check, the both-logs audit, and "the callee drives the whole loop" are
 * written once. What a mode may differ in is only its PROJECTION of the result — which each
 * public entry point applies, and which is the sole place invariant 2 is decided.
 */
async function performExchange(
  store: AsterismStore,
  from: Agent,
  to: Agent,
  input: string,
  mode: ConnectionMode,
  options: ExecuteRunOptions,
): Promise<{ connection: Connection; result: ExecuteRunResult } | undefined> {
  // The connection IS the permission. A read straight off the scoped repository, the same
  // way the rest of this module reads (`store.runs.get`); the directional `from → to`
  // lookup means a B→A connection never satisfies an A→B exchange, and the MODE is part of
  // the lookup, so a `handoff` connection never authorizes an `artifact-only` exchange.
  const connection = store.connections.findActive(from.id, to.id, mode);
  if (!connection) return undefined;
  // Audit the request on both logs BEFORE the run, so the exchange is recorded even if the
  // callee's run fails (the kernel writes the event log, not this op).
  store.recordHandoffRequested(connection);
  // The exchange IS an executeRun on the CALLEE. `to` drives the entire loop — its identity,
  // trust, tools, workspace, memory — so the callee's gate is sovereign and nothing of the
  // callee's beyond what the mode projects is reachable by the caller.
  const result = await executeRun(store, to, input, options);
  // Audit the return on both logs, carrying the final status as a reference (done / failed
  // / awaiting_confirmation) so a paused exchange is recorded honestly. The event payload
  // already carries the connection's mode, so both logs distinguish the exchange forms.
  store.recordHandoffCompleted(connection, result.run.id, result.status);
  // The connection travels back with the result because a mode's projection may need to
  // RECORD what it crossed, not just shape it: `artifact-only` persists its manifest as
  // resolvable `exchanges` rows keyed on this connection. Returning it here keeps that
  // recording in the mode's own entry point (where the projection is decided) rather than
  // making this shared function know which modes have a durable crossing.
  return { connection, result };
}
