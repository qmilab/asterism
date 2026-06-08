import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow, SqlValue } from "../db/driver";
import type { Event } from "../types";
import { requireAgentId } from "./scope";

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
   * Read an agent's events for tailing — always returned oldest-first so a reader
   * sees them in the order they happened. Three shapes, all scoped to `agentId`:
   *
   *   - `{ sinceId }`        — only events after the cursor (forward streaming);
   *                            with `limit`, the next page of them.
   *   - `{ limit }` alone    — the most recent `limit` events (the genuine "tail"),
   *                            still returned oldest-first.
   *   - neither              — the whole log oldest-first.
   *
   * `type` filters by exact event type in every shape. Ordering is `created_at`
   * then `rowid`, so events written within the same millisecond keep their true
   * insertion order — the same total order {@link list} guarantees.
   */
  tail(agentId: string, options: TailOptions = {}): Event[] {
    requireAgentId(agentId);
    const { limit, sinceId, type } = options;

    const clauses = ["agent_id = ?"];
    const params: SqlValue[] = [agentId];
    if (type !== undefined) {
      clauses.push("type = ?");
      params.push(type);
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

  /** How many events the agent's log holds. Scoped like every other read. */
  count(agentId: string): number {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE agent_id = ?`)
      .get([agentId]);
    return row ? Number(row.n) : 0;
  }
}
