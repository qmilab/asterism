import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow, SqlValue } from "../db/driver.js";
import type { Objective, ObjectiveStatus } from "../types.js";
import { OBJECTIVE_STATUSES, validateEnum } from "../types.js";
import { assertMemorySafe } from "../firewall.js";
import { requireAgentId } from "./scope.js";

export interface CreateObjectiveInput {
  content: string;
}

/**
 * Filter for {@link ObjectiveRepository.list}. The single optional `status` narrows
 * within one agent's objectives (it never reaches across agents — the query is always
 * `agentId`-scoped), and is validated on the read path the same way the write path
 * validates it, so a bad value is a clear error rather than a silent empty result.
 */
export interface ObjectiveQuery {
  /** Only objectives in this exact lifecycle state. */
  status?: ObjectiveStatus;
}

function mapObjective(row: SqlRow): Objective {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    content: String(row.content),
    status: String(row.status) as ObjectiveStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The standing-objectives store — an agent's durable, operator-declared current
 * purpose, scoped by `agentId` like every other repository (the agent is the
 * isolation boundary). Mirrors {@link MemoryRepository}: `requireAgentId` guards
 * every method, and because an objective's content frames runs it is firewall-
 * screened on the write path exactly like memory. Objectives for agent A can never
 * be read or written through agent B's id.
 */
export class ObjectiveRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Create a new `active` objective. `requireAgentId` first, then the SAME memory
   * firewall screens the content before persistence — an objective frames runs, so a
   * poisoned one ("ignore previous instructions") is a persistent prompt injection
   * exactly like a poisoned memory, and there is no create path that skips the screen.
   * Throws {@link MemoryFirewallError} on a hit. `created_at` and `updated_at` start
   * equal; `updated_at` advances on a later lifecycle change.
   */
  create(agentId: string, input: CreateObjectiveInput): Objective {
    requireAgentId(agentId);
    assertMemorySafe(input.content);
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO objectives (id, agent_id, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([id, agentId, input.content, "active", now, now]);
    if (!row) throw new Error("objective insert did not persist");
    return mapObjective(row);
  }

  /** One objective for an agent, or undefined when it is unknown or another agent's. */
  get(agentId: string, id: string): Objective | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM objectives WHERE id = ? AND agent_id = ?`)
      .get([id, agentId]);
    return row ? mapObjective(row) : undefined;
  }

  /**
   * The agent's objectives, oldest-first. With an {@link ObjectiveQuery} the result
   * is narrowed by lifecycle state — scoped to `agentId`, so a filter only ever
   * narrows within this agent's own objectives. The enum filter is validated here
   * (the same chokepoint the write path uses), so an invalid value throws rather than
   * silently matching nothing. Ordering is `created_at` then `rowid`.
   */
  list(agentId: string, query: ObjectiveQuery = {}): Objective[] {
    requireAgentId(agentId);
    const clauses = ["agent_id = ?"];
    const params: SqlValue[] = [agentId];
    if (query.status !== undefined) {
      validateEnum(query.status, OBJECTIVE_STATUSES, "objective status");
      clauses.push("status = ?");
      params.push(query.status);
    }
    const where = clauses.join(" AND ");
    return this.driver
      .prepare(
        `SELECT * FROM objectives WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(params)
      .map(mapObjective);
  }

  /**
   * The agent's active objectives — the framing set (the `listActiveAccepted`
   * analogue for memory). Applies the same `status = 'active'` predicate the framing
   * layer uses, kept here so surfaces don't re-derive it.
   */
  listActive(agentId: string): Objective[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM objectives WHERE agent_id = ? AND status = 'active'
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapObjective);
  }

  /**
   * Advance an objective's lifecycle — a scoped, CAS-style
   * `UPDATE ... WHERE id = ? AND agent_id = ? RETURNING *` that also advances
   * `updated_at`. The target status is validated through the same enum chokepoint the
   * rest of the kernel uses, so a bad value can never be stored. Returns the updated
   * row to the owner, or undefined for an unknown / cross-agent id (the contract every
   * scoped repository uses).
   */
  setStatus(agentId: string, id: string, status: ObjectiveStatus): Objective | undefined {
    requireAgentId(agentId);
    validateEnum(status, OBJECTIVE_STATUSES, "objective status");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE objectives SET status = ?, updated_at = ?
          WHERE id = ? AND agent_id = ?
          RETURNING *`,
      )
      .get([status, now, id, agentId]);
    return row ? mapObjective(row) : undefined;
  }
}
