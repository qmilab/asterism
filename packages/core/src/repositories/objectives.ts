import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow, SqlValue } from "../db/driver.js";
import type { Objective, ObjectiveStatus, ReviewState } from "../types.js";
import { OBJECTIVE_STATUSES, REVIEW_STATES, validateEnum } from "../types.js";
import { assertMemorySafe } from "../firewall.js";
import { requireAgentId } from "./scope.js";

export interface CreateObjectiveInput {
  content: string;
  /**
   * Ratification state on create. Defaults to `accepted` — the operator-declared path,
   * implicitly ratified by the human typing it. Reflection's proposed-objective path
   * passes `proposed`, so the row is inert (framing requires `accepted`) until a human
   * accepts it. Mirrors {@link CreateMemoryInput.reviewState}.
   */
  reviewState?: ReviewState;
  /**
   * The run a reflection PROPOSAL was noticed in — set on the proposed path so the Type-B
   * transition advisory can later judge that source run. Omitted for an operator-declared
   * objective (provenance only; it never gates framing). Mirrors {@link CreateMemoryInput.sourceRunId}.
   */
  sourceRunId?: string;
}

/**
 * Filters for {@link ObjectiveRepository.list}. Both optional and AND-combined, each
 * narrowing within one agent's objectives (never across agents — the query is always
 * `agentId`-scoped), and validated on the read path the same way the write path
 * validates them, so a bad value is a clear error rather than a silent empty result.
 */
export interface ObjectiveQuery {
  /** Only objectives in this exact lifecycle state. */
  status?: ObjectiveStatus;
  /** Only objectives in this exact review state (e.g. `proposed`). */
  reviewState?: ReviewState;
}

function mapObjective(row: SqlRow): Objective {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    content: String(row.content),
    status: String(row.status) as ObjectiveStatus,
    reviewState: String(row.review_state) as ReviewState,
    ...(row.source_run_id != null ? { sourceRunId: String(row.source_run_id) } : {}),
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
   * Throws {@link MemoryFirewallError} on a hit. `reviewState` defaults to `accepted`
   * (the operator-declared path); a reflection proposal passes `proposed`, which is
   * inert until accepted (framing requires `accepted`). `created_at` and `updated_at`
   * start equal; `updated_at` advances on a later lifecycle or review change.
   */
  create(agentId: string, input: CreateObjectiveInput): Objective {
    requireAgentId(agentId);
    assertMemorySafe(input.content);
    const reviewState = input.reviewState ?? "accepted";
    validateEnum(reviewState, REVIEW_STATES, "objective reviewState");
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO objectives
           (id, agent_id, content, status, review_state, source_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([id, agentId, input.content, "active", reviewState, input.sourceRunId ?? null, now, now]);
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
    if (query.reviewState !== undefined) {
      validateEnum(query.reviewState, REVIEW_STATES, "objective reviewState");
      clauses.push("review_state = ?");
      params.push(query.reviewState);
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
   * The agent's active, accepted objectives — the framing set, the direct analogue of
   * memory's {@link MemoryRepository.listActiveAccepted}. Applies the same
   * `status = 'active' AND review_state = 'accepted'` predicate the framing layer uses,
   * kept here so surfaces don't re-derive it. A `proposed` objective is excluded — it
   * is inert until a human accepts it.
   */
  listActiveAccepted(agentId: string): Objective[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM objectives
           WHERE agent_id = ? AND status = 'active' AND review_state = 'accepted'
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

  /**
   * Atomically settle a PROPOSED objective: flip `review_state` from `proposed` to
   * `reviewState` in a SINGLE compare-and-set, the direct analogue of
   * {@link MemoryRepository.settleProposed}. The `review_state = 'proposed'`
   * precondition lives in the UPDATE's WHERE clause, so two concurrent drains over one
   * proposal cannot both win: the first transitions it and the second matches nothing.
   * Advances `updated_at` (the review is a real transition). `status` is untouched — an
   * accepted objective stays `active` (and now frames), a rejected one stays `active`
   * but no longer frames (review_state gates framing). Returns the settled row to the
   * winner, or undefined to a caller that lost the race (or named an unknown /
   * already-settled id).
   */
  settleProposed(
    agentId: string,
    id: string,
    reviewState: ReviewState,
  ): Objective | undefined {
    requireAgentId(agentId);
    validateEnum(reviewState, REVIEW_STATES, "objective reviewState");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE objectives SET review_state = ?, updated_at = ?
          WHERE id = ? AND agent_id = ? AND review_state = 'proposed'
          RETURNING *`,
      )
      .get([reviewState, now, id, agentId]);
    return row ? mapObjective(row) : undefined;
  }
}
