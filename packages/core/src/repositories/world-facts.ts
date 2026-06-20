import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { WorldFact } from "../types.js";
import { assertMemorySafe } from "../firewall.js";
import { requireAgentId } from "./scope.js";

/**
 * The hard per-agent cap on the number of distinct world-fact subjects an agent may
 * hold. World-facts are the one framing input the agent writes WITHOUT per-write human
 * review, so the kernel bounds how much of them can accumulate and grow a run's
 * framing. Superseding an existing subject never grows the count (it is an upsert), so
 * the cap only bites a NEW subject when the agent is already full — at which point the
 * write is rejected loudly (a {@link WorldFactCapError}), never silently evicted. A
 * per-agent override is a deferred additive follow-up on the `agent_settings` home
 * (exactly as the recall budget was); this constant is the kernel default until then.
 */
export const DEFAULT_WORLD_FACT_CAP = 32;

/**
 * Thrown when recording a NEW world-fact subject would exceed the agent's cap. The
 * store turns it into a tool `isError` result the model can react to ("your working
 * notes are full"); it is a resource bound, not a safety refusal, so — unlike a
 * firewall block — it is not audited as an event.
 */
export class WorldFactCapError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(`world-fact cap reached (${cap} max)`);
    this.name = "WorldFactCapError";
    this.cap = cap;
  }
}

function mapWorldFact(row: SqlRow): WorldFact {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    subject: String(row.subject),
    value: String(row.value),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The world-facts store — an agent's own running record of its current situation
 * ("working notes"), scoped by `agentId` like every other repository (the agent is
 * the isolation boundary). Mirrors {@link ObjectiveRepository}: `requireAgentId`
 * guards every method, and because a world-fact's `subject` and `value` frame runs,
 * both are firewall-screened on the write path exactly like memory. World-facts for
 * agent A can never be read, written, or cleared through agent B's id.
 */
export class WorldFactRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Record or SUPERSEDE a world-fact: an upsert keyed by `(agent_id, subject)`. A new
   * subject inserts; an existing one REPLACES its `value` and advances `updated_at`
   * (superseded, not accumulated) while preserving `created_at` and the row id.
   * `requireAgentId` first, then the SAME memory firewall screens BOTH `subject` and
   * `value` before persistence — a world-fact frames runs, so a poisoned one ("ignore
   * previous instructions") is a persistent prompt injection exactly like a poisoned
   * memory, and there is no write path that skips the screen. Throws
   * {@link MemoryFirewallError} on a hit. The cap is NOT enforced here (it is policy the
   * store facade owns); this is the pure single-table writer.
   */
  upsert(agentId: string, subject: string, value: string): WorldFact {
    requireAgentId(agentId);
    assertMemorySafe(subject);
    assertMemorySafe(value);
    const id = randomUUID();
    const now = new Date().toISOString();
    // ON CONFLICT(agent_id, subject): keep the original id/created_at, replace value +
    // updated_at. The conflict target is the table's UNIQUE(agent_id, subject), so the
    // upsert is itself agent-scoped — a subject collision can only ever be this agent's
    // own row.
    const row = this.driver
      .prepare(
        `INSERT INTO world_facts (id, agent_id, subject, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, subject)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([id, agentId, subject, value, now, now]);
    if (!row) throw new Error("world-fact upsert did not persist");
    return mapWorldFact(row);
  }

  /** One world-fact by subject for an agent, or undefined when unknown or another agent's. */
  get(agentId: string, subject: string): WorldFact | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM world_facts WHERE agent_id = ? AND subject = ?`)
      .get([agentId, subject]);
    return row ? mapWorldFact(row) : undefined;
  }

  /** The agent's world-facts, oldest-first (`created_at`, then `rowid`) — the framing order. */
  list(agentId: string): WorldFact[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(`SELECT * FROM world_facts WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all([agentId])
      .map(mapWorldFact);
  }

  /** How many world-facts the agent holds — the count the cap is checked against. */
  count(agentId: string): number {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT COUNT(*) AS n FROM world_facts WHERE agent_id = ?`)
      .get([agentId]);
    return row ? Number(row.n) : 0;
  }

  /**
   * Remove one world-fact by subject — returns the row that was removed (so the caller
   * can audit it), or undefined when nothing matched (unknown subject, or another
   * agent's). A scoped read-then-delete rather than `DELETE … RETURNING`: the row is
   * needed for the audit, and a plain `DELETE` keeps to the idiom every other delete in
   * the kernel uses (no reliance on RETURNING for a delete). The store wraps this in a
   * transaction, so the read and the delete are atomic. Frames nothing and persists
   * nothing, so — unlike the record path — it is not firewall-screened.
   */
  clear(agentId: string, subject: string): WorldFact | undefined {
    requireAgentId(agentId);
    const existing = this.get(agentId, subject);
    if (!existing) return undefined;
    this.driver
      .prepare(`DELETE FROM world_facts WHERE agent_id = ? AND subject = ?`)
      .run([agentId, subject]);
    return existing;
  }
}
