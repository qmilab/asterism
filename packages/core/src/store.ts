import type { SqlDriver } from "./db/driver";
import { openDatabase } from "./db/index";
import { SCHEMA } from "./db/schema";
import { AgentRepository } from "./repositories/agents";
import { RunRepository } from "./repositories/runs";
import { MemoryRepository } from "./repositories/memories";
import { SkillRepository } from "./repositories/skills";
import { CredentialRepository } from "./repositories/credentials";
import { EventRepository } from "./repositories/events";

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
  readonly events: EventRepository;

  constructor(private readonly driver: SqlDriver) {
    this.driver.exec(SCHEMA);
    this.agents = new AgentRepository(driver);
    this.runs = new RunRepository(driver);
    this.memories = new MemoryRepository(driver);
    this.skills = new SkillRepository(driver);
    this.credentials = new CredentialRepository(driver);
    this.events = new EventRepository(driver);
  }

  /** Open a store backed by a local SQLite database (in-memory by default). */
  static open(path?: string): AsterismStore {
    return new AsterismStore(openDatabase(path));
  }

  close(): void {
    this.driver.close();
  }
}
