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
    const ref = this.secrets.issue(agentId, key, value);
    return this.credentials.create(agentId, { key, valueRef: ref.valueRef });
  }

  /** Open a store backed by a local SQLite database (in-memory by default). */
  static open(path?: string): AsterismStore {
    return new AsterismStore(openDatabase(path));
  }

  close(): void {
    this.driver.close();
  }
}
