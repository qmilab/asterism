// Trust contracts — reading EARNED standing out of the event log.
//
// A coarse `trustLevel` says how an agent acts in general; a per-capability
// standing says which destructive capabilities it has *earned* the right to run
// without a per-action pause. This module is the "earned" half: pure logic that
// reads the append-only event log — the flight recorder the kernel already keeps —
// and computes which destructive capabilities have a clean enough track record to
// PROPOSE for a standing grant. It writes nothing; a human ratifies a proposal
// (mirroring `reflect --review`), and only that ratification grants.
//
// Why the event log and not new telemetry: every confirmed destructive execution
// already lands as `action.executed`, every success as `action.succeeded`, every
// pause as `action.awaiting_confirmation`, every refusal as `run.declined`, and
// every standing change as `agent.standing_changed` — all references-only (capability
// key + a one-way argument fingerprint, never the args). So evidence is a READ, not a
// new write path, and it inherits the log's isolation: the events come from one
// agent's scoped log, so standing can only ever be earned from that agent's own history.
//
// The computation is PURE and DETERMINISTIC over the event list (no clock, no I/O):
// the same log always yields the same candidates, which keeps the policy testable.

import type { AsterismStore } from "./store.js";
import type { Agent, Event } from "./types.js";

/**
 * The bar a destructive capability must clear to be PROPOSED for a standing grant.
 * Defaulted-but-overridable (a per-agent configurable policy is a later slice — it
 * shares the "where does a per-agent setting live" decision with the recall budget).
 * The defaults are deliberately conservative: a grant on a destructive capability is
 * broad (it auto-approves every future invocation of that capability), so it must be
 * earned across BREADTH, not a single repeated action.
 *
 * There is no "regressions tolerated" knob: a regression (a decline or a failed run
 * that ran the capability) RESETS the earning window — autonomy is lost faster than
 * earned — so the bar is always measured over the clean streak SINCE the last
 * regression or downgrade. One slip and the agent starts over.
 */
export interface StandingPolicy {
  /** Minimum confirmed, successful destructive executions since the last reset. */
  minCleanExecutions: number;
  /** Minimum distinct argument fingerprints among those executions (breadth, not repetition). */
  minDistinctTargets: number;
}

/** The default earning bar: three clean executions across two distinct targets, no slip since. */
export const DEFAULT_STANDING_POLICY: StandingPolicy = Object.freeze({
  minCleanExecutions: 3,
  minDistinctTargets: 2,
});

/**
 * The EFFECTIVE earning bar for an agent: its own per-agent threshold overrides
 * (set via `trust ... threshold`) where present, else {@link DEFAULT_STANDING_POLICY}
 * for each half. The kernel owns this resolution — the same reason `resolveRecallBudget`
 * does — so every surface that proposes grants reads one effective policy and can never
 * drift on the bar. The read is `agentId`-scoped, so a bar is resolved only from that
 * agent's own setting, never another's; an unset agent resolves to the pure default.
 */
export function resolveStandingPolicy(store: AsterismStore, agent: Agent): StandingPolicy {
  const override = store.agentSettings.getStandingThresholds(agent.id);
  return {
    minCleanExecutions: override.minCleanExecutions ?? DEFAULT_STANDING_POLICY.minCleanExecutions,
    minDistinctTargets: override.minDistinctTargets ?? DEFAULT_STANDING_POLICY.minDistinctTargets,
  };
}

/** The evidence for one destructive capability, read from an agent's event log. */
export interface CapabilityEvidence {
  capability: string;
  /** Confirmed destructive executions in `done` runs SINCE the capability's last reset. */
  cleanExecutions: number;
  /** Distinct argument fingerprints among the clean executions — how broad the track record is. */
  distinctTargets: number;
}

/**
 * A destructive capability that has cleared the policy bar and is PROPOSED for a
 * standing grant. Carries its evidence (counts only) and a references-only `basis`
 * string the human sees and that becomes the grant's recorded justification.
 */
export interface StandingCandidate extends CapabilityEvidence {
  basis: string;
}

// ---------------------------------------------------------------------------
// Event reading — pure helpers over the references-only log.
// ---------------------------------------------------------------------------

/** A run's terminal disposition, as read back from its events. */
type RunOutcome = "done" | "failed" | "declined" | "pending";

interface PayloadFields {
  capability?: string;
  effect?: string;
  fingerprint?: string;
  to?: string;
}

/** Narrow an event's `unknown` payload to the reference fields this module reads. */
function fields(payload: unknown): PayloadFields {
  if (payload === null || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  return {
    ...(typeof p.capability === "string" ? { capability: p.capability } : {}),
    ...(typeof p.effect === "string" ? { effect: p.effect } : {}),
    ...(typeof p.fingerprint === "string" ? { fingerprint: p.fingerprint } : {}),
    ...(typeof p.to === "string" ? { to: p.to } : {}),
  };
}

/** Determine a run's terminal outcome from its own events (a decline beats a status flip). */
function runOutcome(events: readonly Event[]): RunOutcome {
  if (events.some((e) => e.type === "run.declined")) return "declined";
  let outcome: RunOutcome = "pending";
  for (const e of events) {
    if (e.type !== "run.status_changed") continue;
    const to = fields(e.payload).to;
    if (to === "done") outcome = "done";
    else if (to === "failed") outcome = "failed";
  }
  return outcome;
}

/** A destructive action recorded in the log, tagged with the flat-log index it landed at. */
interface ExecRecord {
  capability: string;
  fingerprint: string | undefined;
  index: number;
}

/**
 * Compute every destructive capability's evidence from an agent's whole event log
 * (oldest-first, as `store.events.list` returns it). The computation is windowed
 * per capability: only clean executions AFTER that capability's most recent RESET
 * count. A reset is a downgrade (`agent.standing_changed` → `gated`, e.g. a revoke)
 * OR a regression (a decline, or a destructive execution in a run that then failed).
 *
 * So a regression genuinely RESETS the ramp — autonomy is re-earned from a fresh
 * track record, never topped up on the history that preceded the slip — and this
 * holds for a capability that was NEVER granted just as much as for one that was: an
 * early decline does not block a capability forever; it just means the clean streak
 * starts after it. (Autonomy is lost faster than earned, in the safe direction.)
 */
export function gatherEvidence(events: readonly Event[]): Map<string, CapabilityEvidence> {
  // Group every event by its run so each run's outcome can be read as a whole.
  const byRun = new Map<string, { events: Event[]; indices: number[] }>();
  events.forEach((e, i) => {
    if (e.runId === undefined) return;
    const bucket = byRun.get(e.runId) ?? { events: [], indices: [] };
    bucket.events.push(e);
    bucket.indices.push(i);
    byRun.set(e.runId, bucket);
  });

  const cleanExecs = new Map<string, ExecRecord[]>();
  // Per-capability RESET points (flat-log indices): a clean execution only counts if
  // it lands strictly after the capability's latest reset.
  const resets = new Map<string, number[]>();
  const noteReset = (capability: string, index: number): void => {
    const list = resets.get(capability) ?? [];
    list.push(index);
    resets.set(capability, list);
  };

  // A downgrade to `gated` (a revoke / regression-driven reset) is a reset point.
  events.forEach((e, i) => {
    if (e.type !== "agent.standing_changed") return;
    const f = fields(e.payload);
    if (f.capability !== undefined && f.to === "gated") noteReset(f.capability, i);
  });

  for (const { events: runEvents, indices } of byRun.values()) {
    const outcome = runOutcome(runEvents);
    // Per run, the destructive ATTEMPTS (`action.executed`, recorded up front — possibly
    // errored) and the genuine SUCCESSES (`action.succeeded`, the tool returned non-error).
    const attempts: ExecRecord[] = [];
    const successes: ExecRecord[] = [];
    runEvents.forEach((e, j) => {
      const f = fields(e.payload);
      if (f.capability === undefined || f.effect !== "destructive") return;
      if (e.type === "action.executed") {
        attempts.push({ capability: f.capability, fingerprint: f.fingerprint, index: indices[j]! });
      } else if (e.type === "action.succeeded") {
        successes.push({ capability: f.capability, fingerprint: f.fingerprint, index: indices[j]! });
      }
    });

    if (outcome === "done") {
      // Only genuine SUCCESSES count toward a clean streak — an errored destructive
      // attempt (executed-but-not-succeeded) earns nothing, even if the run recovered.
      for (const ex of successes) {
        const list = cleanExecs.get(ex.capability) ?? [];
        list.push(ex);
        cleanExecs.set(ex.capability, list);
      }
    } else if (outcome === "failed") {
      // A destructive action that ran in a run that then failed is a regression —
      // the same signal that auto-revokes a granted capability — so it resets the ramp.
      for (const ex of attempts) noteReset(ex.capability, ex.index);
    } else if (outcome === "declined") {
      // Declining a run refuses every destructive action PENDING on it — exactly those
      // paused in its FINAL cycle: the `action.awaiting_confirmation` events AFTER the
      // last `run.resumed` (or all of them, if it was never resumed — the resume path
      // replays the loop, so an earlier cycle's pauses were superseded). This is precise
      // where a per-key match is not: an invocation confirmed and run in an earlier
      // cycle is not pending and is not reset, while a duplicate refused alongside a
      // confirmed twin still pauses in the final cycle and so DOES reset its capability.
      // One refusal of a capability resets that capability's whole streak.
      const declineIdx = indices[runEvents.findIndex((e) => e.type === "run.declined")]!;
      let lastResumed = -1;
      runEvents.forEach((e, j) => {
        if (e.type === "run.resumed") lastResumed = j;
      });
      const reset = new Set<string>();
      runEvents.forEach((e, j) => {
        if (j <= lastResumed || e.type !== "action.awaiting_confirmation") return;
        const cap = fields(e.payload).capability;
        if (cap === undefined || reset.has(cap)) return;
        reset.add(cap);
        noteReset(cap, declineIdx);
      });
    }
  }

  // Assemble per-capability evidence over the window since each capability's last reset.
  const capabilities = new Set<string>([...cleanExecs.keys(), ...resets.keys()]);
  const out = new Map<string, CapabilityEvidence>();
  for (const capability of capabilities) {
    const since = Math.max(-1, ...(resets.get(capability) ?? []));
    const cleans = (cleanExecs.get(capability) ?? []).filter((ex) => ex.index > since);
    const distinct = new Set(cleans.map((ex) => ex.fingerprint ?? "")).size;
    out.set(capability, { capability, cleanExecutions: cleans.length, distinctTargets: distinct });
  }
  return out;
}

/** Whether a capability's evidence clears the policy bar for a proposed grant. */
export function qualifies(evidence: CapabilityEvidence, policy: StandingPolicy): boolean {
  return (
    evidence.cleanExecutions >= policy.minCleanExecutions &&
    evidence.distinctTargets >= policy.minDistinctTargets
  );
}

/** A one-line, references-only justification (counts, never arguments) for a grant. */
export function evidenceBasis(evidence: CapabilityEvidence): string {
  const execs = `${evidence.cleanExecutions} confirmed execution${evidence.cleanExecutions === 1 ? "" : "s"}`;
  const targets = `${evidence.distinctTargets} distinct target${evidence.distinctTargets === 1 ? "" : "s"}`;
  return `earned: ${execs} across ${targets}, no slip since`;
}

/**
 * Propose which of an agent's destructive capabilities have earned a standing grant
 * — the kernel-owned policy home, shared by every surface that ratifies standing (so
 * the CLI and a future dashboard card can never drift on WHAT qualifies). It reads
 * the agent's own scoped event log, computes evidence, and returns the capabilities
 * that clear the bar AND are not already granted, oldest-capability-name first.
 *
 * It only ever PROPOSES — nothing persists here. A human accepts a candidate (the
 * surface calls `store.setCapabilityStanding(..., "standing-grant", candidate.basis)`),
 * and only then is the grant recorded and the gate's `autoApprove` widened. An
 * already-granted capability is excluded, so re-running review never re-proposes what
 * is already earned.
 *
 * The earning bar is the agent's own EFFECTIVE policy ({@link resolveStandingPolicy}:
 * its per-agent overrides, else the default) unless a `policy` is passed explicitly —
 * so a stricter agent bar suppresses a candidate the default would surface, and a
 * looser one surfaces it sooner, all without weakening the gate.
 */
export function proposeStandingGrants(
  store: AsterismStore,
  agent: Agent,
  policy: StandingPolicy = resolveStandingPolicy(store, agent),
): StandingCandidate[] {
  const events = store.events.list(agent.id);
  const evidence = gatherEvidence(events);
  const alreadyGranted = new Set(store.capabilityStanding.grantedKeys(agent.id));

  const candidates: StandingCandidate[] = [];
  for (const ev of evidence.values()) {
    if (alreadyGranted.has(ev.capability)) continue;
    if (!qualifies(ev, policy)) continue;
    candidates.push({ ...ev, basis: evidenceBasis(ev) });
  }
  candidates.sort((a, b) => a.capability.localeCompare(b.capability));
  return candidates;
}
