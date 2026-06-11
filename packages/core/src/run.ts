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

import type { RuntimeAdapter, RunOutput, RunEvent } from "./adapter.js";
import { frameRun, resolveSoul } from "./framing.js";
import type { SkillContext } from "./framing.js";
import { auditTrustHooks } from "./audit.js";
import { actionFingerprint, classifyEffect, resolveToolRegistry, trustProfile } from "./trust.js";
import type { Action, Capability, EffectClass, TrustHooks } from "./trust.js";
import type { AsterismStore } from "./store.js";
import type { Agent, Run, RunStatus } from "./types.js";

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
  // A fresh run pre-approves NOTHING (empty grant): every destructive action pauses
  // for confirmation regardless of trust level. The resume path (`resumeRun`) is the
  // only caller that supplies a grant, and only for what a human just confirmed.
  return runAndPersist(store, agent, run, input, options, new Set());
}

/**
 * The shared run loop: trust-resolve + gate → frame → substrate → persist, for a
 * run that is ALREADY recorded and `running`. Both starting a run (`executeRun`)
 * and resuming a parked one (`resumeRun`) funnel through here, so the trust/gate
 * path is identical whether a run is fresh or resumed — there is one place where
 * the agent's identity, trust level, and tools turn into an executed (and audited)
 * outcome.
 *
 * `preApproved` is the ONLY difference between the two callers: empty for a fresh
 * run (every destructive action pauses), or a SET of per-action approval keys
 * (capability + arguments fingerprint) for a resume — the exact invocations a human
 * confirmed. Each is consumed once when matched, so resuming clears those exact
 * invocations and a further destructive call — a different capability, OR the same
 * capability aimed at a new target — still pauses. A resume never widens the gate
 * into a blanket grant.
 */
async function runAndPersist(
  store: AsterismStore,
  agent: Agent,
  run: Run,
  input: string,
  options: ExecuteRunOptions,
  preApproved: ReadonlySet<string>,
): Promise<ExecuteRunResult> {
  // Resolve the agent's trust level into the tool set this run may use, with the
  // destructive-action gate wired into every tool's `execute` closure and each
  // gate decision audited to the event log. Confined by default — the exposure
  // list is derived from exactly the capabilities the caller handed in (an empty
  // set if none).
  const abortController = new AbortController();
  const capabilities = options.capabilities ?? [];
  const profile = trustProfile({
    level: agent.trustLevel,
    capabilities: capabilities.map((c) => c.key),
  });
  // The agent's secret key for fingerprinting a paused action's arguments. The same
  // key feeds the audit (which records the fingerprint on a pause) and the gate
  // (which recomputes it to match a pre-approval), so the two agree, and a reader of
  // the event log cannot guess the fingerprint without it.
  const fingerprintKey = store.actionFingerprintKey(agent.id);
  // A private, MUTABLE copy of the resume's per-action approval set, keyed per
  // paused ACTION — capability AND a fingerprint of its arguments, not capability
  // alone. Each pre-approved invocation is consumed when matched, so the grant
  // covers exactly the invocations a human confirmed: a delete of `dist` does not
  // clear a delete of `cache` (different fingerprint), and a second call beyond what
  // was approved still pauses. Empty for a fresh run, so nothing is pre-approved.
  const remainingApprovals = new Set(preApproved);
  const claimPreApproval = (action: Action): boolean => {
    const key = approvalKey(action.capability, actionFingerprint(action.args, fingerprintKey));
    if (!remainingApprovals.has(key)) return false;
    remainingApprovals.delete(key);
    return true;
  };
  // Accumulate the run's gate decisions for the post-run summary, sourced from the
  // same hooks that feed the event log. EVERY decision is pushed into `actions` in
  // the order it happened — a pause included, recorded the moment it occurs rather
  // than appended at the end — so the summary is "one entry per gate decision, in
  // order" no matter how many actions overlap.
  //
  // A paused destructive action may later be confirmed and run. To reflect that as
  // ONE entry (executed, not paused-then-executed) without losing its position, we
  // keep its already-positioned record by the action OBJECT and reclassify it in
  // place when that same action executes. Keying on identity is exact: one
  // `gateTool.execute` call builds the action once and hands that same object to
  // both `onAwaitConfirmation` and its own `onExecute`. A per-action map (not a
  // single slot) is required because the substrate may start several destructive
  // calls before the first aborts — a shared slot would drop all but the last, and
  // aborting the run does not retract calls already in flight.
  const actions: ActionRecord[] = [];
  const pausedByAction = new Map<Action, ActionRecord>();
  const record = (action: Action, decision: ActionRecord["decision"]): ActionRecord => ({
    capability: action.capability,
    effect: classifyEffect(action),
    decision,
  });
  const collectActions = (): readonly ActionRecord[] => actions;

  const baseHooks: TrustHooks = {
    onAwaitConfirmation: (action) => {
      store.setRunStatus(agent.id, run.id, "awaiting_confirmation");
      // Record the pause in order immediately; keep the entry so the same action's
      // later execute can reclassify it in place.
      const paused = record(action, "paused");
      actions.push(paused);
      pausedByAction.set(action, paused);
    },
    onExecute: (action) => {
      const paused = pausedByAction.get(action);
      if (paused) {
        // This execute resolves the pause THIS action triggered (same object): the
        // human confirmed it. Flip the run back to `running` so the confirmed action
        // lets it finish `done` instead of stranding it non-terminal with the side
        // effect already performed (the gate's documented "resume" semantics) —
        // guarded on the transition, so it never writes a redundant status event.
        if (store.runs.get(agent.id, run.id)?.status === "awaiting_confirmation") {
          store.setRunStatus(agent.id, run.id, "running");
        }
        // Reclassify the already-positioned record in place — not a second entry.
        paused.decision = "executed";
        pausedByAction.delete(action);
        return;
      }
      actions.push(record(action, "executed"));
    },
    onWithhold: (action) => {
      actions.push(record(action, "withheld"));
    },
    claimPreApproval,
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
  const memories = store.memories.list(agent.id);
  const request = frameRun({
    agent,
    ...(soulText !== undefined ? { soulText } : {}),
    skills,
    memories,
    input,
    tools,
    signal: abortController.signal,
  });

  // If the substrate throws — synchronously from `run(request)` while building its
  // handle, or by rejecting its output promise (the contract says a run settles
  // with status "failed", but a non-conforming or crashing adapter can do either) —
  // do not strand the run in `running`: drive it to a terminal state so every
  // surface gets a structured result rather than an opaque rejection (over HTTP
  // that would otherwise be a 500 with the run row mid-flight). So `run(request)`
  // itself stays INSIDE the guard, not just the `await`.
  //
  // `streamed` is the event-drain promise: starts as a resolved no-op so the catch
  // can flush it unconditionally even when the substrate threw before handing back
  // a handle (nothing was ever streamed in that case), and is reassigned the moment
  // we have a handle. Forwarding is kicked off NOW (not awaited yet) so activity
  // streams while the run is in flight; it is flushed (NOT blindly awaited — see
  // `flushEvents`) at each exit below so the stream is drained before the surface
  // formats its result without a non-closing stream being able to hang the run. The
  // kernel is the single consumer and only forwards — it never acts on an event.
  let output: RunOutput;
  let streamed: Promise<void> = Promise.resolve();
  try {
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
      return { run: paused, status: "awaiting_confirmation", output: "", actions: collectActions() };
    }
    const failed = store.finishRun(agent.id, run.id, "", "failed");
    return {
      run: failed ?? run,
      status: "failed",
      output: "",
      error: err instanceof Error ? err.message : String(err),
      actions: collectActions(),
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
    return {
      run: persisted ?? current,
      status: "awaiting_confirmation",
      output: output.text,
      actions: collectActions(),
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
  return {
    run: finished ?? current ?? run,
    status,
    output: output.text,
    ...(output.error !== undefined ? { error: output.error } : {}),
    actions: collectActions(),
  };
}

// An approval keys an action by capability AND a fingerprint of its arguments,
// joined by a NUL (which a capability key can never contain), so the grant is tied
// to a specific invocation rather than a whole capability. The fingerprint comes
// from the paused event (recorded by `audit.ts`) when reconstructing prior grants,
// and is recomputed from the live action (`claimPreApproval`) on the gate side; the
// two agree because both use {@link actionFingerprint}.
const APPROVAL_KEY_SEP = "\u0000";
function approvalKey(capability: string, fingerprint: string): string {
  return `${capability}${APPROVAL_KEY_SEP}${fingerprint}`;
}
/** One destructive invocation a confirm grants — a reference (capability + a one-way fingerprint of its args). */
export interface GrantedAction {
  capability: string;
  fingerprint: string;
}

/** What a confirm grants for a run: the per-action approvals, both as gate keys and as recordable references. */
interface ResumeApproval {
  /** Composite (capability + fingerprint) keys the gate pre-approves this resume. */
  grant: Set<string>;
  /** The same grant as references, recorded on `run.resumed` so the next confirm can read prior grants. */
  granted: GrantedAction[];
}

/** Pull a `{capability, fingerprint}` pair out of an event payload, if both are present. */
function actionRef(payload: unknown): GrantedAction | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const cap = (payload as { capability?: unknown }).capability;
  const fingerprint = (payload as { fingerprint?: unknown }).fingerprint;
  if (typeof cap !== "string" || typeof fingerprint !== "string") return undefined;
  return { capability: cap, fingerprint };
}

/**
 * What a single confirm grants for a run — reconstructed from its own event log
 * (scoped to the agent AND run; references only — capability keys and one-way
 * argument fingerprints, never the args).
 *
 * Bound to specific invocations (capability + fingerprint), and crucially it grants
 * at most ONE NOT-YET-CONFIRMED action per confirm: every action earlier confirms
 * already granted (read back from `run.resumed`, so the replay re-clears them and
 * converges) PLUS the first paused action not among them. So if a run paused on
 * several destructive actions at once — a substrate that fired them before the abort
 * landed — a single confirmation approves just one; the rest pause again, each needing
 * its own confirm. One "yes" never silently green-lights several distinct destructive
 * actions a human never individually approved.
 */
function resumeApproval(
  store: AsterismStore,
  agentId: string,
  runId: string,
): ResumeApproval {
  // Distinct paused actions in first-seen order, and the actions earlier confirms
  // already granted (so we never re-count one of those as "new").
  const awaited: GrantedAction[] = [];
  const seen = new Set<string>();
  const priorGrant = new Set<string>();
  for (const event of store.events.listForRun(agentId, runId)) {
    if (event.type === "action.awaiting_confirmation") {
      const ref = actionRef(event.payload);
      if (!ref) continue;
      const key = approvalKey(ref.capability, ref.fingerprint);
      if (!seen.has(key)) {
        seen.add(key);
        awaited.push(ref);
      }
    } else if (event.type === "run.resumed") {
      const granted = (event.payload as { granted?: unknown } | null)?.granted;
      if (Array.isArray(granted)) {
        for (const g of granted) {
          const ref = actionRef(g);
          if (ref) priorGrant.add(approvalKey(ref.capability, ref.fingerprint));
        }
      }
    }
  }

  // Re-grant everything already confirmed (for replay convergence) plus the FIRST
  // paused action not yet confirmed — at most one new action per confirm.
  const grant = new Set(priorGrant);
  const next = awaited.find((a) => !grant.has(approvalKey(a.capability, a.fingerprint)));
  if (next) grant.add(approvalKey(next.capability, next.fingerprint));
  const granted = awaited.filter((a) => grant.has(approvalKey(a.capability, a.fingerprint)));
  return { grant, granted };
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
 * The substrate holds no resumable loop state, and the parked run never executed
 * its destructive action (the gate aborts BEFORE the tool runs). So resuming
 * RE-ENTERS the loop on the same run row: the kernel re-frames the agent's
 * original task and re-runs it with a BOUNDED budget of destructive invocations
 * pre-approved — exactly the count the run was gated on, per capability, and
 * nothing more. The agent re-derives the action with full context and, this time,
 * the gate lets the confirmed invocations through.
 *
 * The gate is not weakened: the pre-approval is a per-capability COUNT scoped to
 * this one resumed run, so a destructive invocation beyond what was confirmed —
 * whether a new capability or the same capability aimed at a new target — pauses
 * again (and can be confirmed in turn). Classification is unchanged. The confirmed
 * capabilities are recorded on the event log via `run.resumed` before the re-run,
 * so the audit names what a human granted.
 *
 * Note the honest cost of re-execution: a parked run's NON-destructive side
 * effects (writes done before the gate stopped it) run again on resume. The
 * destructive action it paused on had not run when the gate stopped it, so
 * confirming it does not double it.
 */
export async function resumeRun(
  store: AsterismStore,
  agent: Agent,
  runId: string,
  options: ExecuteRunOptions,
): Promise<ResumeOutcome> {
  // Cheap pre-checks for clear errors. NOT the authoritative guard — the atomic
  // claim below is — but they avoid computing a budget for a run that obviously
  // cannot be resumed.
  const parked = store.runs.get(agent.id, runId);
  if (!parked) return { kind: "not_found" };
  if (parked.status !== "awaiting_confirmation") return { kind: "not_paused", run: parked };

  // What this confirm grants — the actions already confirmed (so the replay clears
  // them) plus at most ONE new paused action, each bound to its exact invocation by
  // a fingerprint. A run paused on several actions at once is thus cleared one
  // confirm at a time, never all at once.
  const { grant, granted } = resumeApproval(store, agent.id, runId);
  const confirmed = [...new Set(granted.map((g) => g.capability))];

  // Atomically claim the run (awaiting_confirmation → running) and record the
  // grant — both the human-readable capabilities and the per-action references the
  // NEXT confirm reads back to know what is already granted. If the claim is lost
  // (a concurrent confirm already took it, or it changed under us), DO NOT re-enter
  // the loop: that is what stops two racing confirms from double-executing.
  const claimed = store.recordRunResumed(agent.id, runId, confirmed, granted);
  if (!claimed) {
    const current = store.runs.get(agent.id, runId);
    return current ? { kind: "not_paused", run: current } : { kind: "not_found" };
  }

  const result = await runAndPersist(store, agent, claimed, claimed.input, options, grant);
  return { kind: "resumed", result };
}
