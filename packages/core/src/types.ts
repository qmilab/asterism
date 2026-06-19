// Phase 0 data model — entity types and enums.
//
// The agent is the first-class identity and the isolation boundary. Every
// scoped entity carries an `agentId`; there is no global store any agent can
// reach. The reserved fields `teamId` / `ownerPrincipalId` exist in the schema
// (nullable) but are intentionally absent from these public types — they must
// not be exposed anywhere in Phase 0.

// Each enum has a single source of truth: a `readonly` array of its allowed
// values, with the union type derived from it. The arrays let the persistence
// layer validate untrusted input at the write boundary (a string from the CLI
// or HTTP surface cast to one of these types must still be a real member) so an
// invalid value can never reach a safety-critical path like trust resolution.

export const TRUST_LEVELS = ["propose", "notify", "autonomous"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const RUN_STATUSES = [
  "pending",
  "running",
  "awaiting_confirmation",
  "done",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const MEMORY_TYPES = [
  "semantic",
  "procedural",
  "convention",
  "negative",
  "episodic",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUSES = ["active", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const REVIEW_STATES = ["proposed", "accepted", "rejected"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * An agent's EARNED autonomy on one destructive capability — the per-capability
 * "trust contract" that sits underneath the coarse, whole-agent {@link TrustLevel}.
 * Progressive, and the *only* value that changes gate behaviour is the top rung:
 *
 * - `gated`          — the default (and the meaning of no row at all): every
 *                      destructive invocation of the capability pauses for
 *                      confirmation, exactly as before. A capability is also reset
 *                      to `gated` on a regression — autonomy is lost faster than earned.
 * - `standing-grant` — the capability's destructive actions auto-approve: its key
 *                      joins the run's `autoApprove` allow-list, so the existing
 *                      destructive gate ({@link decideGate}) lets it through without a
 *                      per-action pause. Reached ONLY by an explicit human ratification
 *                      of an earned track record — never silently, never automatically.
 *
 * Earned standing only ever ADDS a key to the allow-list the gate already consults;
 * it never weakens classification, never crosses capabilities, never crosses agents.
 */
export const CAPABILITY_STANDINGS = ["gated", "standing-grant"] as const;
export type CapabilityStanding = (typeof CAPABILITY_STANDINGS)[number];

/**
 * The kernel's canonical event vocabulary. Every consequential action the kernel
 * performs writes one of these to the append-only log, scoped to its `agentId`:
 * agent + run lifecycle, memory writes (and firewall refusals), skill/credential
 * changes, credential-value disclosures, and each trust-gate decision.
 *
 * The `events.type` column is itself a free string — an adapter may also log its
 * own run-loop event types (`message_end`, `tool_execution_end`, …) through the
 * same table — so this is the *kernel's own* set, kept as a single source of
 * truth so emitters and readers agree, not an exhaustive constraint on the column.
 *
 * Payloads carry REFERENCES ONLY: a credential's key and `valueRef`, a
 * capability key and effect class, a `memoryId`/`runId`. Never a secret value,
 * never raw tool args — the event log records references, not plaintext.
 */
export const EVENT_TYPES = [
  "agent.created",
  "agent.trust_changed",
  "agent.standing_changed",
  "agent.setting_changed",
  "run.started",
  "run.status_changed",
  "run.resumed",
  "run.declined",
  "memory.recorded",
  "memory.blocked",
  "memory.reviewed",
  "reflection.proposed",
  "skill.attached",
  "credential.added",
  "credential.rotated",
  "credential.removed",
  "secret.read",
  "action.executed",
  "action.succeeded",
  "action.withheld",
  "action.awaiting_confirmation",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Assert that `value` is one of `allowed`, returning it narrowed. Throws a clear
 * error otherwise. The single chokepoint for enum validation on the write path —
 * the storage layer never trusts the TypeScript type alone, mirroring how it
 * never trusts application code to remember the `agentId` filter.
 */
export function validateEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `invalid ${label}: ${JSON.stringify(value)} (expected one of: ${allowed.join(", ")})`,
    );
  }
  return value as T;
}

/**
 * Assert that `value` is a positive whole number, returning it. Throws a clear
 * error otherwise (zero, negative, fractional, NaN, or ±Infinity all fail —
 * `Number.isInteger` rejects the non-finite cases). The numeric sibling of
 * {@link validateEnum}: the write-boundary chokepoint for a tunable that must be a
 * positive count (e.g. a recall budget), so a bad value from a surface can never
 * reach a stored setting the kernel later trusts.
 */
export function validatePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `invalid ${label}: ${JSON.stringify(value)} (expected a positive whole number)`,
    );
  }
  return value;
}

/** The agent identity. `teamId` / `ownerPrincipalId` are reserved and hidden. */
export interface Agent {
  id: string;
  name: string;
  /** One-line responsibility. */
  role: string;
  /** Name or path of the persona config in the SOUL.md lineage. */
  soulRef: string;
  workspaceDir: string;
  trustLevel: TrustLevel;
  createdAt: string;
}

export interface Run {
  id: string;
  agentId: string;
  input: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** The run's final output text, once it has finished with output. Reflection reads it. */
  output?: string;
}

export interface Memory {
  id: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  confidence: number;
  sourceRunId?: string;
  status: MemoryStatus;
  reviewState: ReviewState;
  createdAt: string;
}

export interface Skill {
  id: string;
  agentId: string;
  name: string;
  /** Path to the markdown skill file in the agent's workspace. */
  path: string;
  createdAt: string;
}

export interface Credential {
  id: string;
  agentId: string;
  key: string;
  /** Reference into the local secret store — never the plaintext value. */
  valueRef: string;
  createdAt: string;
}

/**
 * An agent's earned standing on one destructive capability — the persisted
 * "trust contract". Scoped by `agentId` like every other row; one per
 * (agent, capability). `basis` is a human-readable, REFERENCES-ONLY summary of the
 * evidence at the last change (counts, never the action's arguments), so the audit
 * can show *why* a capability was granted or revoked without ever storing what it
 * acted on. A capability with no row is implicitly `gated`.
 */
export interface CapabilityGrant {
  id: string;
  agentId: string;
  /** The capability key this standing governs (e.g. `fs.delete`). */
  capability: string;
  standing: CapabilityStanding;
  /** Why the standing last changed — counts only, never arguments. */
  basis: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An agent's per-agent kernel settings — the operator-configurable knobs that
 * tune how the agent thinks, scoped by `agentId` like every other row. One per
 * agent; each field is an OVERRIDE where `undefined` means "unset, use the kernel
 * default". The shared home for per-agent tunables (recall budget is the first;
 * future knobs slot in beside it), so the resolution of "effective value" always
 * lives in the kernel, never in a surface.
 */
/**
 * The recall providers an agent can be opted into, beyond the built-in default. The
 * default lexical ranker is the absence of a selection (no row / NULL), never a value
 * here — so this lists only the OPT-IN alternatives. `"local"` selects the local
 * embeddings provider (`@qmilab/asterism-recall-local`), wired by the host only when
 * chosen; `core` itself never imports it.
 */
export const RECALL_PROVIDER_IDS = ["local"] as const;
export type RecallProviderId = (typeof RECALL_PROVIDER_IDS)[number];

export interface AgentSettings {
  agentId: string;
  /**
   * Per-agent recall budget — the maximum number of memories a run may frame.
   * `undefined` ⇒ unset, so the kernel falls back to {@link DEFAULT_RECALL_BUDGET}.
   */
  recallBudget?: number;
  /**
   * Per-agent opt-in to an alternative recall provider — which ranker selects WHICH
   * memories frame a run. `undefined` ⇒ unset, so the kernel uses its built-in,
   * dependency-free lexical ranker. The only non-default value is `"local"` (local
   * embeddings); the kernel stores the SELECTION but never builds the provider — the
   * host reads this and wires the opt-in package in, so `core` stays ML-free.
   */
  recallProvider?: RecallProviderId;
  /**
   * Per-agent override of the earned-standing earning bar: the minimum clean,
   * confirmed destructive executions a capability needs to be PROPOSED for an
   * auto-approve grant. `undefined` ⇒ unset, so the kernel falls back to
   * `DEFAULT_STANDING_POLICY.minCleanExecutions`.
   */
  minCleanExecutions?: number;
  /**
   * Per-agent override of the earning bar's breadth half: the minimum DISTINCT
   * targets among those clean executions. `undefined` ⇒ unset, so the kernel falls
   * back to `DEFAULT_STANDING_POLICY.minDistinctTargets`.
   */
  minDistinctTargets?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The earned-standing thresholds an operator can override per agent — the writable
 * subset of {@link AgentSettings}. Each field is optional: a provided field is set,
 * an omitted one is left exactly as it was (so tuning one half never clears the
 * other). The kernel resolves these against `DEFAULT_STANDING_POLICY` for an
 * effective `StandingPolicy`.
 */
export type StandingThresholds = Pick<AgentSettings, "minCleanExecutions" | "minDistinctTargets">;

export interface Event {
  id: string;
  agentId: string;
  runId?: string;
  type: string;
  payload: unknown;
  createdAt: string;
}
