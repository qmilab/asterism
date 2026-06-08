import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Skill } from "../types";
import { requireAgentId } from "./scope";

export interface CreateSkillInput {
  name: string;
  path: string;
}

function mapSkill(row: SqlRow): Skill {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    path: String(row.path),
    createdAt: String(row.created_at),
  };
}

export class SkillRepository {
  constructor(private readonly driver: SqlDriver) {}

  create(agentId: string, input: CreateSkillInput): Skill {
    requireAgentId(agentId);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO skills (id, agent_id, name, path, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([id, agentId, input.name, input.path, createdAt]);
    if (!row) throw new Error("skill insert did not persist");
    return mapSkill(row);
  }

  get(agentId: string, id: string): Skill | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM skills WHERE id = ? AND agent_id = ?`)
      .get([id, agentId]);
    return row ? mapSkill(row) : undefined;
  }

  list(agentId: string): Skill[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM skills WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapSkill);
  }
}
