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
import {
  WorldFactRepository,
  DEFAULT_WORLD_FACT_CAP,
  WorldFactCapError,
} from "./repositories/world-facts.js";
import { CredentialRepository } from "./repositories/credentials.js";
import { ConnectionRepository } from "./repositories/connections.js";
import { ExchangeRepository } from "./repositories/exchanges.js";
import { BriefRepository, BRIEF_CONNECTION_MODE } from "./repositories/briefs.js";
import { CapabilityStandingRepository } from "./repositories/capability-standing.js";
import { AgentSettingsRepository } from "./repositories/agent-settings.js";
import { InstallSettingsRepository } from "./repositories/install-settings.js";
import type {
  Agent,
  AgentSettings,
  Brief,
  CapabilityGrant,
  CapabilityStanding,
  Connection,
  ConnectionMode,
  Credential,
  Exchange,
  CognitionCaptureMode,
  CognitionProviderId,
  EventType,
  Memory,
  Objective,
  ObjectiveStatus,
  ReviewState,
  RunStatus,
  TransitionStatus,
  RecallProviderId,
  Run,
  Skill,
  StandingThresholds,
  TrustLevel,
  WorldFact,
} from "./types.js";
import type { ArtifactRef } from "./artifact-manifest.js";
import { artifactReference } from "./artifact-manifest.js";
import type { ReflectionRunTally } from "./reflection.js";
import { EventRepository } from "./repositories/events.js";
import { RESERVED_SECRET_PREFIX, SecretStore, secretValueRef } from "./secrets.js";
import { MemoryFirewallError, assertMemorySafe } from "./firewall.js";
import { worldFactFramingText } from "./types.js";

/**
 * The kernel's persistence surface. Applies the Phase 0 schema and exposes one
 * repository per entity. Every scoped repository asserts an `agentId` before it
 * touches the driver — the agent is the isolation boundary.
 */

/**
 * Internal rollback signal for {@link AsterismStore.setBrief}: the conditional INSERT
 * declined because the `shared-brief` grant did not hold at the moment of the write. Thrown
 * only to abort the surrounding transaction (so a supersede cannot commit without its
 * replacement) and caught in the same method — it never reaches a caller, which is why it
 * carries no message worth surfacing. A withdrawn channel is an ordinary outcome, not an
 * error, and the public method reports it as `undefined`.
 */
class BriefGrantWithdrawnError extends Error {}

export class AsterismStore {
  readonly agents: AgentRepository;
  readonly runs: RunRepository;
  readonly memories: MemoryRepository;
  readonly skills: SkillRepository;
  /** Per-agent standing objectives — the agent's durable, operator-declared purpose. */
  readonly objectives: ObjectiveRepository;
  /** Per-agent world-facts — the agent's own running record of the current situation ("working notes"). */
  readonly worldFacts: WorldFactRepository;
  readonly credentials: CredentialRepository;
  /** Explicit, permissioned channels between agents — the Phase 3 collaboration primitive. */
  readonly connections: ConnectionRepository;
  /** What actually crossed a connection, as resolvable references — the record `fetch` reads. */
  readonly exchanges: ExchangeRepository;
  /** Standing operator-authored briefs on `shared-brief` channels (Phase 3 · T3a). */
  readonly briefs: BriefRepository;
  /** Per-capability earned standing — the agent's "trust contracts". */
  readonly capabilityStanding: CapabilityStandingRepository;
  /** Per-agent kernel settings — the operator-configurable tunables (e.g. recall budget). */
  readonly agentSettings: AgentSettingsRepository;
  /** Install-wide kernel defaults — a single row, resolved BELOW a per-agent setting. */
  readonly installSettings: InstallSettingsRepository;
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
    this.worldFacts = new WorldFactRepository(driver);
    this.credentials = new CredentialRepository(driver);
    this.connections = new ConnectionRepository(driver);
    this.exchanges = new ExchangeRepository(driver);
    this.briefs = new BriefRepository(driver);
    this.capabilityStanding = new CapabilityStandingRepository(driver);
    this.agentSettings = new AgentSettingsRepository(driver);
    this.installSettings = new InstallSettingsRepository(driver);
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
    // `runs.exchange_connection_id` joined the table with connection revoke (§15, D19): a
    // resume must be able to find the grant its run arrived under. Add it idempotently; a
    // NULL default means every pre-existing run reads as "not from an exchange", which is the
    // correct and conservative backfill — a run recorded before this column existed records
    // no crossing on resume, exactly as it already did.
    if (!this.columnExists("runs", "exchange_connection_id")) {
      this.driver.exec(`ALTER TABLE runs ADD COLUMN exchange_connection_id TEXT`);
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
    // The cognition provider joined `agent_settings` last (thread 6: an opt-in auditable
    // trace). Add it idempotently; a NULL default means every existing agent reads as
    // "use the default Pi loop, no trace" — the correct, unchanged starting state.
    if (!this.columnExists("agent_settings", "cognition_provider")) {
      this.driver.exec(`ALTER TABLE agent_settings ADD COLUMN cognition_provider TEXT`);
    }
    // The cognition CAPTURE mode joined `agent_settings` after the provider (slice 2a: an
    // opt-in escalation to record redacted content, not just references). Add it
    // idempotently; a NULL default means every existing agent reads as "references only",
    // the unchanged, safe slice-1 starting state.
    if (!this.columnExists("agent_settings", "cognition_capture")) {
      this.driver.exec(`ALTER TABLE agent_settings ADD COLUMN cognition_capture TEXT`);
    }
    // The per-agent world-fact cap override joined `agent_settings` after it shipped
    // (#84 carry-forward: the cap was a kernel constant, now operator-configurable). Add
    // it idempotently; a NULL default means every existing agent reads as "use the kernel
    // DEFAULT_WORLD_FACT_CAP", the correct, unchanged starting state.
    if (!this.columnExists("agent_settings", "world_fact_cap")) {
      this.driver.exec(`ALTER TABLE agent_settings ADD COLUMN world_fact_cap INTEGER`);
    }
    // The install-wide world-fact cap default joined `install_settings` after that table
    // first shipped (with only `recall_budget`), filling the middle tier of
    // `resolveWorldFactCap` to match `resolveRecallBudget`'s three. Add it idempotently; a
    // NULL default means an existing install reads as "no install-wide default set", so
    // resolution falls through to the kernel DEFAULT_WORLD_FACT_CAP — the unchanged state.
    if (!this.columnExists("install_settings", "world_fact_cap")) {
      this.driver.exec(`ALTER TABLE install_settings ADD COLUMN world_fact_cap INTEGER`);
    }
    // `exchanges.size_bytes` joined that table WITHIN its own (unreleased) slice, once review
    // showed that a row carrying only a reference makes a once-exchanged PATH permanently
    // fetchable through later rewrites. No shipped release has this table, so this step only
    // catches a database created from an earlier build of the same branch — cheap, idempotent,
    // and it turns a confusing "no such column" into a no-op.
    if (!this.columnExists("exchanges", "size_bytes")) {
      this.driver.exec(`ALTER TABLE exchanges ADD COLUMN size_bytes INTEGER`);
    }
    // `exchanges.redacted` joined the same table one review round later, for the same
    // in-branch reason. DEFAULT 0 is the right backfill: an ordinary (unredacted) path is the
    // overwhelming case and must stay fetchable, and a pre-existing redacted row simply keeps
    // failing to resolve as it already did.
    if (!this.columnExists("exchanges", "redacted")) {
      this.driver.exec(`ALTER TABLE exchanges ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0`);
    }
    // The objective review state joined `objectives` after slice 1 first shipped the
    // table (reflection now PROPOSES objectives, gated by a review state). Add it
    // idempotently with DEFAULT 'accepted': every pre-existing objective was
    // operator-declared, hence implicitly ratified — so it stays framable. A constant
    // default (not NULL) is required because this column gates framing: every objective
    // must be definitively framable (`accepted`) or not, never ambiguous.
    if (!this.columnExists("objectives", "review_state")) {
      this.driver.exec(`ALTER TABLE objectives ADD COLUMN review_state TEXT NOT NULL DEFAULT 'accepted'`);
    }
    // source_run_id joined `objectives` for the Type-B transition advisory (#87): a queued
    // objective proposal carries the run it was noticed in, so the review's transition pass can
    // judge that source run, not just the latest. NULLABLE with NO default — unlike review_state
    // it is provenance only, never gates framing, so a pre-existing (operator-declared) objective
    // is correctly left NULL rather than backfilled.
    if (!this.columnExists("objectives", "source_run_id")) {
      this.driver.exec(`ALTER TABLE objectives ADD COLUMN source_run_id TEXT`);
    }
    // The world-fact review state joined `world_facts` after slice 3 first shipped the
    // table (#86: a future derived writer PROPOSES facts, gated by a review state). Add it
    // idempotently with DEFAULT 'accepted' — every pre-#86 world-fact was SELF-written,
    // hence implicitly ratified, so it stays framable. A constant default (not NULL) is
    // required because this column gates framing: every world-fact must be definitively
    // framable (`accepted`) or not, never ambiguous. The first `world_facts` ALTER (slice 3
    // noted "new table → no migrate ALTER needed; only later columns need that").
    if (!this.columnExists("world_facts", "review_state")) {
      this.driver.exec(`ALTER TABLE world_facts ADD COLUMN review_state TEXT NOT NULL DEFAULT 'accepted'`);
    }
    // World-fact COEXISTENCE (world-model.md §12). #86 shipped `world_facts` with a
    // table-level UNIQUE(agent_id, subject) — one row per subject — which forced the
    // conservative-skip (a proposed UPDATE could not coexist with the accepted note it
    // would supersede). Coexistence relaxes that to two PARTIAL unique indexes
    // (accepted-only, proposed-only). SQLite cannot DROP a table constraint, so an older
    // database is brought across with a one-time table REBUILD, run only while the
    // auto-created UNIQUE index is still present (PRAGMA index_list origin = 'u'). The
    // review_state ALTER above runs first, so the rebuild's INSERT…SELECT always finds the
    // column; no other table references `world_facts`, so dropping/renaming it cascades no
    // FK. A fresh database (built from SCHEMA, no table-level UNIQUE) skips the rebuild, and
    // after a rebuild there is no origin-'u' index, so re-opening is a no-op.
    //
    // The copy DROPS any pre-existing `rejected` rows: #86 shipped reject as a kept `rejected`
    // row, so a v0.3.0→#86 database can hold some — but coexistence makes reject a DISCARD, and
    // the new code assumes no `rejected` rows exist (formatting/`clear` ignore them while
    // `count()` still counts them, which would make a rejected-only note invisible, unclearable,
    // and a cap-slot leak). Filtering them here brings such a database to the coexistence
    // invariant. (A pure pre-#86 DB has only `accepted` rows after the ALTER above, so the
    // filter is a no-op there.) [Codex review: drop legacy rejected rows during migration.]
    if (this.hasAutoUniqueIndex("world_facts")) {
      this.driver.transaction(() => {
        this.driver.exec(
          `CREATE TABLE world_facts_new (
             id           TEXT PRIMARY KEY,
             agent_id     TEXT NOT NULL REFERENCES agents(id),
             subject      TEXT NOT NULL,
             value        TEXT NOT NULL,
             review_state TEXT NOT NULL,
             created_at   TEXT NOT NULL,
             updated_at   TEXT NOT NULL
           );
           INSERT INTO world_facts_new (id, agent_id, subject, value, review_state, created_at, updated_at)
             SELECT id, agent_id, subject, value, review_state, created_at, updated_at
               FROM world_facts WHERE review_state != 'rejected';
           DROP TABLE world_facts;
           ALTER TABLE world_facts_new RENAME TO world_facts;
           CREATE INDEX IF NOT EXISTS idx_world_facts_agent ON world_facts(agent_id);`,
        );
      });
    }
    // Create the two partial unique indexes (IF NOT EXISTS) for BOTH a fresh DB and a
    // rebuilt older one. They live here, not in SCHEMA, because their WHERE clause
    // references review_state — a column a v0.3.0 DB lacks until the ALTER above (SCHEMA
    // runs before migrate, so a partial index there would throw on an older DB). By here
    // the column is guaranteed and any table-level UNIQUE has been rebuilt away.
    this.driver.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_world_facts_accepted_subject
         ON world_facts(agent_id, subject) WHERE review_state = 'accepted';
       CREATE UNIQUE INDEX IF NOT EXISTS idx_world_facts_proposed_subject
         ON world_facts(agent_id, subject) WHERE review_state = 'proposed';`,
    );
  }

  /** Whether `table` has a column named `column` (via PRAGMA table_info). */
  private columnExists(table: string, column: string): boolean {
    // `table` is always a hard-coded literal here, never user input — PRAGMA does
    // not accept a bound parameter for the table name.
    const rows = this.driver.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => String(r.name) === column);
  }

  /**
   * Whether `table` carries an auto-created UNIQUE index implementing a table-level
   * UNIQUE(...) constraint (PRAGMA index_list `origin = 'u'`). A `CREATE [UNIQUE] INDEX`
   * has origin `'c'` and a PRIMARY KEY `'pk'`, so this is true ONLY when the constraint
   * is baked into the CREATE TABLE — the signal that a `world_facts` table predates the
   * coexistence rebuild and still forbids a proposed/accepted row coexisting per subject.
   * `table` is a hard-coded literal (PRAGMA takes no bound table parameter).
   */
  private hasAutoUniqueIndex(table: string): boolean {
    const rows = this.driver.prepare(`PRAGMA index_list(${table})`).all();
    return rows.some((r) => String(r.origin) === "u");
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
   * Set an agent's per-agent world-fact cap and record the change as
   * `agent.setting_changed` — the audit trail for an operator tuning how many distinct
   * working notes the agent may accumulate. References only (the `setting`, `from`, `to`
   * counts — never a note's content). `from` is the prior override, or null when it was
   * unset (running on {@link DEFAULT_WORLD_FACT_CAP}). The repository validates a positive
   * whole number at the write boundary. The direct analogue of {@link setRecallBudget},
   * including the unchanged-value no-op short-circuit.
   */
  setWorldFactCap(agentId: string, cap: number): AgentSettings {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getWorldFactCap(agentId) ?? null;
      // An unchanged value is a true no-op — no write, no phantom event (the same
      // discipline as `setRecallBudget`). A stored cap was already validated, so skipping
      // the write is safe; any invalid `cap` cannot equal a stored value, so it still
      // reaches the repository's write-boundary validation and throws.
      if (from === cap) {
        const existing = this.agentSettings.get(agentId);
        if (existing) return existing;
      }
      const settings = this.agentSettings.setWorldFactCap(agentId, cap);
      this.emit(agentId, "agent.setting_changed", {
        setting: "worldFactCap",
        from,
        to: settings.worldFactCap ?? null,
      });
      return settings;
    });
  }

  /**
   * Clear an agent's world-fact cap override, returning it to the kernel default, and
   * record the change as `agent.setting_changed` (`to: null`). A no-op when the agent had
   * no override set: nothing changes, so nothing is logged — the returned row is
   * undefined, telling the caller there was nothing to clear. Symmetric with
   * {@link clearRecallBudget}.
   */
  clearWorldFactCap(agentId: string): AgentSettings | undefined {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getWorldFactCap(agentId) ?? null;
      if (from === null) return this.agentSettings.get(agentId);
      const settings = this.agentSettings.clearWorldFactCap(agentId);
      this.emit(agentId, "agent.setting_changed", {
        setting: "worldFactCap",
        from,
        to: null,
      });
      return settings;
    });
  }

  /**
   * The agent's EFFECTIVE world-fact cap, in precedence order:
   *
   *   1. the agent's own per-agent override (`agent_settings.world_fact_cap`), else
   *   2. the install-wide default (`install_settings.world_fact_cap`), else
   *   3. the kernel's built-in constant ({@link DEFAULT_WORLD_FACT_CAP}).
   *
   * The single source of truth for "how many distinct working notes may this agent hold",
   * owned by the kernel so the two write-path enforcement sites ({@link recordWorldFact},
   * {@link proposeWorldFact}) and every surface that displays the cap read the same number.
   * The three tiers mirror {@link resolveRecallBudget} exactly: the per-agent read is
   * `agentId`-scoped, so an agent's own override is resolved only from its own setting, and
   * the install-wide row carries no agent data.
   */
  resolveWorldFactCap(agentId: string): number {
    const perAgent = this.agentSettings.getWorldFactCap(agentId);
    if (perAgent !== undefined) return perAgent;
    const installDefault = this.installSettings.getWorldFactCap();
    if (installDefault !== undefined) return installDefault;
    return DEFAULT_WORLD_FACT_CAP;
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
   * Set an agent's opt-in cognition provider and record the change as
   * `agent.setting_changed` — the audit trail for an operator switching how a run is
   * traced: the `setting`, and the `from`/`to` selection (an enum value, never an action's
   * arguments, so the log stays references-only). `from` is the prior selection, or null
   * when it was unset (the default Pi loop, no trace). The repository validates the id
   * against the known set at the write boundary. An unchanged value is a true no-op — no
   * write, no phantom event — the same discipline as {@link setRecallProvider}.
   */
  setCognitionProvider(agentId: string, provider: CognitionProviderId): AgentSettings {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getCognitionProvider(agentId) ?? null;
      if (from === provider) {
        const existing = this.agentSettings.get(agentId);
        if (existing) return existing;
      }
      const settings = this.agentSettings.setCognitionProvider(agentId, provider);
      this.emit(agentId, "agent.setting_changed", {
        setting: "cognitionProvider",
        from,
        to: settings.cognitionProvider ?? null,
      });
      return settings;
    });
  }

  /**
   * Clear an agent's cognition-provider override, returning it to the default Pi loop with
   * no trace, and record the change as `agent.setting_changed` (`to: null`). A no-op when
   * the agent had no override set: nothing changes, so nothing is logged, and the returned
   * row is undefined — symmetric with {@link clearRecallProvider}.
   */
  clearCognitionProvider(agentId: string): AgentSettings | undefined {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getCognitionProvider(agentId) ?? null;
      if (from === null) return this.agentSettings.get(agentId);
      const settings = this.agentSettings.clearCognitionProvider(agentId);
      this.emit(agentId, "agent.setting_changed", {
        setting: "cognitionProvider",
        from,
        to: null,
      });
      return settings;
    });
  }

  /**
   * Set an agent's cognition CAPTURE mode and record the change as `agent.setting_changed`
   * — the audit trail for an operator escalating how much the trace records (references →
   * redacted content): the `setting`, and the `from`/`to` selection (an enum value, never
   * an action's arguments, so the log stays references-only). `from` is the prior mode, or
   * null when it was the references-only default. The repository validates the id at the
   * write boundary. An unchanged value is a true no-op — the same discipline as
   * {@link setCognitionProvider}.
   */
  setCognitionCapture(agentId: string, mode: CognitionCaptureMode): AgentSettings {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getCognitionCapture(agentId) ?? null;
      if (from === mode) {
        const existing = this.agentSettings.get(agentId);
        if (existing) return existing;
      }
      const settings = this.agentSettings.setCognitionCapture(agentId, mode);
      this.emit(agentId, "agent.setting_changed", {
        setting: "cognitionCapture",
        from,
        to: settings.cognitionCapture ?? null,
      });
      return settings;
    });
  }

  /**
   * Clear an agent's cognition-capture escalation, returning it to the references-only
   * baseline (no content), and record the change as `agent.setting_changed` (`to: null`).
   * A no-op when the agent had no override set — symmetric with {@link clearCognitionProvider}.
   */
  clearCognitionCapture(agentId: string): AgentSettings | undefined {
    return this.driver.transaction(() => {
      const from = this.agentSettings.getCognitionCapture(agentId) ?? null;
      if (from === null) return this.agentSettings.get(agentId);
      const settings = this.agentSettings.clearCognitionCapture(agentId);
      this.emit(agentId, "agent.setting_changed", {
        setting: "cognitionCapture",
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

  /**
   * Start a run and record `run.started`, stamping the run id onto the event.
   *
   * This is the ORDINARY path, and it cannot mark a run as exchange-originated: the stamp is
   * not a field on {@link CreateRunInput}, so there is no property to set. Cross-agent runs
   * go through {@link startExchangeRun}.
   */
  startRun(agentId: string, input: CreateRunInput): Run {
    return this.driver.transaction(() => {
      const run = this.runs.create(agentId, input);
      this.emit(agentId, "run.started", { runId: run.id, status: run.status }, run.id);
      return run;
    });
  }

  /**
   * Start the CALLEE's run for a cross-agent exchange — the only path that can stamp a run
   * with the connection that asked for it.
   *
   * Everything about the run is DERIVED from the connection rather than passed alongside it,
   * which is what makes the stamp mean something at resume time:
   *
   *   - the agent is `connection.toAgentId`, so a run can never be attributed to a channel
   *     that does not run through it (no stamping agent X's run with a Y→Z connection);
   *   - the grant is re-asserted as LIVE here, so a stale or revoked connection object
   *     cannot start an exchange run at all.
   *
   * Returns `undefined` — rather than throwing — when the grant is not live. A withdrawal
   * landing in this window is an ORDINARY, expected race (another operator ran `disconnect`
   * a moment ago), not a broken invariant, and the exchange models that outcome already. An
   * exception here would turn a legitimate concurrent revoke into an internal error message
   * on a surface that has a perfectly good answer for it. [Codex review R4 P2.]
   *
   * Honest about the boundary this draws. A caller of the kernel API can still do kernel
   * things — `recordArtifactExchange` has always been able to write a crossing directly, and
   * that is what a kernel API is. What this removes is the ability to create one through
   * `startRun`, the general entry point every surface calls, where an `exchangeConnectionId`
   * property would look like bookkeeping rather than like granting a cross-agent read. The
   * claim is "not settable through the ordinary path", not "unforgeable" — an earlier version
   * of this slice asserted the latter, and it was not true. [Codex review R2 P2.]
   */
  startExchangeRun(connection: Connection, input: string): Run | undefined {
    return this.driver.transaction(() => {
      // The grant test is INSIDE the insert (`createForExchange`), not a read before it.
      // Checking first and inserting after leaves a window for another process's `disconnect`
      // to commit between the two — verified reachable — after which a run is created and
      // executed over a withdrawn channel. One statement removes the instant in which that
      // could happen. [Codex review R5 P2.]
      //
      // The callee is still DERIVED from the connection rather than passed, so a run can
      // never be attributed to a channel it does not sit on (R2).
      const run = this.runs.createForExchange(connection.toAgentId, input, connection.id);
      if (!run) return undefined;
      this.emit(
        connection.toAgentId,
        "run.started",
        { runId: run.id, status: run.status },
        run.id,
      );
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
   * way. On success: `objective.added` (references only — the objective id, status and
   * reviewState, NEVER the content, consistent with `memory.recorded` logging
   * id/type/reviewState and never content). On a firewall refusal: `objective.blocked`
   * (the findings, never the blocked content) — committed independently, then the error
   * rethrows, so the refusal stays on the record. Not wrapped in a transaction for
   * exactly that reason: a rollback would erase the audit trail of the block. The mirror
   * of {@link recordMemory}, because an objective frames runs and so is screened — and
   * audited — exactly like memory.
   *
   * `reviewState` defaults to `accepted` (the operator-declared CLI path). Reflection's
   * proposed-objective path passes `proposed`, so the row is inert (framing requires
   * `accepted`) until a human accepts it — and the `objective.added` audit shows it was
   * queued, not declared.
   */
  createObjective(
    agentId: string,
    content: string,
    reviewState?: ReviewState,
    sourceRunId?: string,
  ): Objective {
    let objective: Objective;
    try {
      objective = this.objectives.create(agentId, {
        content,
        ...(reviewState !== undefined ? { reviewState } : {}),
        ...(sourceRunId !== undefined ? { sourceRunId } : {}),
      });
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        this.emit(agentId, "objective.blocked", { findings: err.findings });
      }
      throw err;
    }
    this.emit(agentId, "objective.added", {
      objectiveId: objective.id,
      status: objective.status,
      reviewState: objective.reviewState,
    });
    return objective;
  }

  /**
   * Settle a PROPOSED objective — the human's accept/reject of a reflection-queued
   * proposal — via a single compare-and-set ({@link ObjectiveRepository.settleProposed})
   * and record the transition as `objective.reviewed` (references only: the objective id
   * and the `from`/`to` states, never the content). The direct analogue of
   * {@link settleProposedMemory}: accepting flips `proposed → accepted` (the objective is
   * `active`, so it now frames runs), rejecting flips `proposed → rejected` (it never
   * framed, so nothing changes). The CAS is the race guard — two surfaces draining one
   * proposal cannot both win. `from` is always `proposed`. Returns the settled row to the
   * winner, or undefined to a caller that lost the race or named an unknown /
   * already-settled id, in which case nothing changes and nothing is logged.
   */
  settleProposedObjective(
    agentId: string,
    id: string,
    reviewState: ReviewState,
  ): Objective | undefined {
    return this.driver.transaction(() => {
      const objective = this.objectives.settleProposed(agentId, id, reviewState);
      if (objective) {
        this.emit(agentId, "objective.reviewed", {
          objectiveId: objective.id,
          from: "proposed",
          to: objective.reviewState,
        });
      }
      return objective;
    });
  }

  /**
   * Accept a queued objective proposal WITH AN EDIT, atomically — the direct analogue of
   * {@link acceptEditedProposal}. In ONE transaction it CAS-claims the original out of the
   * queue (`proposed → rejected`, recording `objective.reviewed`) and records the edited
   * content as a fresh `active + accepted` objective (recording `objective.added`). Atomic
   * so the two writes cannot tear: if the record fails, the claim rolls back and the
   * proposal stays in the queue. Claiming the original FIRST is what stops two concurrent
   * edited-accepts from yielding two accepted objectives: only the CAS winner records. The
   * caller has already screened `content` through the firewall (the hard gate) before
   * calling. Returns the new accepted objective, or undefined when the CAS lost.
   */
  acceptEditedObjectiveProposal(
    agentId: string,
    current: Objective,
    content: string,
  ): Objective | undefined {
    return this.driver.transaction(() => {
      const claimed = this.objectives.settleProposed(agentId, current.id, "rejected");
      if (!claimed) return undefined;
      this.emit(agentId, "objective.reviewed", {
        objectiveId: claimed.id,
        from: "proposed",
        to: claimed.reviewState,
      });
      // Carry the original proposal's provenance onto the edited accepted row, so an edited-accept
      // keeps the source run the same way an unedited accept (an in-place CAS) does.
      const objective = this.objectives.create(agentId, {
        content,
        reviewState: "accepted",
        ...(current.sourceRunId !== undefined ? { sourceRunId: current.sourceRunId } : {}),
      });
      this.emit(agentId, "objective.added", {
        objectiveId: objective.id,
        status: objective.status,
        reviewState: objective.reviewState,
      });
      return objective;
    });
  }

  /**
   * Record that a non-interactive `reflect --propose` has reflected objectives on
   * `runId` — a references-only `objective.proposed` marker carrying the per-run tally
   * (how many proposals were queued / withheld / already-known / ignored), never any
   * content. The objective analogue of {@link recordReflectionProposed}, emitted
   * alongside it so the memory marker stays byte-for-byte and the objective marker is its
   * clean mirror. Emit-only (no row to write), so not wrapped in a transaction.
   */
  recordObjectiveProposed(agentId: string, runId: string, tally: ReflectionRunTally): void {
    this.emit(
      agentId,
      "objective.proposed",
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

  /**
   * Apply a reflection-SUGGESTED transition (Type B): advance the objective to `status` ONLY IF it
   * is still `active` + `accepted` (the state the advisory was generated against), via a single
   * guarded CAS ({@link ObjectiveRepository.setStatusIfActiveAccepted}). A concurrent change by
   * another session — the objective was completed, dropped, or rejected meanwhile — makes the CAS
   * match nothing, so this returns undefined and the surface reports it stale (skipped) rather than
   * overwriting the newer status. On a real change it records `objective.status_changed` (references
   * only; `from` is `active`, which the precondition guaranteed). The advisory path's counterpart to
   * the operator's UNCONDITIONAL {@link setObjectiveStatus} (a human running `objective done`/`drop`
   * directly DOES mean to change it regardless of its current state, so that path stays unguarded).
   */
  applyObjectiveTransition(
    agentId: string,
    id: string,
    status: TransitionStatus,
  ): Objective | undefined {
    return this.driver.transaction(() => {
      const objective = this.objectives.setStatusIfActiveAccepted(agentId, id, status);
      if (objective) {
        this.emit(agentId, "objective.status_changed", {
          objectiveId: id,
          from: "active",
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

  /**
   * Record or SUPERSEDE a world-fact ("working note") through the firewall and the cap,
   * logging the outcome. This is the kernel re-enforcing on the agent's UNTRUSTED
   * output: a world-fact is the one framing input the agent writes WITHOUT per-write
   * human review, so the kernel screens it, caps it, and audits it on the way in —
   * exactly as `enforceRecall` re-imposes the recall guarantees on a provider's output.
   * Backs BOTH the agent's `record_note` tool and the operator's `notes set`.
   *
   * Firewall FIRST — safety precedes the resource bound, so a poisoned write is blocked
   * + audited (`world_fact.blocked`, findings only — never the content) even when the
   * agent is at cap. The repository screens again on upsert; that redundancy is
   * deliberate (the repo is safe on its own and never relies on this wrapper — the same
   * storage-layer-enforces rule agentId scoping follows). The screen + block-audit sit
   * OUTSIDE the transaction so a rollback can never erase the audit trail of the block,
   * the same reason {@link recordMemory} is not transactional.
   *
   * Then the cap, read+write under one transaction. The `subject` (the upsert KEY) and
   * `value` are NORMALIZED by trimming first, so set / supersede / clear agree on
   * identity regardless of caller whitespace — the agent's `record_note`, the operator's
   * `notes set`, and `notes clear` all key by the trimmed subject (callers reject an
   * empty subject/value before calling, so the trimmed forms are non-empty here). Within
   * one process the synchronous transaction serializes the read and the write so the cap
   * holds exactly; across separate connections to the same file a deferred transaction
   * takes its write lock only at the INSERT, so two processes adding DISTINCT new
   * subjects could each read a stale count and briefly overshoot the cap by one or two —
   * benign (no eviction, the bound is soft) and rare, never a same-subject double (the
   * accepted partial unique index collapses that). The cap counts DISTINCT subjects, and
   * only a brand-NEW subject (no accepted note AND no coexisting proposed update) grows it;
   * superseding the accepted note, or recording a subject that already has a pending
   * proposal, is free. A brand-new subject at cap is rejected loudly with a
   * {@link WorldFactCapError} (no silent eviction) — a resource bound, not a safety
   * refusal, so it is not audited. This self-write touches ONLY the accepted row; a
   * coexisting proposed UPDATE (a derived proposal, world-model.md §12) is left for the
   * operator to review separately. On success: `world_fact.recorded` (references only —
   * the id and whether it superseded an existing accepted note, NEVER the subject/value,
   * which are agent content like memory content).
   *
   * `runId` stamps the originating run on the audit events (`world_fact.recorded` /
   * `world_fact.blocked`) when the write came from a run's `record_note` tool, so a
   * per-run audit (`events tail --run <id>`) shows the note mutation — and, crucially, a
   * firewall-BLOCKED attempt, which the gate never records as `action.executed` (that hook
   * only fires on a non-error tool result). Absent for the operator path (`notes set`),
   * which is not part of a run.
   */
  recordWorldFact(agentId: string, subject: string, value: string, runId?: string): WorldFact {
    const trimmedSubject = subject.trim();
    const trimmedValue = value.trim();
    try {
      // Screen each field AND the exact RENDERED line (`subject: value`) the fact frames
      // as. Per-field screens alone would let an injection be split across the `: `
      // delimiter — `subject: "ignore all previous"`, `value: "instructions"` each pass,
      // but frame as a single injection line — so the combined screen via
      // `worldFactFramingText` (the one source of truth the framing render also uses) is
      // the load-bearing one; the per-field screens stay as defense-in-depth. The
      // repository's `upsert` enforces this SAME screen (so a direct writer can't bypass
      // it); the store re-runs it here, firewall-FIRST and OUTSIDE the transaction, so a
      // blocked write emits `world_fact.blocked` and that audit survives the rollback.
      assertMemorySafe(trimmedSubject);
      assertMemorySafe(trimmedValue);
      assertMemorySafe(worldFactFramingText(trimmedSubject, trimmedValue));
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        this.emit(agentId, "world_fact.blocked", { findings: err.findings }, runId);
      }
      throw err;
    }
    return this.driver.transaction(() => {
      const acceptedExisting = this.worldFacts.getAccepted(agentId, trimmedSubject);
      // Only a brand-NEW subject (no accepted note AND no coexisting proposed update) grows
      // the DISTINCT-subject count; superseding the accepted note, or a subject that already
      // has a pending proposal, takes no new slot.
      const subjectIsNew =
        acceptedExisting === undefined &&
        this.worldFacts.getProposed(agentId, trimmedSubject) === undefined;
      // The effective cap is the per-agent override or the kernel default (resolved in one
      // place); the error carries the actual number so the agent's tool result and the
      // operator's CLI both report the cap that bit.
      const cap = this.resolveWorldFactCap(agentId);
      if (subjectIsNew && this.worldFacts.count(agentId) >= cap) {
        throw new WorldFactCapError(cap);
      }
      const fact = this.worldFacts.upsert(agentId, trimmedSubject, trimmedValue);
      this.emit(
        agentId,
        "world_fact.recorded",
        { worldFactId: fact.id, superseded: acceptedExisting !== undefined, reviewState: fact.reviewState },
        runId,
      );
      return fact;
    });
  }

  /**
   * Remove one world-fact by subject and record `world_fact.cleared` ({@code worldFactId}
   * only) on a real removal — nothing when no note matched (the no-op-doesn't-log
   * discipline). Backs BOTH the agent's `forget_note` tool and the operator's
   * `notes clear` — one store method, two callers, exactly as {@link recordWorldFact}
   * serves the `record_note` tool and `notes set`. A delete frames nothing, so there is
   * no firewall path here. The `subject` is trimmed to match the normalized key
   * {@link recordWorldFact} stores under, so a note set with surrounding whitespace is
   * still clearable. A cross-agent or unknown subject touches nothing and returns
   * undefined, which the caller uses to tell those apart. `runId` stamps the originating
   * run on `world_fact.cleared` when the clear came from a run's `forget_note` tool (so
   * the per-run audit shows it); absent for the operator path (`notes clear`).
   */
  clearWorldFact(agentId: string, subject: string, runId?: string): WorldFact | undefined {
    const trimmedSubject = subject.trim();
    return this.driver.transaction(() => {
      const removed = this.worldFacts.clear(agentId, trimmedSubject);
      if (removed) {
        this.emit(agentId, "world_fact.cleared", { worldFactId: removed.id }, runId);
      }
      return removed;
    });
  }

  /** An agent's world-facts for a surface to render (and for inspect/history), oldest-first. */
  listWorldFacts(agentId: string): WorldFact[] {
    return this.worldFacts.list(agentId);
  }

  /**
   * PROPOSE a world-fact for human review — the entry point the #84 T3 harvest (and tests) use
   * to add a `proposed` note. The agent's `record_note` and the operator's `notes set` write
   * `accepted` self-notes through {@link recordWorldFact}; this is the parallel path for a
   * DERIVED writer whose output must be ratified before it frames.
   *
   * COEXISTENCE (world-model.md §12). The governance discipline of {@link recordWorldFact},
   * adapted so a proposed UPDATE can sit BESIDE the accepted note it would supersede (instead
   * of the old conservative-skip that refused to touch an accepted subject). Firewall FIRST
   * (screen subject + value + the rendered line, OUTSIDE the transaction so a blocked write's
   * `world_fact.blocked` audit survives the rollback). Then, under one transaction:
   *   1. **No-op suppression.** If the accepted note already holds this value (an unchanged
   *      re-observation), or a pending proposal already carries it, propose nothing and return
   *      `undefined` — so a "X → X" never queues. (The harvest counts `undefined` as skipped.)
   *   2. **Cap** a brand-NEW subject only (no accepted note AND no pending proposal); an update
   *      to an already-tracked subject takes no slot, so a tracked note is never cap-blocked.
   *      A new subject at cap rejects loudly with {@link WorldFactCapError} — not audited.
   *   3. Upsert with `review_state = 'proposed'` (targeting the PROPOSED partial index, so it
   *      creates/supersedes the proposed row and NEVER clobbers the coexisting accepted note —
   *      which keeps framing until the operator accepts) and emit `world_fact.recorded`
   *      (`reviewState: "proposed"`, so the audit shows it was QUEUED — the `objective.added`
   *      analogue). References only — never subject/value. Returns the proposed row, or
   *      `undefined` for a suppressed no-op.
   */
  proposeWorldFact(
    agentId: string,
    subject: string,
    value: string,
    runId?: string,
  ): WorldFact | undefined {
    const trimmedSubject = subject.trim();
    const trimmedValue = value.trim();
    try {
      assertMemorySafe(trimmedSubject);
      assertMemorySafe(trimmedValue);
      assertMemorySafe(worldFactFramingText(trimmedSubject, trimmedValue));
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        this.emit(agentId, "world_fact.blocked", { findings: err.findings }, runId);
      }
      throw err;
    }
    return this.driver.transaction(() => {
      const accepted = this.worldFacts.getAccepted(agentId, trimmedSubject);
      const proposedExisting = this.worldFacts.getProposed(agentId, trimmedSubject);
      // The observation CONFIRMS the accepted value: there is nothing new to propose, AND any
      // DIFFERENT pending proposal for this subject is now STALE — the world matches the
      // accepted note, so a pending "update to something else" would, if later accepted, apply
      // a value the world no longer shows. Discard the stale proposal (audited as a clear) so it
      // can never be ratified to a dead value, then propose nothing.
      // [Codex review: discard stale proposals when the observation matches the accepted value.]
      if (accepted?.value === trimmedValue) {
        if (proposedExisting !== undefined) {
          const removed = this.worldFacts.deleteProposed(agentId, proposedExisting.id, proposedExisting.value);
          if (removed) this.emit(agentId, "world_fact.cleared", { worldFactId: removed.id }, runId);
        }
        return undefined;
      }
      // A pending proposal already carries EXACTLY this value — nothing new to review.
      if (proposedExisting?.value === trimmedValue) {
        return undefined;
      }
      // Only a brand-NEW subject grows the distinct-subject count; an update to a subject that
      // already has an accepted note or a pending proposal takes no slot.
      const subjectIsNew = accepted === undefined && proposedExisting === undefined;
      // The same effective per-agent cap the self-write path enforces (resolved in one
      // place), so a derived proposal and a self-note share one bound.
      const cap = this.resolveWorldFactCap(agentId);
      if (subjectIsNew && this.worldFacts.count(agentId) >= cap) {
        throw new WorldFactCapError(cap);
      }
      const fact = this.worldFacts.upsert(agentId, trimmedSubject, trimmedValue, "proposed");
      this.emit(
        agentId,
        "world_fact.recorded",
        { worldFactId: fact.id, superseded: proposedExisting !== undefined, reviewState: fact.reviewState },
        runId,
      );
      return fact;
    });
  }

  /**
   * Accept a PROPOSED world-fact — the human's ratification of a queued note — with a
   * firewall RE-SCREEN on the way in (the issue's explicit requirement). Takes the
   * `reviewed` row the OPERATOR resolved (e.g. the row the CLI read and the operator saw in
   * `notes inspect`), NOT a fresh store read — so the value ratified is exactly the value the
   * human reviewed. This matters because a world-fact is an UPSERT: a concurrent re-propose of
   * the same still-`proposed` subject rewrites that row IN PLACE (same id, still `proposed`,
   * new value), so re-reading here would re-screen and ratify content the operator never saw.
   * Instead this re-screens `reviewed.subject` + `reviewed.value` + the rendered line (a hit
   * emits `world_fact.blocked` and rethrows — a note that passed the write screen but trips a
   * tightened rule is never accepted), then SUPERSEDES-ON-ACCEPT, pinned to `reviewed.value`
   * ({@link WorldFactRepository.acceptProposed}): if the subject already has an accepted note,
   * the reviewed value is applied to it in place (keeping its id + created_at) and the proposed
   * row is consumed; otherwise the proposed row becomes the accepted note. The accept wins only
   * while the proposed row still holds the reviewed content, so a concurrent re-propose that
   * churned the value drops it to undefined and the operator re-reviews. (`subject` is immutable
   * for a given id, so pinning the value pins the screened rendered line.) Records
   * `world_fact.reviewed` (`{ worldFactId, from: "proposed", to: "accepted" }`, references only;
   * `worldFactId` is the SURVIVING accepted note — in the supersede case that is the pre-existing
   * accepted row, not the proposed one). The re-screen lives kernel-side, so every accept path
   * inherits it. Also the multi-drain race guard — two surfaces accepting one proposal cannot
   * both win. Returns the accepted row to the winner, or undefined to a caller that lost the
   * race, whose reviewed value no longer matches, or named an unknown / already-settled /
   * cross-agent row.
   *
   * Not wrapped in a transaction at the top: like {@link recordWorldFact}, a firewall block must
   * commit its `world_fact.blocked` audit independently of the rollback that the rethrow would
   * cause. The supersede + its `world_fact.reviewed` event run in their own transaction below.
   */
  acceptProposedWorldFact(agentId: string, reviewed: WorldFact): WorldFact | undefined {
    try {
      assertMemorySafe(reviewed.subject);
      assertMemorySafe(reviewed.value);
      assertMemorySafe(worldFactFramingText(reviewed.subject, reviewed.value));
    } catch (err) {
      if (err instanceof MemoryFirewallError) {
        this.emit(agentId, "world_fact.blocked", { findings: err.findings });
      }
      throw err;
    }
    return this.driver.transaction(() => {
      const fact = this.worldFacts.acceptProposed(agentId, reviewed.id, reviewed.value);
      if (fact) {
        this.emit(agentId, "world_fact.reviewed", {
          worldFactId: fact.id,
          from: "proposed",
          to: fact.reviewState,
        });
      }
      return fact;
    });
  }

  /**
   * Reject a PROPOSED world-fact — the human declined a queued note — by DISCARDING it
   * ({@link WorldFactRepository.deleteProposed}): the proposed row is deleted and any accepted
   * note for the subject is left untouched. A world-fact is volatile current-state, so a
   * declined update has no lasting value — there are no `rejected`-history rows (world-model.md
   * §12; this differs from memory/objectives, which keep a rejected row). Records the rejection
   * as `world_fact.reviewed` (`{ worldFactId, from: "proposed", to: "rejected" }`, references
   * only) on the discard — the audit survives the row's deletion, the same way `world_fact.cleared`
   * is recorded on a delete. No firewall screen — a rejected note frames nothing. Takes the
   * OPERATOR-resolved `reviewed` row and PINS the delete to `reviewed.value`: a concurrent
   * re-propose that churned the value (`green → red`) since the operator resolved it makes the
   * reject match nothing, so the operator re-reviews rather than discarding a `red` proposal
   * they never saw. Returns the deleted row to the winner, or undefined to a caller that lost the
   * race, whose reviewed value no longer matches, or named an unknown / already-settled /
   * cross-agent row.
   */
  rejectProposedWorldFact(agentId: string, reviewed: WorldFact): WorldFact | undefined {
    return this.driver.transaction(() => {
      const fact = this.worldFacts.deleteProposed(agentId, reviewed.id, reviewed.value);
      if (fact) {
        this.emit(agentId, "world_fact.reviewed", {
          worldFactId: fact.id,
          from: "proposed",
          to: "rejected",
        });
      }
      return fact;
    });
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

  // --- Collaboration (Phase 3) -----------------------------------------------
  //
  // A connection is the explicit, permissioned channel between two agents — the only
  // thing that lets one agent's curated output reach another, while memory, secrets, and
  // tools stay un-shared. Creating one is a human/operator act (recorded); using one (a
  // handoff) is logged on BOTH participants' logs as content-free references. The handoff
  // op itself lives in `run.ts` (it is an `executeRun` on the callee); these methods own
  // the connection row and the audit, so the event log stays the kernel's to write.

  /**
   * Emit ONE collaboration event to BOTH participants' logs. A connection links two
   * agents, so an event about it (created, used) is recorded once per agent — each row
   * scoped to that agent — which is how `events tail` shows the same handoff on both sides
   * while every log stays agent-scoped (golden rule 5, invariant 5). The payload is the
   * SAME references-only object on both sides (ids, mode, status, a run id) — never the
   * task input, the callee's output, the callee's memory, or any secret.
   */
  private emitToBoth(
    fromAgentId: string,
    toAgentId: string,
    type: EventType,
    payload: unknown,
  ): void {
    this.emit(fromAgentId, type, payload);
    this.emit(toAgentId, type, payload);
  }

  /**
   * Create (or return the existing) ACTIVE directional connection `fromAgentId →
   * toAgentId` in `mode`, recording `connection.created` on BOTH agents' logs on a real
   * create. The human-granted permission object: without it, no cross-agent interaction
   * is possible (a handoff checks for exactly this). Idempotent — re-running `connect A B
   * --mode handoff` returns the existing active connection with NO second event (the
   * no-op-doesn't-log discipline used throughout the store); the partial unique index is
   * the storage-layer backstop against a concurrent double-create. A self-connection is a
   * kernel invariant violation (a connection is for cross-agent collaboration), refused
   * loudly here so no surface can persist one. The `connection.created` payload is
   * references only — the connection id, both agent ids, and the mode; never any content.
   */
  createConnection(fromAgentId: string, toAgentId: string, mode: ConnectionMode): Connection {
    if (fromAgentId === toAgentId) {
      throw new Error("an agent cannot connect to itself");
    }
    return this.driver.transaction(() => {
      const existing = this.connections.findActive(fromAgentId, toAgentId, mode);
      if (existing) return existing;
      const connection = this.connections.create({ fromAgentId, toAgentId, mode });
      this.emitToBoth(fromAgentId, toAgentId, "connection.created", {
        connectionId: connection.id,
        fromAgentId,
        toAgentId,
        mode: connection.mode,
      });
      return connection;
    });
  }

  /**
   * Withdraw the ACTIVE `fromAgentId → toAgentId` connection in `mode`, recording
   * `connection.revoked` on BOTH agents' logs. Returns the revoked connection, or undefined
   * when there was no active one — in which case NOTHING is emitted, so a re-revoke is a
   * silent no-op rather than a second withdrawal in the audit.
   *
   * What this actually takes away is the point, and it is more than the ability to ask for
   * work. Because every exchange re-reads the ACTIVE connection at the moment it acts, and
   * because `exchanges` authorization is keyed on the connection ROW, one revoke withdraws
   * all four capabilities at once:
   *
   *   - `handoff`  — the callee can no longer be asked to run work
   *   - `artifact` — nor to produce a manifest
   *   - `fetch`    — every artifact ever exchanged over this connection stops resolving
   *   - `summary`  — the callee's ratified memory stops being readable
   *
   * TERMINAL: there is no reverse transition, here or in the repository. Reconnecting means
   * {@link createConnection} again, which mints a fresh row — old `exchanges` rows stay keyed
   * on the revoked id, so what crossed the old channel does not travel to the new one (design
   * note §15, D20). The payload is references only, exactly like `connection.created`.
   *
   * Work already in flight is deliberately NOT interrupted: a run this connection asked for
   * that is parked at its own destructive-action gate still resumes, under its own operator's
   * confirmation. What the revoke takes away is the CROSSING — the resumed run records
   * nothing back over the withdrawn channel (D19, and see {@link resumeRun}).
   */
  revokeConnection(
    fromAgentId: string,
    toAgentId: string,
    mode: ConnectionMode,
  ): Connection | undefined {
    return this.driver.transaction(() => {
      const connection = this.connections.revoke(fromAgentId, toAgentId, mode);
      if (!connection) return undefined;
      this.emitToBoth(fromAgentId, toAgentId, "connection.revoked", {
        connectionId: connection.id,
        fromAgentId,
        toAgentId,
        mode: connection.mode,
      });
      return connection;
    });
  }

  /**
   * Set (or replace) the standing brief on a `shared-brief` connection, recording
   * `brief.set` on BOTH agents' logs. Returns the new brief.
   *
   * The mirror of {@link createObjective} — a brief is operator-authored free text that
   * frames runs, so it is screened by the memory firewall on the write path and audited
   * either way. On a refusal `brief.blocked` is emitted (the findings, never the blocked
   * text) and the error rethrows, so the refusal stays on the record. The emit happens
   * AFTER the transaction has rolled back, which is what keeps the audit from being erased
   * along with the write it describes.
   *
   * The difference from an objective is the audience, and it is the whole reason this mode
   * needed its own decisions: an objective frames the agent that declared it, while a brief
   * frames ANOTHER agent's runs. So the block is emitted only on the AUTHOR's log — a
   * refused brief touched the callee not at all, the same rule a withheld fetch follows —
   * while a successful set is recorded on both, references only (brief id, connection id,
   * both agent ids, mode). **The brief's text never appears in an event**, for the same
   * reason a handoff's task input never appears in `handoff.requested`.
   *
   * Replacing is a supersede, not an update: the existing active brief is ended and a new
   * row inserted, both inside one transaction, so a channel never has two active briefs and
   * the history of what framed runs stays intact (D28). The partial unique index is the
   * storage-layer backstop.
   *
   * Returns `undefined` when the grant does not hold at the moment of the write — the
   * connection is not a live `shared-brief` channel between these two agents. This method is
   * PUBLIC, so it cannot lean on a surface having checked: a caller can hold a `Connection`
   * for another mode, or one that another operator revoked a moment ago, and neither may
   * leave a persisted brief and a `brief.set` on both logs describing context that will never
   * frame anything. The test lives inside {@link BriefRepository.create}'s INSERT rather than
   * as a re-read here, so there is no window between checking and writing at all.
   * [Codex review R1 P2.]
   */
  setBrief(connection: Connection, content: string): Brief | undefined {
    let brief: Brief;
    try {
      brief = this.driver.transaction(() => {
        // Ended first so the unique index is free for the insert. A firewall refusal throws
        // inside `create`, which rolls this back — a blocked brief must not end the one that
        // was already framing runs.
        this.briefs.endActiveForConnection(connection);
        const created = this.briefs.create(connection, content);
        // The conditional INSERT declined: the grant did not hold. Thrown rather than
        // returned so the supersede above rolls back WITH it — a brief that could not be
        // written must never have cleared the one that was already there. Caught below and
        // turned back into an ordinary `undefined`; it never escapes this method.
        //
        // HONEST ABOUT COVERAGE: since review round 2 gave `endActiveForConnection` the
        // identical grant predicate, no in-process caller can reach this branch — the end
        // and the insert now decline on exactly the same conditions, so an end that succeeds
        // is followed by an insert that succeeds. Deleting the throw breaks no test, and that
        // was measured rather than assumed. It is kept for two reasons worth stating rather
        // than leaving a reader to wonder:
        //
        //   1. It is NOT provably unreachable across processes. That would require an
        //      argument about exactly when SQLite takes the write lock for an UPDATE matching
        //      zero rows — and review round 5 of the revoke slice established that an argument
        //      resting on nobody mis-remembering SQLite's isolation rules is the weaker kind.
        //   2. Its necessity would return the moment the two predicates drift, and a silent
        //      supersede-without-replacement is the failure it prevents: context stripped from
        //      both agents on behalf of a write that never landed.
        if (!created) throw new BriefGrantWithdrawnError();
        return created;
      });
    } catch (err) {
      if (err instanceof BriefGrantWithdrawnError) return undefined;
      if (err instanceof MemoryFirewallError) {
        this.emit(connection.fromAgentId, "brief.blocked", { findings: err.findings });
      }
      throw err;
    }
    // Every field here is one the grant test VERIFIED against the connection row: the id, and
    // both participants (the predicate compares them). `mode` is the exception and is
    // deliberately NOT read off the caller's object — a `Connection` whose id/from/to match a
    // live row but whose `mode` field was mutated passed the SQL check and then had that field
    // copied into the audit, so a references-only log could claim a brief was set on `handoff`
    // while the authorizing row said otherwise. The write only ever succeeds on a
    // `shared-brief` row, so the verified value is the constant the predicate itself binds.
    // [Codex review R4 P2.]
    this.emitToBoth(connection.fromAgentId, connection.toAgentId, "brief.set", {
      briefId: brief.id,
      connectionId: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      mode: BRIEF_CONNECTION_MODE,
    });
    return brief;
  }

  /**
   * End the standing brief on a connection, recording `brief.ended` on BOTH agents' logs.
   * Returns the ended brief, or undefined when there was none TO end — either because the
   * channel carries no brief or because it is no longer a live `shared-brief` grant. In
   * either case NOTHING is emitted, so re-ending is a silent no-op rather than a second
   * withdrawal in the audit (the same discipline {@link revokeConnection} follows), and a
   * caller holding a stale `Connection` cannot change another channel's state.
   *
   * Terminal: reinstating means calling {@link setBrief} again, which mints a fresh row.
   */
  endBrief(connection: Connection): Brief | undefined {
    return this.driver.transaction(() => {
      const brief = this.briefs.endActiveForConnection(connection);
      if (!brief) return undefined;
      // The verified mode, not the caller's field — see the note on `brief.set` above. The
      // end path had the identical defect, which is why the fix is stated once and applied to
      // both rather than to the one a report happened to name.
      this.emitToBoth(connection.fromAgentId, connection.toAgentId, "brief.ended", {
        briefId: brief.id,
        connectionId: connection.id,
        fromAgentId: connection.fromAgentId,
        toAgentId: connection.toAgentId,
        mode: BRIEF_CONNECTION_MODE,
      });
      return brief;
    });
  }

  /**
   * The briefs that currently FRAME this agent's runs — active briefs on active
   * `shared-brief` channels the agent participates in. The read `executeRun` makes at
   * framing time, so the grant is evaluated when the text is used rather than when it was
   * written, and a revoked channel yields nothing.
   */
  listActiveBriefsForAgent(agentId: string): Brief[] {
    return this.briefs.listActiveForAgent(agentId);
  }

  /**
   * Every brief an agent participates in, in any status, for `briefs <agent>`. History, not
   * permission — a superseded brief and one whose channel was withdrawn both still show,
   * exactly as {@link listConnections} keeps revoked rows listed.
   */
  listBriefs(agentId: string): Brief[] {
    return this.briefs.listForAgent(agentId);
  }

  /**
   * Every connection an agent participates in (inbound + outbound), for `connections <agent>`.
   * Returns EVERY status, revoked included: this read is the operator's history of the
   * channel, and a withdrawn connection is the evidence that a permission was taken away.
   * Nothing here grants anything — the permission reads are `findActive` /
   * {@link listActiveConnectionsForPair}.
   */
  listConnections(agentId: string): Connection[] {
    return this.connections.listForAgent(agentId);
  }

  /**
   * The ACTIVE channels from one agent to another, in any mode — the pair-scoped read behind
   * `disconnect`'s mode inference, so a surface can distinguish "exactly one open channel"
   * from "several" instead of guessing which the operator meant.
   */
  listActiveConnectionsForPair(fromAgentId: string, toAgentId: string): Connection[] {
    return this.connections.listActiveForPair(fromAgentId, toAgentId);
  }

  /**
   * One connection by id, scoped so only a participant can read it (else undefined). Returns
   * a REVOKED connection too, and that is load-bearing rather than incidental: a resuming run
   * looks its originating connection up here precisely to discover whether the grant it
   * arrived under still holds, which it cannot do if a withdrawn channel reads as missing.
   */
  getConnection(agentId: string, id: string): Connection | undefined {
    return this.connections.get(agentId, id);
  }

  /**
   * Record the START of a handoff — `handoff.requested` on BOTH participants' logs
   * (references only: the connection id, both agent ids, the mode). Emitted by the kernel
   * handoff op (`performHandoff`) just before it runs the callee, so the audit shows the
   * caller invoked the channel even if the run then fails. No runId yet — the callee's run
   * is created inside the `executeRun` that follows.
   */
  recordHandoffRequested(connection: Connection): void {
    this.emitToBoth(connection.fromAgentId, connection.toAgentId, "handoff.requested", {
      connectionId: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      mode: connection.mode,
    });
  }

  /**
   * Record the RETURN of an exchange — `handoff.completed` on BOTH participants' logs
   * (references only: the connection id, both agent ids, the MODE, the callee's run id, and
   * the run's final status). "Completed" marks the exchange CALL returning control to the
   * caller, not run success — `status` carries done / failed / awaiting_confirmation, so an
   * exchange that paused the callee's gate is recorded honestly. `runId` is the callee's
   * run, carried as a reference in the payload (not stamped on the caller's runId column —
   * the caller has no such run); it never lets the caller READ the callee's run, which
   * stays scoped to the callee. Never the callee's output text, transcript, memory, or a
   * secret.
   *
   * `mode` rides on this event for the same reason it rides on `handoff.requested`: more
   * than one mode now shares this path, so a completion read on its own — or a log filtered
   * to `handoff.completed` — must still say WHICH exchange form returned. Without it an
   * `artifact-only` completion is indistinguishable from a `handoff` completion, and the
   * mode-specific audit trail only half exists. [Codex review P2.]
   */
  recordHandoffCompleted(connection: Connection, runId: string, status: RunStatus): void {
    this.emitToBoth(connection.fromAgentId, connection.toAgentId, "handoff.completed", {
      connectionId: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      mode: connection.mode,
      runId,
      status,
    });
  }

  /**
   * Persist an `artifact-only` exchange's manifest as resolvable references — one row per
   * artifact, all sharing this exchange's `(connection, runId)`.
   *
   * Recorded because a reference nobody can dereference is only half a mode: `artifact
   * fetch` reads exactly these rows to decide whether a path the caller names was genuinely
   * produced by that callee over that connection. Nothing else may authorize a byte to move.
   *
   * Mirrors the manifest EXACTLY — including artifacts the run deleted (`exists: false` →
   * `present = 0`). Filtering those out here would let the record and the manifest that
   * crossed disagree, and it is `present` that later lets a deletion WITHDRAW an earlier
   * reference instead of being outvoted by history.
   *
   * One transaction, so an exchange's references land together or not at all — a partially
   * recorded manifest would make some of what crossed fetchable and the rest silently not.
   * No event is emitted: `handoff.completed` already records the crossing on both logs, and
   * a per-artifact event would put the same references on the log twice.
   */
  recordArtifactExchange(
    connection: Connection,
    runId: string,
    artifacts: readonly ArtifactRef[],
  ): void {
    if (artifacts.length === 0) return;
    this.driver.transaction(() => {
      for (const artifact of artifacts) {
        this.exchanges.record({
          connectionId: connection.id,
          fromAgentId: connection.fromAgentId,
          toAgentId: connection.toAgentId,
          kind: "artifact",
          ref: artifactReference(artifact),
          present: artifact.exists,
          // Carried through so the row identifies the ARTIFACT, not just where it lived —
          // see the `Exchange.sizeBytes` contract and the fetch-time staleness check.
          ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
          // A redacted reference is recorded (the manifest showed it, so the record must too)
          // but marked unresolvable — its path is a display string, not the file's name.
          redacted: artifact.redacted === true,
          runId,
        });
      }
    });
  }

  /**
   * Resolve a reference the caller named against what actually crossed this connection, or
   * `undefined` when it never did. The authorization read behind `artifact fetch`: a miss
   * means no bytes move.
   *
   * Scoped to the connection the caller holds AND asserted against the caller as
   * participant, so an artifact that crossed another channel — a different callee, the other
   * direction, or a connection since revoked and REPLACED — does not resolve.
   *
   * That last case is what the connection-row keying actually buys, and it is worth stating
   * precisely, because an earlier version of this comment attributed the wrong effect to it.
   * A revoke alone never reaches this lookup: `performArtifactFetch` reads the ACTIVE
   * connection first and returns `no_connection` before asking what crossed. What the keying
   * uniquely handles is the RECONNECT — a fresh `connect` mints a new row, these rows stay
   * keyed on the revoked one, so a caller cannot re-open a channel to recover references the
   * revoke withdrew. Both refusals are correct; they just come from different places.
   */
  findExchangedArtifact(connection: Connection, ref: string): Exchange | undefined {
    return this.exchanges.findLatest(connection.id, connection.fromAgentId, "artifact", ref);
  }

  /**
   * Record that an artifact's BYTES crossed into the caller's workspace — `artifact.fetched`
   * on BOTH participants' logs, references only: the connection id, both agent ids, the
   * artifact reference (already redacted at manifest construction), and the byte count.
   *
   * Emitted only when a fetch actually materialized the file. A withheld or unconfirmed
   * fetch is recorded by the gate's own `action.*` audit on the CALLER's log, where it
   * belongs: nothing crossed the boundary, so the callee's log has nothing to record. The
   * file's CONTENTS never appear here — the event log stores references, never values, and
   * this is the one operation in the phase where contents exist to be leaked.
   */
  recordArtifactFetched(connection: Connection, ref: string, bytes: number): void {
    this.emitToBoth(connection.fromAgentId, connection.toAgentId, "artifact.fetched", {
      connectionId: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      mode: connection.mode,
      ref,
      bytes,
    });
  }

  /**
   * Record the START of a `read-summary` pull — `summary.requested` on BOTH participants'
   * logs (references only: the connection id, both agent ids, the mode).
   *
   * The caller's FOCUS is deliberately not recorded. It is free-form caller-authored text,
   * and the event log stores references, not content — the same reason a handoff's task
   * input never appears in `handoff.requested`. What the log establishes is that the channel
   * was used, by whom, in which direction; what was asked is the surfaces' business.
   *
   * No runId, at either end of the pair: nothing runs. That absence is the mode, not a gap.
   */
  recordSummaryRequested(connection: Connection): void {
    this.emitToBoth(connection.fromAgentId, connection.toAgentId, "summary.requested", {
      connectionId: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      mode: connection.mode,
    });
  }

  /**
   * Record the RETURN of a `read-summary` pull — `summary.provided` on BOTH participants'
   * logs, carrying COUNTS ONLY: how many of the callee's memories were eligible, how many
   * crossed, and how many the outbound screen refused.
   *
   * Counts are the honest maximum here. They let an operator read either log and see the
   * shape of what happened — "12 eligible, 8 crossed, 1 screened out" — which is what makes a
   * silent widening of the mode visible after the fact. No memory CONTENT and no memory IDS:
   * an id is a handle into the callee's own store, and putting one on the caller's log would
   * make the audit trail itself a cross-agent reference the mode never granted.
   */
  recordSummaryProvided(
    connection: Connection,
    counts: { eligible: number; included: number; withheld: number },
  ): void {
    this.emitToBoth(connection.fromAgentId, connection.toAgentId, "summary.provided", {
      connectionId: connection.id,
      fromAgentId: connection.fromAgentId,
      toAgentId: connection.toAgentId,
      mode: connection.mode,
      eligible: counts.eligible,
      included: counts.included,
      withheld: counts.withheld,
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
