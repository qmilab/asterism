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
 * A standing objective's lifecycle. An objective is operator-declared current
 * purpose, not an accumulated lesson — so it has a small completion lifecycle
 * rather than memory's review/archive states:
 *
 * - `active`  — the default, and the ONLY state that frames runs. It is what the
 *               agent is working toward right now, surfaced as standing context on
 *               every run (not relevance-ranked — objectives are few and all-relevant).
 * - `done`    — completed; kept for history, no longer framed.
 * - `dropped` — abandoned; kept for history, no longer framed.
 *
 * Only `active` shaping behaviour is the same "only the live subset frames a run"
 * rule memory's `active + accepted` predicate enforces.
 */
export const OBJECTIVE_STATUSES = ["active", "done", "dropped"] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/**
 * The statuses an objective may be TRANSITIONED to when it is wound down — the non-`active`
 * terminals `done` and `dropped`. An objective is never transitioned back to `active` (its
 * starting state), so this is the legal target set for both the operator's `objective done`/`drop`
 * intent and the Type-B reflection transition advisory. `satisfies readonly ObjectiveStatus[]` makes
 * it a compile-time-checked subset of {@link OBJECTIVE_STATUSES}, so the two can never drift.
 */
export const TRANSITION_STATUSES = ["done", "dropped"] as const satisfies readonly ObjectiveStatus[];

export type TransitionStatus = (typeof TRANSITION_STATUSES)[number];

/** Whether `value` is a status an objective may be transitioned TO (`done`/`dropped`, never `active`). */
export function isTransitionStatus(value: string): value is TransitionStatus {
  return (TRANSITION_STATUSES as readonly string[]).includes(value);
}

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
 * The collaboration MODES a {@link Connection} can grant — the single dial for "how much
 * of the callee does the caller get back". Phase 3 (Collaboration) opens the agent
 * boundary ONLY through an explicit, permissioned connection, and a connection grants
 * exactly its mode's exchange form and nothing wider (golden rule 5; design note
 * `phase-3-collaboration.md` §4). T1 implements the FIRST and least-curated mode:
 *
 * - `handoff` — the caller asks the callee to perform a task; the callee runs it in its
 *   OWN workspace, under its OWN trust profile and scoped tools, and the caller receives
 *   only the callee's final `RunOutput` (its text/result) — never the callee's memory,
 *   transcript, or secrets.
 *
 * Only the modes with a real implementation are enumerated, so the write boundary
 * ({@link validateEnum}) can never persist a connection in a mode nothing consumes. The
 * stricter modes (`artifact-only`, `read-summary`, `shared-brief`, `delegated-tool`) join
 * this list as their threads (T2/T3) land — never a half-built mode.
 */
export const CONNECTION_MODES = ["handoff"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

/**
 * A {@link Connection}'s lifecycle. A connection is the permission object: only an
 * `active` one grants its mode's exchange (a handoff over a non-active connection is
 * refused, the same default-isolation rule as no connection at all).
 *
 * - `active`  — the default on create, and the ONLY state that grants the exchange.
 * - `revoked` — withdrawn; kept for audit/history, no longer grants anything.
 *
 * T1 creates only `active` connections (there is no revoke command yet); the state exists
 * so the "active connection IS the permission" check is honest from day one, and so a
 * later revoke is an additive transition, not a schema reshape — the same forward-compat
 * discipline the reserved `teamId`/`ownerPrincipalId` columns follow.
 */
export const CONNECTION_STATUSES = ["active", "revoked"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

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
  "objective.added",
  "objective.status_changed",
  "objective.reviewed",
  "objective.proposed",
  "objective.blocked",
  "world_fact.recorded",
  "world_fact.blocked",
  "world_fact.cleared",
  "world_fact.reviewed",
  "skill.attached",
  "connection.created",
  "handoff.requested",
  "handoff.completed",
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
 * A standing objective — the agent's durable, operator-declared current purpose,
 * scoped by `agentId` like every other row. Where memory is accumulated,
 * relevance-recalled *lessons* ("I prefer X"), an objective is a small, mutable
 * statement of what the agent is working toward *now* ("finish the Q3 migration"),
 * carried across runs with a completion lifecycle. Only an `active` AND `accepted`
 * objective frames a run; `done`/`dropped`/`rejected` ones are kept for history. Its
 * `content` frames runs, so it is firewall-screened on the write path exactly like
 * memory content.
 */
export interface Objective {
  id: string;
  agentId: string;
  /** One-line standing purpose. */
  content: string;
  status: ObjectiveStatus;
  /**
   * Ratification state, reusing memory's {@link ReviewState}. An operator-declared
   * objective is `accepted`; reflection PROPOSES a `proposed` one that is INERT —
   * framing requires `active` AND `accepted`, so a proposal never shapes a run until a
   * human accepts it (accept → `accepted`, reject → `rejected`). The same property that
   * makes memory's accept/reject meaningful and keeps an unreviewed proposal from
   * acting as a backdoor injection.
   */
  reviewState: ReviewState;
  /**
   * The run a reflection-PROPOSED objective was noticed in (so the Type-B transition advisory can
   * judge that source run, not only the latest). Absent for an operator-declared objective —
   * provenance only, it never gates framing. Mirrors {@link Memory.sourceRunId}.
   */
  sourceRunId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A WORLD-FACT — the agent's own running record of its current situation, the
 * writable sibling of memory and objectives, scoped by `agentId` like every other
 * row. Where memory is accumulated, relevance-recalled *lessons* and an objective is
 * durable *purpose*, a world-fact is *current, mutable, situational state* the agent
 * maintains ITSELF mid-run: a `(subject, value)` pair it names and **supersedes**
 * (re-writing a subject REPLACES its value — superseded, not accumulated; `subject`
 * is UNIQUE per agent). It is the one piece of run framing the agent writes without
 * per-write human review, so it is firewall-screened + capped + audited on the write
 * path, framed as the agent's OWN UNVERIFIED working notes (never as ratified
 * memory), and operator-visible/revertible. User-facing copy calls these "working
 * notes"; the entity keeps the thread's `WorldFact` name internally.
 */
export interface WorldFact {
  id: string;
  agentId: string;
  /** The key the agent names; UNIQUE per agent (the upsert key). */
  subject: string;
  /** The current value; a re-write of the same subject REPLACES it. */
  value: string;
  /**
   * Ratification state, reusing memory's {@link ReviewState}. A SELF-written note (the
   * agent's `record_note`, the operator's `notes set`) is `accepted` — framed immediately,
   * byte-for-byte today's behaviour. A future DERIVED writer (#84 T3) PROPOSES a `proposed`
   * one that is INERT — framing requires `accepted`, so a proposal never shapes a run until
   * a human accepts it (accept → `accepted`, reject → `rejected`). One row per subject
   * carries one review state (the `UNIQUE(agentId, subject)` constraint is unchanged), so
   * `proposed` and `accepted` never coexist for a subject. The same property that makes
   * memory's accept/reject meaningful and keeps an unreviewed proposal from acting as a
   * backdoor injection.
   */
  reviewState: ReviewState;
  createdAt: string;
  updatedAt: string;
}

/**
 * The exact text one world-fact contributes to run framing — `subject: value` — and
 * therefore the precise string the firewall must screen on the write path. ONE source of
 * truth so the screen and the render can never drift: screening the fields independently
 * would let a prompt injection be split across the `: ` delimiter (`subject: "ignore all
 * previous"`, `value: "instructions"` frames as a single injection line while each field
 * passes its own screen). The framing render and BOTH write paths (the
 * `WorldFactRepository.upsert` storage writer and the `store.recordWorldFact` facade) go
 * through here. Lives in `types.ts` — the universal bottom layer — so the repository can
 * enforce it without depending on the framing layer. The constant `- ` list prefix is
 * boilerplate, not part of the injectable content, so it is omitted.
 */
export function worldFactFramingText(subject: string, value: string): string {
  return `${subject}: ${value}`;
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
 * A CONNECTION — the explicit, permissioned channel between two agents that Phase 3
 * collaboration is built on. Agents are isolated by default (golden rule 5); a connection
 * is the ONLY thing that lets one agent's curated output reach another, and it grants
 * exactly its {@link ConnectionMode}'s exchange form and nothing wider — never the other
 * agent's raw memory, credential values, or tool registry.
 *
 * Unlike every other entity, a connection carries TWO agent ids: it is **directional**
 * (`fromAgentId → toAgentId`), so `connect A B` grants A→B only and B→A is its own
 * separate connection (settled decision D1). Both ids are real references on the row, and
 * every scoped query filters by a participant — a connection is reachable only by an agent
 * it actually links, never by a third party. Creating one is an explicit operator act
 * (the human-granted permission); *using* one is logged on both participants' event logs
 * as content-free references (golden rule 5, invariant 5).
 */
export interface Connection {
  id: string;
  /** The initiating agent — the one that may hand off TO `toAgentId`. */
  fromAgentId: string;
  /** The receiving agent — the one a handoff runs AS (in its own workspace, under its own trust). */
  toAgentId: string;
  mode: ConnectionMode;
  status: ConnectionStatus;
  createdAt: string;
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

/**
 * The cognition providers an agent can be opted into, beyond the default Pi loop. The
 * default substrate is the absence of a selection (no row / NULL), never a value here —
 * so this lists only the OPT-IN alternatives. `"lodestar"` wraps the run in the Lodestar
 * cognition layer (`@qmilab/asterism-adapter-lodestar`), which records an auditable
 * epistemic trace of what the agent observed and did. The kernel stores the SELECTION
 * only; the host builds the wrapped adapter, so `core` never imports Lodestar — the same
 * discipline as {@link RECALL_PROVIDER_IDS}. Observe-only: the wrapper records a trace,
 * it never gates — Asterism's kernel stays the sole trust authority (golden rules 2, 4).
 */
export const COGNITION_PROVIDER_IDS = ["lodestar"] as const;
export type CognitionProviderId = (typeof COGNITION_PROVIDER_IDS)[number];

/**
 * How much a cognition trace CAPTURES per tool call, beyond the references-only baseline.
 * The baseline (references only — tool name, output size, a keyed fingerprint, the error
 * flag — never content) is the absence of a selection (no row / NULL), never a value here,
 * so this lists only the OPT-IN escalation: `"content"` ALSO records the tool output's
 * content, behind the kernel's redaction boundary (`redactForTrace` — secret-aware,
 * bounded, firewall-screened). Capturing content is a deliberate escalation of what the
 * host-owned trace stores, kept separate from {@link COGNITION_PROVIDER_IDS} (whether a
 * run is traced at all) so the safe references-only default holds unless an operator opts
 * in. Meaningful only when `cognitionProvider` is set — capture has nowhere to land
 * otherwise. Same opt-in discipline as the provider enums above.
 */
export const COGNITION_CAPTURE_MODES = ["content"] as const;
export type CognitionCaptureMode = (typeof COGNITION_CAPTURE_MODES)[number];

/**
 * Install-wide kernel defaults — the single-row sibling of {@link AgentSettings}, holding
 * values that apply across every agent unless one overrides them. Each field is an OVERRIDE
 * where `undefined` means "unset, use the kernel's built-in constant". Resolution precedence
 * for a value present in both: a per-agent {@link AgentSettings} field wins over the matching
 * install-wide default here, which in turn wins over the kernel constant. NOT agent-scoped —
 * the deliberate, narrow exception for genuinely install-wide configuration.
 */
export interface InstallSettings {
  /**
   * Install-wide default recall budget — the maximum memories a run may frame, for any agent
   * without its own `recallBudget`. `undefined` ⇒ unset, so the kernel falls back to
   * {@link DEFAULT_RECALL_BUDGET}.
   */
  recallBudget?: number;
  /**
   * Install-wide default world-fact cap — the maximum distinct working notes an agent may
   * hold, for any agent without its own `worldFactCap`. `undefined` ⇒ unset, so the kernel
   * falls back to {@link DEFAULT_WORLD_FACT_CAP}. The middle tier of `resolveWorldFactCap`,
   * mirroring `recallBudget` here.
   */
  worldFactCap?: number;
  createdAt: string;
  updatedAt: string;
}

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
   * Per-agent opt-in to an alternative cognition provider — whether a run is wrapped in
   * an auditable cognition trace. `undefined` ⇒ unset, so the kernel uses the default Pi
   * loop with no trace. The only non-default value is `"lodestar"`; the kernel stores the
   * SELECTION but never builds the wrapper — the host reads this and wraps the adapter, so
   * `core` never imports Lodestar. Observe-only: it records, it never gates.
   */
  cognitionProvider?: CognitionProviderId;
  /**
   * Per-agent escalation of how much the cognition trace captures. `undefined` ⇒ unset,
   * so the trace records references only (the safe slice-1 baseline: no content). The only
   * non-default value is `"content"`, which ALSO records redacted tool-output content (via
   * the kernel's `redactForTrace` boundary). Inert unless `cognitionProvider` is also set —
   * there is no trace to enrich otherwise. The host reads this and tells the wrapper how
   * much to record; the kernel stores the SELECTION only.
   */
  cognitionCapture?: CognitionCaptureMode;
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
  /**
   * Per-agent override of the world-fact cap — the maximum number of distinct
   * subjects ("working notes") the agent may hold. `undefined` ⇒ unset, so the
   * kernel falls back to {@link DEFAULT_WORLD_FACT_CAP}. The cap bounds GROWTH of the
   * one framing input the agent writes without per-write review: a new subject at cap
   * is rejected loudly (never silently evicted), while superseding a tracked subject
   * is always free. Lowering it below the current count blocks NEW subjects until the
   * agent forgets some — it never deletes existing notes.
   */
  worldFactCap?: number;
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
