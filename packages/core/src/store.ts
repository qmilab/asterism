import type { SqlDriver } from "./db/driver";
import { openDatabase } from "./db/index";
import { SCHEMA } from "./db/schema";
import { AgentRepository } from "./repositories/agents";
import { RunRepository } from "./repositories/runs";
import { MemoryRepository } from "./repositories/memories";
import { SkillRepository } from "./repositories/skills";
import { CredentialRepository } from "./repositories/credentials";
import type { Credential } from "./types";
import { EventRepository } from "./repositories/events";
import { SecretStore } from "./secrets";

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
