import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow, SqlValue } from "../db/driver.js";
import type { Event } from "../types.js";
import { requireAgentId } from "./scope.js";

export interface AppendEventInput {
  type: string;
  payload: unknown;
  runId?: string;
}

/**
 * Options for {@link EventRepository.tail}. All optional; with none given, `tail`
 * returns the agent's whole log oldest-first (same as {@link EventRepository.list}).
 */
export interface TailOptions {
  /** Cap the number of events returned. */
  limit?: number;
  /**
   * Cursor for incremental ("live") tailing: return only events that landed
   * strictly after the event with this id. The cursor is resolved within the
   * agent's own scope, so one agent's id can never address another's events.
   */
  sinceId?: string;
  /** Return only events of this exact `type`. */
  type?: string;
  /**
   * Return only events stamped with this exact `runId`. Combined with the agent
   * scope, so it can only narrow to one of the agent's own runs — never reach a
   * run belonging to another agent.
   */
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
    const row = this.driver
      .prepare(
        `INSERT INTO events (id, agent_id, run_id, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([
        id,
        agentId,
        input.runId ?? null,
        input.type,
        JSON.stringify(input.payload ?? null),
        createdAt,
      ]);
    if (!row) throw new Error("event insert did not persist");
    return mapEvent(row);
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
      .prepare(
        `SELECT * FROM events WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapEvent);
  }

  /**
   * One run's events, oldest-first — scoped to `agentId` AND `runId` at the
   * storage layer, so it can never surface another run's (or another agent's)
   * log. Used by the kernel to reconstruct what a parked run is still waiting on
   * (the `action.awaiting_confirmation` decisions not yet resolved by an
   * `action.executed`) when it resumes the run after confirmation.
   */
  listForRun(agentId: string, runId: string): Event[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM events WHERE agent_id = ? AND run_id = ?
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId, runId])
      .map(mapEvent);
  }

  /**
   * Read an agent's events for tailing — always returned oldest-first so a reader
   * sees them in the order they happened. Three shapes, all scoped to `agentId`:
   *
   *   - `{ sinceId }`        — only events after the cursor (forward streaming);
   *                            with `limit`, the next page of them.
   *   - `{ limit }` alone    — the most recent `limit` events (the genuine "tail"),
   *                            still returned oldest-first.
   *   - neither              — the whole log oldest-first.
   *
   * `type` and `runId` filter by exact match in every shape. Ordering is
   * `created_at` then `rowid`, so events written within the same millisecond keep
   * their true insertion order — the same total order {@link list} guarantees.
   */
  tail(agentId: string, options: TailOptions = {}): Event[] {
    requireAgentId(agentId);
    const { limit, sinceId, type, runId } = options;

    const clauses = ["agent_id = ?"];
    const params: SqlValue[] = [agentId];
    if (type !== undefined) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    if (sinceId !== undefined) {
      // Strictly-after the cursor by rowid (a monotonic insertion order), with the
      // cursor itself resolved inside this agent's scope — a foreign id matches no
      // row here and the subquery yields NULL, so `rowid > NULL` returns nothing
      // rather than leaking another agent's tail.
      clauses.push(
        "rowid > (SELECT rowid FROM events WHERE id = ? AND agent_id = ?)",
      );
      params.push(sinceId, agentId);
    }
    const where = clauses.join(" AND ");

    // Without a cursor, `limit` means "the most recent N": select newest-first,
    // cap, then reverse in code to restore oldest-first. With a cursor we are
    // already walking forward from a point, so oldest-first + LIMIT is the page.
    if (limit !== undefined && sinceId === undefined) {
      const rows = this.driver
        .prepare(
          `SELECT * FROM events WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all([...params, limit]);
      return rows.map(mapEvent).reverse();
    }

    const limitSql = limit !== undefined ? " LIMIT ?" : "";
    const finalParams = limit !== undefined ? [...params, limit] : params;
    return this.driver
      .prepare(
        `SELECT * FROM events WHERE ${where} ORDER BY created_at ASC, rowid ASC${limitSql}`,
      )
      .all(finalParams)
      .map(mapEvent);
  }

  /**
   * Read a live tail's starting state in ONE consistent snapshot: the initial
   * backlog (identical to {@link tail} with the same options) AND the cursor to
   * stream strictly after. `cursor` is the id of the newest event matching the
   * type/run filter as of the same snapshot — a true high-water mark over the whole
   * matching log, not just the displayed page, so a capped `--limit`/`--since`
   * backlog still resumes from the latest event rather than replaying its tail.
   * `cursor` falls back to `sinceId` (then undefined) when nothing matches yet.
   *
   * Both reads run in one transaction precisely to close a TOCTOU race: taking the
   * backlog and the high-water as SEPARATE reads lets a concurrent append land
   * between them — newer than the backlog yet counted by the high-water — which
   * would advance the cursor past an event that was never printed and silently drop
   * it from the stream. Scoped to `agentId` like every other read.
   */
  followSnapshot(
    agentId: string,
    options: TailOptions = {},
  ): { events: Event[]; cursor: string | undefined } {
    requireAgentId(agentId);
    return this.driver.transaction(() => {
      const events = this.tail(agentId, options);
      // The newest event matching the type/run filter as of this same snapshot.
      // Deliberately ignores limit/since: the high-water spans the whole matching
      // log, so the stream resumes past every pre-existing event, shown or capped.
      const clauses = ["agent_id = ?"];
      const params: SqlValue[] = [agentId];
      if (options.type !== undefined) {
        clauses.push("type = ?");
        params.push(options.type);
      }
      if (options.runId !== undefined) {
        clauses.push("run_id = ?");
        params.push(options.runId);
      }
      const row = this.driver
        .prepare(
          `SELECT id FROM events WHERE ${clauses.join(" AND ")}
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(params);
      return { events, cursor: row ? String(row.id) : options.sinceId };
    });
  }

  /** How many events the agent's log holds. Scoped like every other read. */
  count(agentId: string): number {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE agent_id = ?`)
      .get([agentId]);
    return row ? Number(row.n) : 0;
  }
}
