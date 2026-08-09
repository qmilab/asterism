import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { Connection, ConnectionMode } from "../types.js";
import { CONNECTION_MODES, validateEnum } from "../types.js";
import { requireAgentId } from "./scope.js";

/**
 * Public input for creating a connection. Directional: `fromAgentId → toAgentId`. The
 * `mode` is the exchange form (T1: `handoff`). `status` is not settable here — a new
 * connection is always `active` (the create default); a later revoke is its own
 * transition.
 */
export interface CreateConnectionInput {
  fromAgentId: string;
  toAgentId: string;
  mode: ConnectionMode;
}

function mapConnection(row: SqlRow): Connection {
  return {
    id: String(row.id),
    fromAgentId: String(row.from_agent_id),
    toAgentId: String(row.to_agent_id),
    mode: String(row.mode) as ConnectionMode,
    status: String(row.status) as Connection["status"],
    createdAt: String(row.created_at),
  };
}

/**
 * The connections store — the explicit, permissioned channels between agents. Unlike
 * every other repository a connection row links TWO agents, so scoping is "filter by a
 * participant" rather than a single `agent_id` column: `create`/`findActive` assert BOTH
 * ids; `listForAgent`/`get` assert the one agent and only ever match a connection that
 * agent participates in (`from_agent_id = ? OR to_agent_id = ?`). A connection for the
 * pair (A, B) is therefore reachable through A's id or B's id, but never through a third
 * agent C's — the agent is still the isolation boundary.
 *
 * The status lifecycle is `active → revoked`, one way. {@link create} is the only writer of
 * `active` and {@link revoke} the only writer of `revoked`; nothing here can move a row
 * back. Reads split on it deliberately: {@link findActive} and {@link listActiveForPair}
 * enforce the permission (a revoked channel authorizes nothing), while {@link get} and
 * {@link listForAgent} report HISTORY and return every status — an operator must be able to
 * see that a channel was withdrawn, and a resume must be able to discover that the grant its
 * run arrived under no longer holds.
 */
export class ConnectionRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Create a new `active`, directional connection. Asserts BOTH participant ids (a
   * connection has no meaning without both) and validates the mode through the same enum
   * chokepoint the rest of the kernel uses, so a mode nothing implements can never be
   * persisted. The caller (the store) is responsible for not creating a duplicate active
   * connection — the partial unique index `(from, to, mode) WHERE status = 'active'` is
   * the storage-layer backstop that makes a concurrent double-create fail rather than
   * silently duplicate.
   */
  create(input: CreateConnectionInput): Connection {
    requireAgentId(input.fromAgentId);
    requireAgentId(input.toAgentId);
    validateEnum(input.mode, CONNECTION_MODES, "connection mode");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO connections (id, from_agent_id, to_agent_id, mode, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         RETURNING *`,
      )
      .get([id, input.fromAgentId, input.toAgentId, input.mode, createdAt]);
    if (!row) throw new Error("connection insert did not persist");
    return mapConnection(row);
  }

  /**
   * The ACTIVE connection granting `fromAgentId → toAgentId` in `mode`, or undefined when
   * there is none. This is the kernel's permission check for a handoff: no active
   * connection ⇒ no interaction (default isolation holds). Asserts both ids and validates
   * the mode (so a bad mode is a clear error, not a silent miss). Directional by design —
   * an active B→A connection does NOT satisfy a query for A→B.
   */
  findActive(
    fromAgentId: string,
    toAgentId: string,
    mode: ConnectionMode,
  ): Connection | undefined {
    requireAgentId(fromAgentId);
    requireAgentId(toAgentId);
    validateEnum(mode, CONNECTION_MODES, "connection mode");
    const row = this.driver
      .prepare(
        `SELECT * FROM connections
           WHERE from_agent_id = ? AND to_agent_id = ? AND mode = ? AND status = 'active'`,
      )
      .get([fromAgentId, toAgentId, mode]);
    return row ? mapConnection(row) : undefined;
  }

  /**
   * Revoke the ACTIVE `fromAgentId → toAgentId` connection in `mode`, returning the row as
   * it now stands, or undefined when there was no active connection to revoke.
   *
   * The whole transition, as one atomic compare-and-set: `WHERE … status = 'active'` is the
   * comparison and `SET status = 'revoked'` is the set, so two concurrent revokes cannot
   * both report success and cannot both emit an event — exactly one `UPDATE` matches a row
   * and the loser gets undefined. The same predicate makes a re-revoke a clean no-op rather
   * than a second withdrawal of something already withdrawn.
   *
   * Terminal by design, and by omission: there is no reverse transition here and no way to
   * write `status = 'active'` onto an existing row anywhere in this repository. Restoring a
   * revoked connection would resurrect the fetchability of everything exchanged over its id
   * (`exchanges` authorization is keyed on `connection_id`), so the only way back is
   * {@link create}, which mints a fresh row that old references do not resolve over.
   *
   * Scoped exactly like {@link findActive}, and for the same reason: a revoke names a
   * DIRECTED pair in one mode, so it can only ever touch the triple it was called for —
   * never the reverse direction, never another mode between the same two agents, never
   * another pair.
   */
  revoke(
    fromAgentId: string,
    toAgentId: string,
    mode: ConnectionMode,
  ): Connection | undefined {
    requireAgentId(fromAgentId);
    requireAgentId(toAgentId);
    validateEnum(mode, CONNECTION_MODES, "connection mode");
    const row = this.driver
      .prepare(
        `UPDATE connections SET status = 'revoked'
           WHERE from_agent_id = ? AND to_agent_id = ? AND mode = ? AND status = 'active'
         RETURNING *`,
      )
      .get([fromAgentId, toAgentId, mode]);
    return row ? mapConnection(row) : undefined;
  }

  /**
   * Every ACTIVE connection from `fromAgentId` to `toAgentId`, in any mode, oldest-first.
   *
   * The pair-scoped read behind `disconnect`'s mode inference: a surface can tell "this pair
   * has exactly one open channel" from "it has several" without guessing which one the
   * operator meant. Asserts BOTH ids like every other pair read, so it can never enumerate
   * channels belonging to agents it was not called for.
   */
  listActiveForPair(fromAgentId: string, toAgentId: string): Connection[] {
    requireAgentId(fromAgentId);
    requireAgentId(toAgentId);
    return this.driver
      .prepare(
        `SELECT * FROM connections
           WHERE from_agent_id = ? AND to_agent_id = ? AND status = 'active'
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([fromAgentId, toAgentId])
      .map(mapConnection);
  }

  /**
   * Every connection `agentId` participates in — outbound (it is `from`) AND inbound (it
   * is `to`) — oldest-first. Scoped: the `from_agent_id = ? OR to_agent_id = ?` predicate
   * means a connection between two OTHER agents can never appear here. Ordering is
   * `created_at` then `rowid`, the same stable total order every other list uses.
   */
  listForAgent(agentId: string): Connection[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM connections
           WHERE from_agent_id = ? OR to_agent_id = ?
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId, agentId])
      .map(mapConnection);
  }

  /**
   * One connection by id, but ONLY if `agentId` participates in it (as `from` or `to`).
   * An id for a connection this agent is not part of matches nothing and returns
   * undefined — indistinguishable from an unknown id, which is the point: an agent can
   * never read a channel it is not on. Mirrors the scoped `get` every other repository
   * exposes.
   */
  get(agentId: string, id: string): Connection | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(
        `SELECT * FROM connections
           WHERE id = ? AND (from_agent_id = ? OR to_agent_id = ?)`,
      )
      .get([id, agentId, agentId]);
    return row ? mapConnection(row) : undefined;
  }
}
