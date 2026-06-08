import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Event } from "../types";
import { requireAgentId } from "./scope";

export interface AppendEventInput {
  type: string;
  payload: unknown;
  runId?: string;
}

function mapEvent(row: SqlRow): Event {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ...(row.run_id != null ? { runId: String(row.run_id) } : {}),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)) as unknown,
    createdAt: String(row.created_at),
  };
}

/** Append-only event log, scoped per agent. */
export class EventRepository {
  constructor(private readonly driver: SqlDriver) {}

  append(agentId: string, input: AppendEventInput): Event {
    requireAgentId(agentId);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.driver
      .prepare(
        `INSERT INTO events (id, agent_id, run_id, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run([
        id,
        agentId,
        input.runId ?? null,
        input.type,
        JSON.stringify(input.payload ?? null),
        createdAt,
      ]);
    const created = this.get(agentId, id);
    if (!created) throw new Error("event insert did not persist");
    return created;
  }

  get(agentId: string, id: string): Event | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM events WHERE id = ? AND agent_id = ?`)
      .get([id, agentId]);
    return row ? mapEvent(row) : undefined;
  }

  list(agentId: string): Event[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(`SELECT * FROM events WHERE agent_id = ? ORDER BY created_at ASC`)
      .all([agentId])
      .map(mapEvent);
  }
}
