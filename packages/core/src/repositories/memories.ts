import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow, SqlValue } from "../db/driver.js";
import type { Memory, MemoryStatus, MemoryType, ReviewState } from "../types.js";
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  REVIEW_STATES,
  validateEnum,
} from "../types.js";
import { assertMemorySafe } from "../firewall.js";
import { requireAgentId } from "./scope.js";

export interface CreateMemoryInput {
  memoryType: MemoryType;
  content: string;
  confidence?: number;
  sourceRunId?: string;
  status?: MemoryStatus;
  reviewState?: ReviewState;
}

/**
 * Filters for {@link MemoryRepository.list}. All optional and AND-combined; with
 * none given, `list` returns the agent's whole memory oldest-first. Every shape is
 * still scoped to the `agentId` — a filter narrows within one agent's memory, it
 * never reaches across agents. The enum-valued fields are validated on the read
 * path the same way the write path validates them, so a bad value is a clear error
 * rather than a silent empty result.
 */
export interface MemoryQuery {
  /** Only memories of this exact type. */
  memoryType?: MemoryType;
  /** Only memories in this review state (e.g. `proposed`). */
  reviewState?: ReviewState;
  /** Only memories proposed from this source run. Matched exactly within scope. */
  sourceRunId?: string;
}

function mapMemory(row: SqlRow): Memory {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    memoryType: String(row.memory_type) as MemoryType,
    content: String(row.content),
    confidence: Number(row.confidence),
    ...(row.source_run_id != null
      ? { sourceRunId: String(row.source_run_id) }
      : {}),
    status: String(row.status) as MemoryStatus,
    reviewState: String(row.review_state) as ReviewState,
    createdAt: String(row.created_at),
  };
}

export class MemoryRepository {
  constructor(private readonly driver: SqlDriver) {}

  create(agentId: string, input: CreateMemoryInput): Memory {
    requireAgentId(agentId);
    // The memory firewall screens every inbound write before persistence — there
    // is no create path that bypasses it. Throws MemoryFirewallError on a hit.
    assertMemorySafe(input.content);
    validateEnum(input.memoryType, MEMORY_TYPES, "memoryType");
    const status = input.status ?? "active";
    validateEnum(status, MEMORY_STATUSES, "memory status");
    const reviewState = input.reviewState ?? "accepted";
    validateEnum(reviewState, REVIEW_STATES, "memory reviewState");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO memories
           (id, agent_id, memory_type, content, confidence, source_run_id, status, review_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([
        id,
        agentId,
        input.memoryType,
        input.content,
        input.confidence ?? 1,
        input.sourceRunId ?? null,
        status,
        reviewState,
        createdAt,
      ]);
    if (!row) throw new Error("memory insert did not persist");
    return mapMemory(row);
  }

  get(agentId: string, id: string): Memory | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM memories WHERE id = ? AND agent_id = ?`)
      .get([id, agentId]);
    return row ? mapMemory(row) : undefined;
  }

  /**
   * The agent's memories, oldest-first. With a {@link MemoryQuery} the result is
   * narrowed by type / review state / source run — every filter AND-combined and
   * scoped to `agentId`, so a filter only ever narrows within this agent's own
   * memory. The enum-valued filters are validated here (the same chokepoint the
   * write path uses), so an invalid value throws rather than silently matching
   * nothing. Ordering is `created_at` then `rowid`, the same total order across all
   * shapes.
   */
  list(agentId: string, query: MemoryQuery = {}): Memory[] {
    requireAgentId(agentId);
    const clauses = ["agent_id = ?"];
    const params: SqlValue[] = [agentId];
    if (query.memoryType !== undefined) {
      validateEnum(query.memoryType, MEMORY_TYPES, "memoryType");
      clauses.push("memory_type = ?");
      params.push(query.memoryType);
    }
    if (query.reviewState !== undefined) {
      validateEnum(query.reviewState, REVIEW_STATES, "memory reviewState");
      clauses.push("review_state = ?");
      params.push(query.reviewState);
    }
    if (query.sourceRunId !== undefined) {
      clauses.push("source_run_id = ?");
      params.push(query.sourceRunId);
    }
    const where = clauses.join(" AND ");
    return this.driver
      .prepare(
        `SELECT * FROM memories WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(params)
      .map(mapMemory);
  }

  /**
   * The agent's active, accepted memories — the ones that frame its runs and that
   * reflection treats as already known. Applies the same active+accepted predicate
   * the framing layer uses, kept here so surfaces don't re-derive it.
   */
  listActiveAccepted(agentId: string): Memory[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM memories
           WHERE agent_id = ? AND status = 'active' AND review_state = 'accepted'
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapMemory);
  }

  /**
   * Atomically settle a PROPOSED memory: flip `review_state` from `proposed` to
   * `reviewState` in a SINGLE compare-and-set — the same single-winner discipline the
   * run-claim CAS uses ({@link RunRepository.claimForResume} / `claimForDecline`). The
   * `review_state = 'proposed'` precondition lives in the UPDATE's WHERE clause, so two
   * concurrent drains over one proposal cannot both win: the first transitions it and the
   * second matches nothing. Returns the settled row to the winner, or undefined to a caller
   * that lost the race (or named an unknown / already-settled id). This is what keeps a
   * rejected proposal from being resurrected to `accepted` by a racing accept, and one
   * proposal from yielding two accepted memories under concurrent edited-accepts.
   */
  settleProposed(
    agentId: string,
    id: string,
    reviewState: ReviewState,
  ): Memory | undefined {
    requireAgentId(agentId);
    validateEnum(reviewState, REVIEW_STATES, "memory reviewState");
    const row = this.driver
      .prepare(
        `UPDATE memories SET review_state = ?
          WHERE id = ? AND agent_id = ? AND review_state = 'proposed'
          RETURNING *`,
      )
      .get([reviewState, id, agentId]);
    return row ? mapMemory(row) : undefined;
  }
}
