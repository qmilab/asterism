import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { Run, RunStatus } from "../types.js";
import { RUN_STATUSES, validateEnum } from "../types.js";
import { requireAgentId } from "./scope.js";

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
    ...(row.output != null ? { output: String(row.output) } : {}),
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

  /**
   * Persist a run's final output text — the transcript a later `reflect` reads.
   * Scoped like every other write: a cross-agent or unknown run matches nothing
   * and returns undefined, so one agent can never stamp output onto another's run.
   */
  setOutput(agentId: string, id: string, output: string): Run | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(
        `UPDATE runs SET output = ? WHERE id = ? AND agent_id = ? RETURNING *`,
      )
      .get([output, id, agentId]);
    return row ? mapRun(row) : undefined;
  }

  /**
   * The agent's most recent run by start time, whatever its status — the "last
   * active" signal a roster shows. Scoped like every read; ties on start time
   * break by insertion order (rowid), so this never reorders within a millisecond.
   */
  latest(agentId: string): Run | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(
        `SELECT * FROM runs WHERE agent_id = ?
           ORDER BY started_at DESC, rowid DESC
           LIMIT 1`,
      )
      .get([agentId]);
    return row ? mapRun(row) : undefined;
  }

  /**
   * The agent's most recent run that produced output — the default target for
   * reflection. Scoped like every read; runs with no output (or only whitespace)
   * are excluded so a caller never reflects on a run with nothing to learn from.
   */
  latestWithOutput(agentId: string): Run | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(
        `SELECT * FROM runs
           WHERE agent_id = ? AND output IS NOT NULL AND TRIM(output) <> ''
           ORDER BY started_at DESC, rowid DESC
           LIMIT 1`,
      )
      .get([agentId]);
    return row ? mapRun(row) : undefined;
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
