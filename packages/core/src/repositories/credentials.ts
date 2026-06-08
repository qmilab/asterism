import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Credential } from "../types";
import { requireAgentId } from "./scope";

export interface CreateCredentialInput {
  key: string;
  /** Reference into the local secret store — never the plaintext value. */
  valueRef: string;
}

function mapCredential(row: SqlRow): Credential {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    key: String(row.key),
    valueRef: String(row.value_ref),
    createdAt: String(row.created_at),
  };
}

export class CredentialRepository {
  constructor(private readonly driver: SqlDriver) {}

  create(agentId: string, input: CreateCredentialInput): Credential {
    requireAgentId(agentId);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    // Re-adding an existing key rotates its valueRef (idempotent `secrets add`)
    // rather than throwing on the UNIQUE(agent_id, key) constraint; the original
    // id and created_at are preserved.
    const row = this.driver
      .prepare(
        `INSERT INTO credentials (id, agent_id, key, value_ref, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET value_ref = excluded.value_ref
         RETURNING *`,
      )
      .get([id, agentId, input.key, input.valueRef, createdAt]);
    if (!row) throw new Error("credential insert did not persist");
    return mapCredential(row);
  }

  get(agentId: string, id: string): Credential | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM credentials WHERE id = ? AND agent_id = ?`)
      .get([id, agentId]);
    return row ? mapCredential(row) : undefined;
  }

  getByKey(agentId: string, key: string): Credential | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM credentials WHERE key = ? AND agent_id = ?`)
      .get([key, agentId]);
    return row ? mapCredential(row) : undefined;
  }

  list(agentId: string): Credential[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM credentials WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapCredential);
  }
}
