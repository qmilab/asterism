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

  /**
   * Atomically claim a paused run for resume: flip `awaiting_confirmation` →
   * `running` in a SINGLE compare-and-set. The status precondition lives in the
   * UPDATE's WHERE clause, so two concurrent confirms cannot both win — the first
   * flips the row and the second's `status = 'awaiting_confirmation'` no longer
   * matches, updating nothing. Returns the now-`running` run to the caller that won
   * the claim, or undefined to every other caller (the run was unknown, already
   * claimed, or not paused). This is what keeps a confirmed destructive action from
   * executing twice when two confirm requests race over the same parked run.
   */
  claimForResume(agentId: string, id: string): Run | undefined {
    requireAgentId(agentId);
    // Also CLEAR `output`: the run is being re-executed from the start, so the
    // transcript persisted at the previous pause is stale. Leaving it would let a
    // resume that re-pauses before producing new text keep the old attempt's text
    // on the row (and `reflect` could pick it up via `latestWithOutput`). A re-run
    // that completes or re-pauses with text overwrites this NULL; one that produces
    // nothing honestly has no transcript.
    const row = this.driver
      .prepare(
        `UPDATE runs SET status = 'running', finished_at = NULL, output = NULL
          WHERE id = ? AND agent_id = ? AND status = 'awaiting_confirmation'
          RETURNING *`,
      )
      .get([id, agentId]);
    return row ? mapRun(row) : undefined;
  }

  /**
   * Atomically claim a paused run to DECLINE it: flip `awaiting_confirmation` →
   * `failed` in a SINGLE compare-and-set — the same status precondition as
   * {@link claimForResume}, so a decline and a confirm race safely over one parked
   * run (exactly one wins; the loser's `status = 'awaiting_confirmation'` no longer
   * matches). Unlike a resume, a decline does NOT re-enter the run, so it PRESERVES
   * `output`: a run that produced a transcript before the gate stopped it stays
   * reflectable and listed with that text even though it ended refused. Stamps
   * `finished_at`. Returns the now-`failed` run to the winner, or undefined to every
   * other caller (the run was unknown, already claimed, or not paused).
   */
  claimForDecline(agentId: string, id: string): Run | undefined {
    requireAgentId(agentId);
    const finishedAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = COALESCE(finished_at, ?)
          WHERE id = ? AND agent_id = ? AND status = 'awaiting_confirmation'
          RETURNING *`,
      )
      .get([finishedAt, id, agentId]);
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
