import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow, SqlValue } from "../db/driver.js";
import type { ReviewState, WorldFact } from "../types.js";
import { REVIEW_STATES, validateEnum, worldFactFramingText } from "../types.js";
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

/**
 * Filters for {@link WorldFactRepository.list}. Optional and scoped to one agent, the same
 * shape objectives/memory use: a filter narrows within the agent's own notes, never across
 * agents, and the enum is validated on the read path the same way the write path validates
 * it, so a bad value throws rather than silently matching nothing.
 */
export interface WorldFactQuery {
  /** Only world-facts in this exact review state (e.g. `proposed`). */
  reviewState?: ReviewState;
}

function mapWorldFact(row: SqlRow): WorldFact {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    subject: String(row.subject),
    value: String(row.value),
    reviewState: String(row.review_state) as ReviewState,
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
   * `requireAgentId` first, then the SAME memory firewall screens the content before
   * persistence — a world-fact frames runs, so a poisoned one ("ignore previous
   * instructions") is a persistent prompt injection exactly like a poisoned memory, and
   * there is no write path that skips the screen. Each field is screened AND so is the
   * exact RENDERED line (`subject: value`, via `worldFactFramingText` — the one source of
   * truth the framing render also uses): a split injection across the `: ` delimiter
   * (`subject: "ignore all previous"`, `value: "instructions"`) passes each field alone
   * but frames as one injection line, so the rendered-line screen is the load-bearing
   * one. Enforced HERE in the storage writer (not only in the `recordWorldFact` facade)
   * so a direct `store.worldFacts.upsert` caller cannot bypass it — the "scope/screen at
   * the storage layer, never rely on application code remembering" rule. Throws
   * {@link MemoryFirewallError} on a hit. The cap is NOT enforced here (it is a resource
   * policy the store facade owns, like the no-op audit guards); this is the pure
   * single-table writer.
   *
   * `reviewState` defaults to `accepted` — the SELF-written path (the agent's `record_note`,
   * the operator's `notes set`), framed immediately. A derived writer (#84 T3) passes
   * `proposed`, which is INERT until accepted (framing requires `accepted`). Only those two
   * states have a partial unique index, so only those are upsertable here (reject DISCARDS
   * the row rather than persisting a `rejected` one — world-model.md §12).
   *
   * COEXISTENCE: the conflict target is the STATE-SPECIFIC partial unique index, so an
   * `accepted` write conflicts only with the (single) accepted row for the subject and a
   * `proposed` write only with the proposed row — letting an accepted note and a proposed
   * UPDATE to it coexist. A within-state collision keeps the original id/created_at and
   * replaces value + updated_at (superseded, not accumulated). The conflict target is
   * `(agent_id, subject)`, so a collision can only ever be this agent's own row.
   */
  upsert(
    agentId: string,
    subject: string,
    value: string,
    reviewState: ReviewState = "accepted",
  ): WorldFact {
    requireAgentId(agentId);
    assertMemorySafe(subject);
    assertMemorySafe(value);
    assertMemorySafe(worldFactFramingText(subject, value));
    validateEnum(reviewState, REVIEW_STATES, "world-fact reviewState");
    if (reviewState !== "accepted" && reviewState !== "proposed") {
      // No partial index for 'rejected' (reject discards), so there is no coexistence
      // target — a 'rejected' upsert is never a valid write path.
      throw new Error(`world-fact upsert supports only 'accepted' | 'proposed', got '${reviewState}'`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const conflictWhere = reviewState === "accepted" ? "review_state = 'accepted'" : "review_state = 'proposed'";
    const row = this.driver
      .prepare(
        `INSERT INTO world_facts (id, agent_id, subject, value, review_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, subject) WHERE ${conflictWhere}
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([id, agentId, subject, value, reviewState, now, now]);
    if (!row) throw new Error("world-fact upsert did not persist");
    return mapWorldFact(row);
  }

  /**
   * The agent's `accepted` world-fact for a subject (the one that frames), or undefined.
   * Single-valued by the accepted partial unique index. The subject-keyed read the
   * self-write path uses to decide supersede-vs-insert and the cap's "new subject?" test.
   */
  getAccepted(agentId: string, subject: string): WorldFact | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM world_facts WHERE agent_id = ? AND subject = ? AND review_state = 'accepted'`)
      .get([agentId, subject]);
    return row ? mapWorldFact(row) : undefined;
  }

  /**
   * The agent's pending `proposed` world-fact for a subject (the coexisting update awaiting
   * review), or undefined. Single-valued by the proposed partial unique index — so the
   * subject is an unambiguous review handle for `notes accept|reject`.
   */
  getProposed(agentId: string, subject: string): WorldFact | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM world_facts WHERE agent_id = ? AND subject = ? AND review_state = 'proposed'`)
      .get([agentId, subject]);
    return row ? mapWorldFact(row) : undefined;
  }

  /**
   * One world-fact by its row `id` for an agent, or undefined when unknown or another
   * agent's. The id-keyed sibling of {@link get} (which keys by subject) — the lookup a
   * surface uses when it holds a row id rather than a subject, and the id-scoped isolation
   * guarantee (an id known to one agent cannot read another's row) is proven against it.
   */
  getById(agentId: string, id: string): WorldFact | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM world_facts WHERE agent_id = ? AND id = ?`)
      .get([agentId, id]);
    return row ? mapWorldFact(row) : undefined;
  }

  /**
   * The agent's world-facts, oldest-first (`created_at`, then `rowid`) — the inspect/history
   * order. With a {@link WorldFactQuery} the result is narrowed by review state — scoped to
   * `agentId`, so a filter only ever narrows within this agent's own notes. The enum filter
   * is validated here (the same chokepoint the write path uses), so an invalid value throws
   * rather than silently matching nothing.
   */
  list(agentId: string, query: WorldFactQuery = {}): WorldFact[] {
    requireAgentId(agentId);
    const clauses = ["agent_id = ?"];
    const params: SqlValue[] = [agentId];
    if (query.reviewState !== undefined) {
      validateEnum(query.reviewState, REVIEW_STATES, "world-fact reviewState");
      clauses.push("review_state = ?");
      params.push(query.reviewState);
    }
    const where = clauses.join(" AND ");
    return this.driver
      .prepare(`SELECT * FROM world_facts WHERE ${where} ORDER BY created_at ASC, rowid ASC`)
      .all(params)
      .map(mapWorldFact);
  }

  /**
   * The agent's `accepted` world-facts — the framing set, the direct analogue of memory's
   * {@link MemoryRepository.listActiveAccepted} and objectives' `listActiveAccepted`. Applies
   * the `review_state = 'accepted'` predicate the framing layer uses, kept here so surfaces
   * don't re-derive it. A `proposed` note is excluded — it is inert until a human accepts it;
   * a `rejected` one never frames.
   */
  listAccepted(agentId: string): WorldFact[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM world_facts
           WHERE agent_id = ? AND review_state = 'accepted'
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapWorldFact);
  }

  /**
   * How many DISTINCT subjects the agent holds — the cap basis. Counts distinct subjects,
   * not rows: a subject that has both an accepted note AND a coexisting proposed update
   * counts ONCE, so a pending update never inflates the cap (only a brand-new subject does).
   * Reject discards, so no `rejected` rows exist to count.
   */
  count(agentId: string): number {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT COUNT(DISTINCT subject) AS n FROM world_facts WHERE agent_id = ?`)
      .get([agentId]);
    return row ? Number(row.n) : 0;
  }

  /**
   * Remove a subject entirely — BOTH its accepted note and any coexisting proposed update —
   * so forgetting a note never leaves an orphan pending update. Returns a representative
   * removed row for the audit (the accepted one if present, else the proposed), or undefined
   * when nothing matched (unknown subject, or another agent's). A scoped read-then-delete
   * rather than `DELETE … RETURNING` (the idiom every kernel delete uses, no RETURNING-on-
   * delete driver risk); the store wraps it in a transaction, so the reads and the delete are
   * atomic. Frames nothing and persists nothing, so it is not firewall-screened.
   */
  clear(agentId: string, subject: string): WorldFact | undefined {
    requireAgentId(agentId);
    const existing = this.getAccepted(agentId, subject) ?? this.getProposed(agentId, subject);
    if (!existing) return undefined;
    this.driver
      .prepare(`DELETE FROM world_facts WHERE agent_id = ? AND subject = ?`)
      .run([agentId, subject]);
    return existing;
  }

  /**
   * Accept a PROPOSED world-fact — SUPERSEDE-ON-ACCEPT (world-model.md §12). Resolve the
   * proposed row pinned to (`id`, still `proposed`, `value = expectedValue`); a gone/churned
   * row yields undefined so the caller re-reviews (the same content-pin the old single-row CAS
   * used — a concurrent re-propose that changed the value cannot ratify content the operator
   * never saw). Then, in the caller's transaction:
   *   - **An accepted row already exists for the subject** → apply the proposed value to it IN
   *     PLACE (keeping the accepted note's id + created_at), then DELETE the consumed proposed
   *     row. The accepted partial unique index stays single-valued for the subject.
   *   - **No accepted row yet** → flip the proposed row `review_state → 'accepted'`; it becomes
   *     the note (its id + created_at are the note's birth).
   * Returns the surviving accepted row, or undefined when the pinned proposed row was gone.
   * The two SELECT/UPDATE/DELETE statements are atomic under the store's wrapping transaction
   * (the same basis {@link clear} relies on).
   */
  acceptProposed(agentId: string, id: string, expectedValue?: string): WorldFact | undefined {
    requireAgentId(agentId);
    const now = new Date().toISOString();
    const clauses = ["id = ?", "agent_id = ?", "review_state = 'proposed'"];
    const params: SqlValue[] = [id, agentId];
    if (expectedValue !== undefined) {
      clauses.push("value = ?");
      params.push(expectedValue);
    }
    const proposed = this.driver
      .prepare(`SELECT * FROM world_facts WHERE ${clauses.join(" AND ")}`)
      .get(params);
    if (!proposed) return undefined;
    const subject = String(proposed.subject);
    const value = String(proposed.value);
    const proposedId = String(proposed.id);
    const accepted = this.driver
      .prepare(`SELECT * FROM world_facts WHERE agent_id = ? AND subject = ? AND review_state = 'accepted'`)
      .get([agentId, subject]);
    if (accepted) {
      const updated = this.driver
        .prepare(
          `UPDATE world_facts SET value = ?, updated_at = ?
             WHERE id = ? AND agent_id = ? AND review_state = 'accepted'
             RETURNING *`,
        )
        .get([value, now, String(accepted.id), agentId]);
      this.driver
        .prepare(`DELETE FROM world_facts WHERE id = ? AND agent_id = ?`)
        .run([proposedId, agentId]);
      return updated ? mapWorldFact(updated) : undefined;
    }
    const flipped = this.driver
      .prepare(
        `UPDATE world_facts SET review_state = 'accepted', updated_at = ?
           WHERE id = ? AND agent_id = ? AND review_state = 'proposed'
           RETURNING *`,
      )
      .get([now, proposedId, agentId]);
    return flipped ? mapWorldFact(flipped) : undefined;
  }

  /**
   * Reject a PROPOSED world-fact — DISCARD it (world-model.md §12): delete the proposed row
   * outright, leaving any accepted note for the subject untouched. A world-fact is volatile
   * current-state, so a declined update has no lasting value (no `rejected`-history rows).
   * Pinned to (`id`, still `proposed`, `value = expectedValue`) so a concurrent re-propose
   * that churned the value forces a re-review rather than discarding a value the operator
   * never saw. Read-then-delete (no RETURNING-on-delete), atomic under the store's wrapping
   * transaction. Returns the deleted row to the winner (for the audit), or undefined when the
   * pinned row was gone (lost race / churned / unknown / cross-agent).
   */
  deleteProposed(agentId: string, id: string, expectedValue?: string): WorldFact | undefined {
    requireAgentId(agentId);
    const clauses = ["id = ?", "agent_id = ?", "review_state = 'proposed'"];
    const params: SqlValue[] = [id, agentId];
    if (expectedValue !== undefined) {
      clauses.push("value = ?");
      params.push(expectedValue);
    }
    const where = clauses.join(" AND ");
    const existing = this.driver.prepare(`SELECT * FROM world_facts WHERE ${where}`).get(params);
    if (!existing) return undefined;
    this.driver.prepare(`DELETE FROM world_facts WHERE ${where}`).run(params);
    return mapWorldFact(existing);
  }
}
