import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Run, RunStatus } from "../types";
import { RUN_STATUSES, validateEnum } from "../types";
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
    const status = input.status ?? "pending";
    validateEnum(status, RUN_STATUSES, "run status");
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO runs (id, agent_id, input, status, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([id, agentId, input.input, status, startedAt, null]);
    if (!row) throw new Error("run insert did not persist");
    return mapRun(row);
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
      .prepare(
        `SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapRun);
  }

  setStatus(agentId: string, id: string, status: RunStatus): Run | undefined {
    requireAgentId(agentId);
    validateEnum(status, RUN_STATUSES, "run status");
    const isTerminal = status === "done" || status === "failed";
    const finishedAt = isTerminal ? new Date().toISOString() : null;
    // Terminal state: stamp finished_at, keeping the first finish time on a
    // redundant re-set (COALESCE). Non-terminal state: clear any stale stamp.
    const row = this.driver
      .prepare(
        `UPDATE runs
            SET status = ?,
                finished_at = CASE WHEN ? = 1
                                THEN COALESCE(finished_at, ?)
                                ELSE NULL END
          WHERE id = ? AND agent_id = ?
          RETURNING *`,
      )
      .get([status, isTerminal ? 1 : 0, finishedAt, id, agentId]);
    return row ? mapRun(row) : undefined;
  }
}
