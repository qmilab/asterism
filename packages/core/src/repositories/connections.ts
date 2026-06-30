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
