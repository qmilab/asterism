// The audit bridge — wires the kernel's safety-critical trust-gate decisions to
// the append-only event log.
//
// The trust gate (`trust.ts`) already exposes the only decision points that
// matter for autonomy: an action executed, a side effect withheld under
// `propose`, or a destructive action paused for confirmation. Those are surfaced
// through `TrustHooks`. This module turns each into an `agentId`-scoped Event so a
// run's consequential choices can be read back later via `events tail`.
//
// REFERENCES ONLY. The hook contract in `trust.ts` is explicit: a handler that
// persists to the event log must record references, never the arguments a model
// produced — those can carry a live secret value. So the payload here is the
// capability key plus the *effective* effect class (after destructive
// escalation). `action.args` is never written. The one addition is on a pause: a
// non-reversible `fingerprint` of the args (a one-way digest — a reference to the
// invocation, not a path back to its arguments), which the out-of-band resume uses
// to bind a confirmation to the exact paused action. It reveals no argument value.
//
// This module depends on `trust` and the event repository; nothing depends on it.
// It deliberately does NOT know about the store or run-status transitions: the
// surface composes its own `base` hooks (e.g. flipping a Run to
// `awaiting_confirmation`, which the store logs as `run.status_changed`) and
// passes them in to be preserved alongside the audit writes.

import type { Action, TrustHooks } from "./trust.js";
import { actionFingerprint, classifyEffect } from "./trust.js";
import type { EventRepository } from "./repositories/events.js";

/** Run context stamped onto every audit event so the log ties back to a run. */
export interface AuditContext {
  runId?: string;
}

/**
 * Build {@link TrustHooks} that append an audit Event on every gate decision,
 * composed over an optional `base` set of hooks whose behaviour is preserved:
 * the audit write fires first, then the base handler. `base.confirm` and
 * `base.abortController` pass through untouched (the audit layer never decides a
 * confirmation — it only records that one was required).
 *
 * Each event's payload is `{ capability, effect }` — references only. The effect
 * is the *classified* effect (escalated to `destructive` when the action's
 * command tripped the taxonomy), so the log reflects what the gate actually
 * reasoned about, not just the declared base effect.
 */
export function auditTrustHooks(
  events: EventRepository,
  agentId: string,
  context: AuditContext = {},
  base: TrustHooks = {},
): TrustHooks {
  const { runId } = context;
  const record = (type: string, action: Action, extra?: Record<string, unknown>): void => {
    events.append(agentId, {
      type,
      ...(runId !== undefined ? { runId } : {}),
      payload: { capability: action.capability, effect: classifyEffect(action), ...extra },
    });
  };
  return {
    ...base,
    onExecute: (action) => {
      record("action.executed", action);
      base.onExecute?.(action);
    },
    onWithhold: (action) => {
      record("action.withheld", action);
      base.onWithhold?.(action);
    },
    onAwaitConfirmation: (action) => {
      // The pause carries a non-reversible `fingerprint` of the arguments (a
      // reference, never the args) so an out-of-band resume can bind a human's
      // confirmation to THIS exact invocation, not just its capability.
      record("action.awaiting_confirmation", action, {
        fingerprint: actionFingerprint(action.args),
      });
      base.onAwaitConfirmation?.(action);
    },
  };
}
