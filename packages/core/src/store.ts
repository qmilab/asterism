import { randomBytes } from "node:crypto";

import type { SqlDriver } from "./db/driver.js";
import { openDatabase } from "./db/index.js";
import { SCHEMA } from "./db/schema.js";
import { AgentRepository } from "./repositories/agents.js";
import type { CreateAgentInput } from "./repositories/agents.js";
import { RunRepository } from "./repositories/runs.js";
import type { CreateRunInput } from "./repositories/runs.js";
import { MemoryRepository } from "./repositories/memories.js";
import type { CreateMemoryInput } from "./repositories/memories.js";
import { SkillRepository } from "./repositories/skills.js";
import type { CreateSkillInput } from "./repositories/skills.js";
import { ObjectiveRepository } from "./repositories/objectives.js";
import type { ObjectiveQuery } from "./repositories/objectives.js";
import { CredentialRepository } from "./repositories/credentials.js";
import { CapabilityStandingRepository } from "./repositories/capability-standing.js";
import { AgentSettingsRepository } from "./repositories/agent-settings.js";
import type {
  Agent,
  AgentSettings,
  CapabilityGrant,
  CapabilityStanding,
  Credential,
  EventType,
  Memory,
  Objective,
  ObjectiveStatus,
  ReviewState,
  RecallProviderId,
  Run,
  RunStatus,
  Skill,
  StandingThresholds,
  TrustLevel,
} from "./types.js";
import type { ReflectionRunTally } from "./reflection.js";
import { EventRepository } from "./repositories/events.js";
import { RESERVED_SECRET_PREFIX, SecretStore, secretValueRef } from "./secrets.js";
import { MemoryFirewallError } from "./firewall.js";

/**
 * The kernel's persistence surface. Applies the Phase 0 schema and exposes one
 * repository per entity. Every scoped repository asserts an `agentId` before it
 * touches the driver — the agent is the isolation boundary.
 */
export class AsterismStore {
  readonly agents: AgentRepository;
  readonly runs: RunRepository;
  readonly memories: MemoryRepository;
  readonly skills: SkillRepository;
  /** Per-agent standing objectives — the agent's durable, operator-declared purpose. */
  readonly objectives: ObjectiveRepository;
  readonly credentials: CredentialRepository;
  /** Per-capability earned standing — the agent's "trust contracts". */
  readonly capabilityStanding: CapabilityStandingRepository;
  /** Per-agent kernel settings — the operator-configurable tunables (e.g. recall budget). */
  readonly agentSettings: AgentSettingsRepository;
  /** The local plaintext-bearing secret store; credentials reference into it. */
  readonly secrets: SecretStore;
  readonly events: EventRepository;

  constructor(private readonly driver: SqlDriver) {
    this.driver.exec(SCHEMA);
    this.migrate();
    this.agents = new AgentRepository(driver);
    this.runs = new RunRepository(driver);
    this.memories = new MemoryRepository(driver);
    this.skills = new SkillRepository(driver);
    this.objectives = new ObjectiveRepository(driver);
    this.credentials = new CredentialRepository(driver);
    this.capabilityStanding = new CapabilityStandingRepository(driver);
    this.agentSettings = new AgentSettingsRepository(driver);
    this.secrets = new SecretStore(driver);
    this.events = new EventRepository(driver);
  }

  // --- Schema migration ------------------------------------------------------
  //
  // Phase 0 has no migration framework, and `CREATE TABLE IF NOT EXISTS` cannot
  // add a column to a table that already exists. So a column introduced after a
  // database was first created (e.g. `runs.output`) would be missing on that
  // database, and the first write to it would throw "no such column". These
  // additive, idempotent steps bring an older schema up to date on open. Fresh
  // databases already have the column from SCHEMA, so each step is a no-op there.

  private migrate(): void {
    if (!this.columnExists("runs", "output")) {
      this.driver.exec(`ALTER TABLE runs ADD COLUMN output TEXT`);
    }
    // The per-run reflection claim (`reflected_at`) joined `runs` with the
    // reflection-scheduling slice, so a database created before it has the column
    // missing. Add it idempotently; a NULL default means every existing run reads as
    // "not yet reflected", which is the correct starting state.
    if (!this.columnExists("runs", "reflected_at")) {
      this.driver.exec(`ALTER TABLE runs ADD COLUMN reflected_at TEXT`);
    }
    // The earned-standing thresholds joined `agent_settings` after it first shipped
    // (with only `recall_budget`), so a database created by that release has the
    // table but not these columns. Add them, idempotently, for those databases; a
    // fresh database already has them from SCHEMA, so each step is a no-op there.
    if (!this.columnExists("agent_settings", "min_clean_executions")) {
      this.driver.exec(`ALTER TABLE agent_settings ADD COLUMN min_clean_executions INTEGER`);
    }
    if (!this.columnExists("agent_settings", "min_distinct_targets")) {
      this.driver.exec(`ALTER TABLE agent_settings ADD COLUMN min_distinct_targets INTEGER`);
    }
    // The opt-in recall-provider selection joined `agent_settings` after it shipped,
    // so an older database has the table but not this column. Add it idempotently; a
    // NULL default means every existing agent reads as "use the built-in lexical
    // ranker", which is the correct, unchanged starting state.
    if (!this.columnExists("agent_settings", "recall_provider")) {
      this.driver.exec(`ALTER TABLE agent_settings ADD COLUMN recall_provider TEXT`);
    }
  }

  /** Whether `table` has a column named `column` (via PRAGMA table_info). */
  private columnExists(table: string, column: string): boolean {
    // `table` is always a hard-coded literal here, never user input — PRAGMA does
    // not accept a bound parameter for the table name.
    const rows = this.driver.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => String(r.name) === column);
  }

  // --- Audited orchestration -------------------------------------------------
  //
  // The kernel — not the surface — decides what lands in the event log. These
  // methods pair a consequential write with its `agentId`-scoped Event so the CLI
  // and HTTP surface get a populated, append-only log just by calling the kernel
  // (they hold no business logic). Each emits REFERENCES ONLY: keys, refs, ids,
  // enum values — never a secret value, never raw content. Repositories stay pure
  // single-table writes; auditing lives here, one layer up.

  /** Append a kernel event, narrowing `type` to the canonical vocabulary. */
  private emit(
    agentId: string,
    type: EventType,
    payload: unknown,
    runId?: string,
  ): void {
    this.events.append(agentId, {
      type,
      payload,
      ...(runId !== undefined ? { runId } : {}),
    });
  }

  /** Create an agent and record `agent.created` (scoped to the new agent's id). */
  createAgent(input: CreateAgentInput): Agent {
    return this.driver.transaction(() => {
      const agent = this.agents.create(input);
      this.emit(agent.id, "agent.created", {
        name: agent.name,
        role: agent.role,
        trustLevel: agent.trustLevel,
      });
      return agent;
    });
  }

  /** Change an agent's trust level and record the ramp as `agent.trust_changed`. */
  setTrust(agentId: string, level: TrustLevel): Agent {
    return this.driver.transaction(() => {
      const from = this.agents.get(agentId)?.trustLevel ?? null;
      const agent = this.agents.setTrustLevel(agentId, level);
      this.emit(agentId, "agent.trust_changed", { from, to: agent.trustLevel });
      return agent;
    });
  }

  /**
   * Set one capability's earned standing for an agent and record the transition as
   * `agent.standing_changed` — the audit trail the trust model needs: WHICH
   * capability, the `from`/`to` standing, and the references-only `basis` (counts
   * of the evidence, never an action's arguments). A human ratification grants
   * (`gated` → `standing-grant`); a regression or operator revoke downgrades
   * (`standing-grant` → `gated`). `from` is the capability's prior standing, or its
   * implicit `gated` when it had no row yet. Pass the originating `runId` when the
   * change came out of a run (e.g. an automatic revoke after a failure) so the event
   * ties back to it.
   */
  setCapabilityStanding(
    agentId: string,
    capability: string,
    standing: CapabilityStanding,
    basis: string,
    runId?: string,
  ): CapabilityGrant {
    return this.driver.transaction(() => {
      const from = this.capabilityStanding.get(agentId, capability)?.standing ?? "gated";
      const grant = this.capabilityStanding.setStanding(agentId, capability, standing, basis);
      this.emit(
        agentId,
        "agent.standing_changed",
        { capability, from, to: grant.standing, basis },
        runId,
      );
      return grant;
    });
  }

  /**
   * Set an agent's per-agent recall budget and record the change as
   * `agent.setting_changed` — the audit trail for an operator tuning how much memory
   * frames the agent's runs: which `setting`, and the `from`/`to` values (a config
   * count, never an action's arguments, so the log stays references-only). `from` is
   * the prior override, or null when it was unset (running on the kernel default). The
   * repository validates a positive whole number at the write boundary.
   */
  setRecallBudget(agentId: string, budget: number): AgentSettings {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getRecallBudget(agentId) ?? null;
      // An unchanged value is a true no-op — no write, no phantom event. The event log
      // records real transitions only (the same discipline as `clearRecallBudget`'s
      // guard below). `from === budget` means a row already holds this exact value,
      // which — being a stored budget — was already validated, so skipping the write is
      // safe. Any invalid `budget` cannot equal a stored value, so it still reaches the
      // repository's write-boundary validation and throws.
      if (from === budget) {
        const existing = this.agentSettings.get(agentId);
        if (existing) return existing;
      }
      const settings = this.agentSettings.setRecallBudget(agentId, budget);
      this.emit(agentId, "agent.setting_changed", {
        setting: "recallBudget",
        from,
        to: settings.recallBudget ?? null,
      });
      return settings;
    });
  }

  /**
   * Clear an agent's recall-budget override, returning it to the kernel default, and
   * record the change as `agent.setting_changed` (`to: null`). A no-op when the agent
   * had no override set: nothing changes, so nothing is logged — the returned row is
   * undefined, telling the caller there was nothing to clear. Mirrors the asymmetry of
   * `setCapabilityStanding`'s revoke: only a real transition lands on the record.
   */
  clearRecallBudget(agentId: string): AgentSettings | undefined {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getRecallBudget(agentId) ?? null;
      // Nothing set is a true no-op — no write, no event — symmetric with
      // `setRecallBudget`. Return whatever row exists (a NULL-budget row, or none).
      if (from === null) return this.agentSettings.get(agentId);
      const settings = this.agentSettings.clearRecallBudget(agentId);
      this.emit(agentId, "agent.setting_changed", {
        setting: "recallBudget",
        from,
        to: null,
      });
      return settings;
    });
  }

  /**
   * Set an agent's opt-in recall provider and record the change as
   * `agent.setting_changed` — the audit trail for an operator switching how an agent
   * ranks its memory: the `setting`, and the `from`/`to` selection (an enum value, never
   * an action's arguments, so the log stays references-only). `from` is the prior
   * selection, or null when it was unset (running on the built-in lexical ranker). The
   * repository validates the id against the known set at the write boundary. An
   * unchanged value is a true no-op — no write, no phantom event — the same discipline
   * as {@link setRecallBudget}.
   */
  setRecallProvider(agentId: string, provider: RecallProviderId): AgentSettings {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getRecallProvider(agentId) ?? null;
      if (from === provider) {
        const existing = this.agentSettings.get(agentId);
        if (existing) return existing;
      }
      const settings = this.agentSettings.setRecallProvider(agentId, provider);
      this.emit(agentId, "agent.setting_changed", {
        setting: "recallProvider",
        from,
        to: settings.recallProvider ?? null,
      });
      return settings;
    });
  }

  /**
   * Clear an agent's recall-provider override, returning it to the built-in lexical
   * ranker, and record the change as `agent.setting_changed` (`to: null`). A no-op when
   * the agent had no override set: nothing changes, so nothing is logged, and the
   * returned row is undefined — symmetric with {@link clearRecallBudget}.
   */
  clearRecallProvider(agentId: string): AgentSettings | undefined {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getRecallProvider(agentId) ?? null;
      if (from === null) return this.agentSettings.get(agentId);
      const settings = this.agentSettings.clearRecallProvider(agentId);
      this.emit(agentId, "agent.setting_changed", {
        setting: "recallProvider",
        from,
        to: null,
      });
      return settings;
    });
  }

  /**
   * Set an agent's earned-standing thresholds (the bar a destructive capability must
   * clear to be PROPOSED for an auto-approve grant), recording each genuine change as
   * `agent.setting_changed` — references only (a config count, never an action's
   * arguments). Only the provided fields are written, and only a real transition is
   * logged: a field set to its current value writes and records nothing, the same
   * discipline as `setRecallBudget`. An invalid value cannot equal a stored
   * (already-validated) one, so it still reaches the repository's write-boundary
   * validation and throws. Throws if no threshold is provided.
   */
  setStandingThresholds(agentId: string, thresholds: StandingThresholds): AgentSettings {
    if (thresholds.minCleanExecutions === undefined && thresholds.minDistinctTargets === undefined) {
      throw new Error("no standing thresholds to set");
    }
    return this.driver.transaction(() => {
      const before = this.agentSettings.getStandingThresholds(agentId);
      // Narrow to the fields that genuinely change — an unchanged value is a true
      // no-op (no write, no phantom event).
      const changes: StandingThresholds = {};
      if (
        thresholds.minCleanExecutions !== undefined &&
        thresholds.minCleanExecutions !== before.minCleanExecutions
      ) {
        changes.minCleanExecutions = thresholds.minCleanExecutions;
      }
      if (
        thresholds.minDistinctTargets !== undefined &&
        thresholds.minDistinctTargets !== before.minDistinctTargets
      ) {
        changes.minDistinctTargets = thresholds.minDistinctTargets;
      }
      if (changes.minCleanExecutions === undefined && changes.minDistinctTargets === undefined) {
        const existing = this.agentSettings.get(agentId);
        if (existing) return existing;
      }

      const settings = this.agentSettings.setStandingThresholds(agentId, changes);
      if (changes.minCleanExecutions !== undefined) {
        this.emit(agentId, "agent.setting_changed", {
          setting: "minCleanExecutions",
          from: before.minCleanExecutions ?? null,
          to: settings.minCleanExecutions ?? null,
        });
      }
      if (changes.minDistinctTargets !== undefined) {
        this.emit(agentId, "agent.setting_changed", {
          setting: "minDistinctTargets",
          from: before.minDistinctTargets ?? null,
          to: settings.minDistinctTargets ?? null,
        });
      }
      return settings;
    });
  }

  /**
   * Clear an agent's earned-standing threshold overrides, returning that capability
   * bar to the kernel default, and record one `agent.setting_changed` (`to: null`)
   * per field that was actually set. A no-op when neither was set: nothing changes,
   * nothing is logged, and the returned row is whatever already existed (or
   * undefined) — symmetric with `clearRecallBudget`.
   */
  clearStandingThresholds(agentId: string): AgentSettings | undefined {
    return this.driver.transaction(() => {
      const before = this.agentSettings.getStandingThresholds(agentId);
      if (before.minCleanExecutions === undefined && before.minDistinctTargets === undefined) {
        return this.agentSettings.get(agentId);
      }
      const settings = this.agentSettings.clearStandingThresholds(agentId);
      if (before.minCleanExecutions !== undefined) {
        this.emit(agentId, "agent.setting_changed", {
          setting: "minCleanExecutions",
          from: before.minCleanExecutions,
          to: null,
        });
      }
      if (before.minDistinctTargets !== undefined) {
        this.emit(agentId, "agent.setting_changed", {
          setting: "minDistinctTargets",
          from: before.minDistinctTargets,
          to: null,
        });
      }
      return settings;
    });
  }

  /** Start a run and record `run.started`, stamping the run id onto the event. */
  startRun(agentId: string, input: CreateRunInput): Run {
    return this.driver.transaction(() => {
      const run = this.runs.create(agentId, input);
      this.emit(agentId, "run.started", { runId: run.id, status: run.status }, run.id);
      return run;
    });
  }

  /**
   * Transition a run's status and record `run.status_changed` (e.g. the
   * destructive-action gate flipping a run to `awaiting_confirmation`). A
   * cross-agent or unknown run touches nothing and emits nothing.
   */
  setRunStatus(
    agentId: string,
    runId: string,
    status: RunStatus,
  ): Run | undefined {
    return this.driver.transaction(() => {
      const from = this.runs.get(agentId, runId)?.status ?? null;
      const run = this.runs.setStatus(agentId, runId, status);
      if (run) {
        this.emit(agentId, "run.status_changed", { runId, from, to: run.status }, runId);
      }
      return run;
    });
  }

  /**
   * Finish a run: persist its output transcript AND its terminal status in ONE
   * transaction, recording the status transition as `run.status_changed`. Output
   * is CONTENT, not an event payload (the log stays reference-only), so it rides
   * the same transaction as the status flip but is never itself logged — keeping
   * output and status from drifting if the process dies between two writes, which
   * a raw repo call from the surface could not guarantee.
   */
  finishRun(
    agentId: string,
    runId: string,
    output: string,
    status: RunStatus,
  ): Run | undefined {
    return this.driver.transaction(() => {
      const from = this.runs.get(agentId, runId)?.status ?? null;
      this.runs.setOutput(agentId, runId, output);
      const run = this.runs.setStatus(agentId, runId, status);
      if (run) {
        this.emit(agentId, "run.status_changed", { runId, from, to: run.status }, runId);
      }
      return run;
    });
  }

  /**
   * Persist a run's output transcript WITHOUT changing its status — for a run that
   * paused (`awaiting_confirmation`) yet still produced text worth reflecting on
   * later. Content only; emits no event (the log records references, never run
   * content). Goes through the store so the surface never reaches the repo
   * directly for a consequential write.
   */
  recordRunOutput(agentId: string, runId: string, output: string): Run | undefined {
    return this.driver.transaction(() => this.runs.setOutput(agentId, runId, output));
  }

  /**
   * Atomically CLAIM a paused run for resume — a single compare-and-set from
   * `awaiting_confirmation` to `running` (see {@link RunRepository.claimForResume}).
   * Returns the now-`running` run to the caller that won the claim, or undefined to
   * one that did NOT — the run was unknown, already terminal, or already claimed by
   * a concurrent confirm. That single-winner guarantee SERIALIZES confirms: only the
   * owner re-enters the loop, so two racing confirms can never both execute the
   * confirmed destructive action.
   *
   * A resume claims BEFORE reconstructing its approval state, so the reconstruction
   * reads the event log under exclusive ownership — after any prior confirm's
   * executions have committed — and so can never act on stale counts. The grant
   * itself is recorded separately via {@link recordRunResumed} once reconstructed.
   */
  claimRunForResume(agentId: string, runId: string): Run | undefined {
    return this.driver.transaction(() => this.runs.claimForResume(agentId, runId));
  }

  /**
   * Record a resume's grant as `run.resumed`, once the caller has CLAIMED the run
   * (via {@link claimRunForResume}) and reconstructed what it authorizes. The
   * dedicated event (not a bare `run.status_changed`) is the audit record the trust
   * model needs: `confirmed` names the destructive capabilities this resume permits
   * (for a human reading the log), and `granted` carries the same as per-invocation
   * references (capability + a one-way arguments fingerprint + how many) that the
   * NEXT confirm reads back to know what is already approved. Both are references
   * only — never the action's args. The caller already owns the run, so this just
   * appends the audit record.
   */
  recordRunResumed(
    agentId: string,
    runId: string,
    confirmed: readonly string[],
    granted: readonly { capability: string; fingerprint: string; count: number }[],
  ): void {
    this.emit(
      agentId,
      "run.resumed",
      { runId, from: "awaiting_confirmation", confirmed, granted },
      runId,
    );
  }

  /**
   * Decline a paused run: atomically flip `awaiting_confirmation` → `failed` and
   * record `run.declined`. The counterpart to a confirm — the operator refused a
   * destructive action, so the run ends without it ever executing. The compare-and-set
   * ({@link RunRepository.claimForDecline}) is the race guard: it serializes against a
   * concurrent confirm's claim, so exactly one wins, and unlike a resume it PRESERVES
   * the run's `output` (a transcript produced before the gate paused it survives, so a
   * declined run stays reflectable and listed with its text). Returns undefined — and
   * emits nothing — when the run is unknown, cross-agent, or no longer awaiting
   * confirmation, which is how the caller (`declineRun` in run.ts) tells those apart.
   */
  declineRun(agentId: string, runId: string): Run | undefined {
    return this.driver.transaction(() => {
      const run = this.runs.claimForDecline(agentId, runId);
      if (run) {
        this.emit(agentId, "run.declined", { runId, from: "awaiting_confirmation" }, runId);
      }
      return run;
    });
  }

  /**
   * Record a memory through the firewall, logging the outcome either way. On
   * success: `memory.recorded` (references only — id/type/reviewState, never the
   * content). On a firewall refusal: `memory.blocked` (the findings, never the
   * blocked content) — committed independently, then the error rethrows, so the
   * refusal stays on the record. Not wrapped in a transaction for exactly that
   * reason: a rollback would erase the very audit trail of the block.
   */
  recordMemory(agentId: string, input: CreateMemoryInput): Memory {
    const runId = input.sourceRunId;
    let memory: Memory;
    try {
      memory = this.memories.create(agentId, input);
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        this.emit(
          agentId,
          "memory.blocked",
          { memoryType: input.memoryType, findings: err.findings },
          runId,
        );
      }
      throw err;
    }
    this.emit(
      agentId,
      "memory.recorded",
      {
        memoryId: memory.id,
        memoryType: memory.memoryType,
        reviewState: memory.reviewState,
        confidence: memory.confidence,
      },
      runId,
    );
    return memory;
  }

  /**
   * Settle a PROPOSED memory — the human's accept/reject of a queued proposal — via a
   * single compare-and-set ({@link MemoryRepository.settleProposed}) and record the
   * transition as `memory.reviewed` (references only: the memory id and the `from`/`to`
   * states, never the content). The review queue a scheduled `reflect --propose` fills is
   * drained through here: accepting flips `proposed → accepted`, rejecting flips
   * `proposed → rejected`. The CAS is the race guard — two surfaces draining one proposal
   * (a CLI `reflect --review` and the dashboard, say) cannot both win, so a rejected
   * proposal can never be resurrected to accepted by a racing accept. `from` is always
   * `proposed` (the only state the CAS transitions from). Returns the settled row to the
   * winner — stamping the originating `runId` on the event when the memory carries one — or
   * undefined to a caller that lost the race or named an unknown / already-settled id, in
   * which case nothing changes and nothing is logged.
   */
  settleProposedMemory(
    agentId: string,
    id: string,
    reviewState: ReviewState,
  ): Memory | undefined {
    return this.driver.transaction(() => {
      const memory = this.memories.settleProposed(agentId, id, reviewState);
      if (memory) {
        this.emit(
          agentId,
          "memory.reviewed",
          { memoryId: memory.id, from: "proposed", to: memory.reviewState },
          memory.sourceRunId,
        );
      }
      return memory;
    });
  }

  /**
   * Accept a queued proposal WITH AN EDIT, atomically. In ONE transaction it CAS-claims the
   * original out of the queue (`proposed → rejected`, recording `memory.reviewed`) and records
   * the edited content as a fresh `active + accepted` memory (recording `memory.recorded`).
   * Atomic so the two writes cannot tear: if the record fails, the claim rolls back and the
   * proposal stays in the queue — never silently lost. Claiming the original FIRST is what
   * stops two concurrent edited-accepts from yielding two accepted memories: only the CAS
   * winner records; a loser gets undefined and writes nothing. The caller has already screened
   * `content` through the firewall (the hard gate) before calling — identical content, so the
   * create's own screen cannot newly block it here. Returns the new accepted memory, or
   * undefined when the CAS lost (a concurrent drain already settled the proposal).
   */
  acceptEditedProposal(agentId: string, current: Memory, content: string): Memory | undefined {
    return this.driver.transaction(() => {
      const claimed = this.memories.settleProposed(agentId, current.id, "rejected");
      if (!claimed) return undefined;
      this.emit(
        agentId,
        "memory.reviewed",
        { memoryId: claimed.id, from: "proposed", to: claimed.reviewState },
        claimed.sourceRunId,
      );
      const memory = this.memories.create(agentId, {
        memoryType: current.memoryType,
        content,
        confidence: current.confidence,
        ...(current.sourceRunId !== undefined ? { sourceRunId: current.sourceRunId } : {}),
        reviewState: "accepted",
        status: "active",
      });
      this.emit(
        agentId,
        "memory.recorded",
        {
          memoryId: memory.id,
          memoryType: memory.memoryType,
          reviewState: memory.reviewState,
          confidence: memory.confidence,
        },
        memory.sourceRunId,
      );
      return memory;
    });
  }

  /**
   * Atomically CLAIM a run for reflection — a single compare-and-set stamping
   * `reflected_at` only if still NULL (see {@link RunRepository.claimForReflection}).
   * Returns the claimed run to the caller that won, or undefined to one that lost (the
   * run was already reflected by a concurrent `reflect --propose`, or is unknown /
   * cross-agent). The single-winner guarantee is what serializes overlapping proposers:
   * only the claim owner queues a run's proposals, so the same run is never double-queued.
   */
  claimRunForReflection(agentId: string, runId: string): Run | undefined {
    return this.driver.transaction(() => this.runs.claimForReflection(agentId, runId));
  }

  /**
   * Release a reflection claim (clear `reflected_at`) so the run is reflectable again —
   * used when the model call for a just-claimed run fails, so a transient failure is
   * retried rather than dropping the run's reflection.
   */
  releaseRunReflection(agentId: string, runId: string): void {
    this.driver.transaction(() => this.runs.releaseReflection(agentId, runId));
  }

  /**
   * Record that a non-interactive `reflect --propose` has reflected on `runId` — a
   * references-only `reflection.proposed` marker carrying the per-run tally (how many
   * proposals were queued / withheld / already-known / ignored), never any content. This
   * marker is what makes re-ticks idempotent: the next `--propose` reads these events to
   * skip the runs it has already processed, so a repeating timer never re-proposes the
   * same run. The same flight-recorder pattern the earned-standing reader uses — no new
   * durable proposer state, just an entry in the append-only log. Emit-only (no row to
   * write), so it is not wrapped in a transaction, mirroring {@link recordRunResumed}.
   */
  recordReflectionProposed(agentId: string, runId: string, tally: ReflectionRunTally): void {
    this.emit(
      agentId,
      "reflection.proposed",
      {
        runId,
        queued: tally.queued,
        withheld: tally.withheld,
        alreadyKnown: tally.alreadyKnown,
        ignored: tally.ignored,
      },
      runId,
    );
  }

  /**
   * Declare a standing objective through the firewall, logging the outcome either
   * way. On success: `objective.added` (references only — the objective id, NEVER the
   * content, consistent with `memory.recorded` logging id/type and never content). On
   * a firewall refusal: `objective.blocked` (the findings, never the blocked content)
   * — committed independently, then the error rethrows, so the refusal stays on the
   * record. Not wrapped in a transaction for exactly that reason: a rollback would
   * erase the audit trail of the block. The mirror of {@link recordMemory}, because an
   * objective frames runs and so is screened — and audited — exactly like memory.
   */
  createObjective(agentId: string, content: string): Objective {
    let objective: Objective;
    try {
      objective = this.objectives.create(agentId, { content });
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        this.emit(agentId, "objective.blocked", { findings: err.findings });
      }
      throw err;
    }
    this.emit(agentId, "objective.added", {
      objectiveId: objective.id,
      status: objective.status,
    });
    return objective;
  }

  /**
   * Advance a standing objective's lifecycle (`active` → `done` | `dropped`, or back)
   * and record `objective.status_changed` with the `from`/`to` references — the same
   * shape as `setRunStatus` / `setCapabilityStanding`, never the content. A no-op when
   * the status is unchanged: nothing is written, nothing is logged (the event log
   * records real transitions only, the same discipline as `setRecallBudget`). A
   * cross-agent or unknown objective touches nothing and emits nothing — returns
   * undefined, which the caller uses to tell those apart.
   */
  setObjectiveStatus(
    agentId: string,
    id: string,
    status: ObjectiveStatus,
  ): Objective | undefined {
    return this.driver.transaction(() => {
      const current = this.objectives.get(agentId, id);
      if (!current) return undefined;
      // Unchanged status is a true no-op — no write, no phantom event. `current.status`
      // is a stored (already-validated) value, so an invalid `status` can never equal
      // it and still reaches the repository's write-boundary validation below.
      if (current.status === status) return current;
      const objective = this.objectives.setStatus(agentId, id, status);
      if (objective) {
        this.emit(agentId, "objective.status_changed", {
          objectiveId: id,
          from: current.status,
          to: objective.status,
        });
      }
      return objective;
    });
  }

  /** An agent's objectives for a surface to render, oldest-first, optionally filtered by status. */
  listObjectives(agentId: string, query?: ObjectiveQuery): Objective[] {
    return this.objectives.list(agentId, query);
  }

  /** Attach a markdown skill and record `skill.attached` (name + workspace path). */
  attachSkill(agentId: string, input: CreateSkillInput): Skill {
    return this.driver.transaction(() => {
      const skill = this.skills.create(agentId, input);
      this.emit(agentId, "skill.attached", {
        skillId: skill.id,
        name: skill.name,
        path: skill.path,
      });
      return skill;
    });
  }

  /**
   * Read a credential value for an agent, recording the disclosure as a
   * `secret.read` event — references only: the key and its `valueRef`, NEVER the
   * value. Reading a value is destructive under the trust model, so every
   * disclosure goes on the record. Returns undefined and logs nothing when no
   * secret exists under the key: reading nothing discloses nothing. This is the
   * audited counterpart to the raw {@link SecretStore.read} primitive — surfaces
   * and credential-bearing tool closures resolve values through here.
   */
  readSecret(agentId: string, key: string, runId?: string): string | undefined {
    return this.driver.transaction(() => {
      const value = this.secrets.readByKey(agentId, key);
      if (value !== undefined) {
        this.emit(
          agentId,
          "secret.read",
          { key, valueRef: secretValueRef(agentId, key) },
          runId,
        );
      }
      return value;
    });
  }

  /**
   * Add an agent-scoped credential: store the plaintext in the secret store and
   * record a credential row holding only the resulting `valueRef`. The plaintext
   * never reaches the credential table, an event, or the return value — the
   * caller gets back the reference-only {@link Credential}. This is the wiring
   * the CLI's `secrets add` sits on (Phase 0).
   */
  addCredential(agentId: string, key: string, value: string): Credential {
    return this.driver.transaction(() => {
      const prior = this.credentials.getByKey(agentId, key);
      const ref = this.secrets.issue(agentId, key, value);
      const cred = this.credentials.create(agentId, {
        key,
        valueRef: ref.valueRef,
      });
      // If this rotation repointed the credential away from a different (e.g.
      // non-default) backing ref, the old secret is now stale. Revoke it — unless
      // another credential still references it — so rotation never leaves stale
      // plaintext readable behind the previous ref.
      if (
        prior &&
        prior.valueRef !== cred.valueRef &&
        this.credentials.countByValueRef(agentId, prior.valueRef) === 0
      ) {
        this.secrets.deleteByRef(agentId, prior.valueRef);
      }
      // First set of a key is `added`; re-adding an existing key replaced its
      // value in place, so it's a `rotated`. References only — the key and the
      // new ref, never the plaintext.
      this.emit(agentId, prior ? "credential.rotated" : "credential.added", {
        key,
        valueRef: cred.valueRef,
      });
      return cred;
    });
  }

  /**
   * Remove an agent-scoped credential — the symmetric counterpart to
   * {@link addCredential}. Drops the credential metadata row AND its plaintext in
   * the secret store within one transaction, so the two tables can never drift:
   * there is no path that leaves a credential whose `valueRef` no longer resolves,
   * nor an orphaned secret. Returns true if a credential row existed.
   *
   * The secret dropped is the exact one the credential references — identified by
   * the row's stored `valueRef`, not by key — so a credential created with a
   * non-default ref has its real plaintext removed, and an unrelated standalone
   * secret that merely shares the key is left alone. The secret is revoked only
   * when no OTHER credential still references that ref, so removing one of two
   * credentials sharing a ref never orphans the survivor. When no credential row
   * exists this is a no-op returning false, touching no secret (a standalone
   * secret is removed via `secrets.delete`).
   */
  removeCredential(agentId: string, key: string): boolean {
    return this.driver.transaction(() => {
      const cred = this.credentials.getByKey(agentId, key);
      if (!cred) return false;
      this.credentials.deleteByKey(agentId, key);
      if (this.credentials.countByValueRef(agentId, cred.valueRef) === 0) {
        this.secrets.deleteByRef(agentId, cred.valueRef);
      }
      this.emit(agentId, "credential.removed", {
        key,
        valueRef: cred.valueRef,
      });
      return true;
    });
  }

  /**
   * The agent-scoped key for fingerprinting destructive-action arguments on a
   * pause (see `audit.ts` and `resumeRun`). Lazily generated and held in the
   * agent's secret store, so the fingerprint recorded on an `action.awaiting_
   * confirmation` event is a KEYED HMAC, not a bare hash: the event log can carry
   * it as a reference to the paused invocation without it becoming a dictionary
   * oracle on low-entropy arguments (a reader cannot hash candidate paths/commands
   * and match, because they lack this key). A reserved internal key, never a user
   * credential; reading it is the kernel using its own key, not surfacing a value
   * to the substrate. Its key sits in the kernel-reserved secret namespace, so a
   * user `secrets add` cannot rotate it and invalidate a paused run's fingerprints
   * (only `ensure`, used here, may write there — `issue` rejects reserved keys).
   */
  actionFingerprintKey(agentId: string): string {
    return this.secrets.ensure(
      agentId,
      `${RESERVED_SECRET_PREFIX}action_fingerprint_key`,
      randomBytes(32).toString("hex"),
    );
  }

  /** Open a store backed by a local SQLite database (in-memory by default). */
  static open(path?: string): AsterismStore {
    return new AsterismStore(openDatabase(path));
  }

  close(): void {
    this.driver.close();
  }
}
