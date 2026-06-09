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
import { SecretStore, secretValueRef } from "./secrets.js";
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
    this.agents = new AgentRepository(driver);
    this.runs = new RunRepository(driver);
    this.memories = new MemoryRepository(driver);
    this.skills = new SkillRepository(driver);
    this.credentials = new CredentialRepository(driver);
    this.secrets = new SecretStore(driver);
    this.events = new EventRepository(driver);
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

  /** Open a store backed by a local SQLite database (in-memory by default). */
  static open(path?: string): AsterismStore {
    return new AsterismStore(openDatabase(path));
  }

  close(): void {
    this.driver.close();
  }
}
