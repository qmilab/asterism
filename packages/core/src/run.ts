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

import type { RuntimeAdapter, RunOutput } from "./adapter.js";
import { frameRun, resolveSoul } from "./framing.js";
import type { SkillContext } from "./framing.js";
import { auditTrustHooks } from "./audit.js";
import { resolveToolRegistry, trustProfile } from "./trust.js";
import type { Action, Capability, TrustHooks } from "./trust.js";
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

  // Resolve the agent's trust level into the tool set this run may use, with the
  // destructive-action gate wired into every tool's `execute` closure and each
  // gate decision audited to the event log. Confined by default — the exposure
  // list is derived from exactly the capabilities the caller handed in (an empty
  // set if none), and `autoApprove` stays empty so every destructive action pauses
  // regardless of trust level.
  const abortController = new AbortController();
  const capabilities = options.capabilities ?? [];
  const profile = trustProfile({
    level: agent.trustLevel,
    capabilities: capabilities.map((c) => c.key),
  });
  const baseHooks: TrustHooks = {
    onAwaitConfirmation: () => {
      store.setRunStatus(agent.id, run.id, "awaiting_confirmation");
    },
    onExecute: () => {
      // A destructive action the human *confirmed* executes here: the gate flipped
      // the run to `awaiting_confirmation` before prompting, then fell through to
      // run it. Flip the status back to `running` so a confirmed action lets the
      // run finish `done`, instead of stranding it non-terminal with the side
      // effect already performed (the gate's documented "resume" semantics). Guarded
      // on the transition, so an ordinary action — which runs while already
      // `running` — never triggers a redundant write or status event.
      if (store.runs.get(agent.id, run.id)?.status === "awaiting_confirmation") {
        store.setRunStatus(agent.id, run.id, "running");
      }
    },
    abortController,
    ...(options.confirm ? { confirm: options.confirm } : {}),
  };
  const hooks = auditTrustHooks(store.events, agent.id, { runId: run.id }, baseHooks);
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

  // The substrate runs the loop. If it throws, or its output promise rejects (the
  // contract says a run settles with status "failed", but a non-conforming or
  // crashing adapter can reject outright), do not strand the run in `running`:
  // drive it to a terminal state so every surface gets a structured result rather
  // than an opaque rejection — over HTTP that would otherwise surface as a 500
  // with the run row left mid-flight.
  let output: RunOutput;
  try {
    output = await options.adapter.run(request).output;
  } catch (err) {
    // A gate pause aborts the run via the signal, which some adapters surface as a
    // rejection. If the gate paused it, preserve `awaiting_confirmation` rather
    // than masking it as a failure; otherwise the substrate genuinely failed.
    const paused = store.runs.get(agent.id, run.id);
    if (paused?.status === "awaiting_confirmation") {
      return { run: paused, status: "awaiting_confirmation", output: "" };
    }
    const failed = store.finishRun(agent.id, run.id, "", "failed");
    return {
      run: failed ?? run,
      status: "failed",
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

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
  };
}
