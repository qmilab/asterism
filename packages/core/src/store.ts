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
import { CredentialRepository } from "./repositories/credentials.js";
import type {
  Agent,
  Credential,
  EventType,
  Memory,
  Run,
  RunStatus,
  Skill,
  TrustLevel,
} from "./types.js";
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
  readonly credentials: CredentialRepository;
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
    this.credentials = new CredentialRepository(driver);
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
