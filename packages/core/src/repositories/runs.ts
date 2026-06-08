import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Run, RunStatus } from "../types";
import { requireAgentId } from "./scope";

export interface CreateRunInput {
  input: string;
  status?: RunStatus;
}

function mapRun(row: SqlRow): Run {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    input: String(row.input),
    status: String(row.status) as RunStatus,
    startedAt: String(row.started_at),
    ...(row.finished_at != null ? { finishedAt: String(row.finished_at) } : {}),
  };
}

export class RunRepository {
  constructor(private readonly driver: SqlDriver) {}

  create(agentId: string, input: CreateRunInput): Run {
    requireAgentId(agentId);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    this.driver
      .prepare(
        `INSERT INTO runs (id, agent_id, input, status, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run([id, agentId, input.input, input.status ?? "pending", startedAt, null]);
    const created = this.get(agentId, id);
    if (!created) throw new Error("run insert did not persist");
    return created;
  }

  get(agentId: string, id: string): Run | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM runs WHERE id = ? AND agent_id = ?`)
      .get([id, agentId]);
    return row ? mapRun(row) : undefined;
  }

  list(agentId: string): Run[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(`SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at ASC`)
      .all([agentId])
      .map(mapRun);
  }

  setStatus(agentId: string, id: string, status: RunStatus): Run | undefined {
    requireAgentId(agentId);
    const finishedAt =
      status === "done" || status === "failed" ? new Date().toISOString() : null;
    this.driver
      .prepare(
        `UPDATE runs
            SET status = ?,
                finished_at = COALESCE(?, finished_at)
          WHERE id = ? AND agent_id = ?`,
      )
      .run([status, finishedAt, id, agentId]);
    return this.get(agentId, id);
  }
}
