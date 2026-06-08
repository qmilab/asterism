import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Agent, TrustLevel } from "../types";
import { requireAgentId } from "./scope";

/**
 * Public input for creating an agent. The reserved fields `teamId` /
 * `ownerPrincipalId` are deliberately absent — they are not settable in Phase 0.
 */
export interface CreateAgentInput {
  name: string;
  role: string;
  soulRef: string;
  workspaceDir: string;
  trustLevel: TrustLevel;
}

/**
 * Maps a raw row to the public Agent. The reserved `team_id` /
 * `owner_principal_id` columns are intentionally dropped here so they can never
 * leak through the public type.
 */
function mapAgent(row: SqlRow): Agent {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    soulRef: String(row.soul_ref),
    workspaceDir: String(row.workspace_dir),
    trustLevel: String(row.trust_level) as TrustLevel,
    createdAt: String(row.created_at),
  };
}

/**
 * The agent registry. The agent is the isolation boundary, so for this table
 * `id` *is* the agentId; every per-agent method asserts it via requireAgentId.
 */
export class AgentRepository {
  constructor(private readonly driver: SqlDriver) {}

  create(input: CreateAgentInput): Agent {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.driver
      .prepare(
        `INSERT INTO agents
           (id, name, role, soul_ref, workspace_dir, trust_level, created_at, team_id, owner_principal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        id,
        input.name,
        input.role,
        input.soulRef,
        input.workspaceDir,
        input.trustLevel,
        createdAt,
        // team_id / owner_principal_id reserved — always null in Phase 0.
        null,
        null,
      ]);
    const created = this.get(id);
    if (!created) throw new Error("agent insert did not persist");
    return created;
  }

  get(agentId: string): Agent | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get([agentId]);
    return row ? mapAgent(row) : undefined;
  }

  /** The agent registry itself — used to enumerate identities, not scoped data. */
  list(): Agent[] {
    return this.driver
      .prepare(`SELECT * FROM agents ORDER BY created_at ASC`)
      .all()
      .map(mapAgent);
  }

  setTrustLevel(agentId: string, trustLevel: TrustLevel): Agent {
    requireAgentId(agentId);
    this.driver
      .prepare(`UPDATE agents SET trust_level = ? WHERE id = ?`)
      .run([trustLevel, agentId]);
    const updated = this.get(agentId);
    if (!updated) throw new Error(`agent not found: ${agentId}`);
    return updated;
  }
}
