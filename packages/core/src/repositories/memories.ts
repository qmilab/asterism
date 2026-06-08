import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver";
import type { Memory, MemoryStatus, MemoryType, ReviewState } from "../types";
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  REVIEW_STATES,
  validateEnum,
} from "../types";
import { requireAgentId } from "./scope";

export interface CreateMemoryInput {
  memoryType: MemoryType;
  content: string;
  confidence?: number;
  sourceRunId?: string;
  status?: MemoryStatus;
  reviewState?: ReviewState;
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

  list(agentId: string): Memory[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM memories WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapMemory);
  }

  setReviewState(
    agentId: string,
    id: string,
    reviewState: ReviewState,
  ): Memory | undefined {
    requireAgentId(agentId);
    validateEnum(reviewState, REVIEW_STATES, "memory reviewState");
    const row = this.driver
      .prepare(
        `UPDATE memories SET review_state = ? WHERE id = ? AND agent_id = ? RETURNING *`,
      )
      .get([reviewState, id, agentId]);
    return row ? mapMemory(row) : undefined;
  }
}
