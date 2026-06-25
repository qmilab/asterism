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
 * Thrown when PROPOSING a world-fact whose subject already holds an `accepted` row. The
 * single-row-per-subject model (the `UNIQUE(agent_id, subject)` constraint is unchanged)
 * forbids a `proposed` and an `accepted` row coexisting for one subject, so an unreviewed
 * proposed write must never upsert-clobber a ratified note — that would silently drop it
 * from framing and destroy its value. So {@link AsterismStore.proposeWorldFact} refuses
 * loudly instead. A governance refusal, NOT a resource bound: no content reached the
 * firewall, so — unlike a firewall block — it is not audited as an event. The clean
 * proposed-vs-accepted-same-subject *supersession* policy is deferred to the derived-fact
 * producer (#84 T3), which owns that decision (world-model.md §11.1).
 */
export class WorldFactConflictError extends Error {
  readonly subject: string;
  constructor(subject: string) {
    super(`world-fact subject already accepted: ${subject}`);
    this.name = "WorldFactConflictError";
    this.subject = subject;
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
   * the operator's `notes set`), framed immediately, byte-for-byte today. A future derived
   * writer (#84 T3) passes `proposed`, which is INERT until accepted (framing requires
   * `accepted`). On a subject collision the upsert REPLACES the review state too, so
   * re-asserting a subject re-ratifies it to the passed state.
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
    const id = randomUUID();
    const now = new Date().toISOString();
    // ON CONFLICT(agent_id, subject): keep the original id/created_at, replace value +
    // review_state + updated_at. The conflict target is the table's UNIQUE(agent_id,
    // subject), so the upsert is itself agent-scoped — a subject collision can only ever
    // be this agent's own row.
    const row = this.driver
      .prepare(
        `INSERT INTO world_facts (id, agent_id, subject, value, review_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, subject)
         DO UPDATE SET value = excluded.value, review_state = excluded.review_state, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([id, agentId, subject, value, reviewState, now, now]);
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

  /**
   * Atomically settle a PROPOSED world-fact: flip `review_state` from `proposed` to
   * `reviewState` in a SINGLE compare-and-set. The `review_state = 'proposed'` precondition
   * lives in the UPDATE's WHERE clause, so two concurrent drains over one proposal cannot
   * both win: the first transitions it and the second matches nothing. Advances `updated_at`
   * (the review is a real transition). Because the single-row-per-subject model never lets a
   * `proposed` and an `accepted` row share a subject, settling `proposed → accepted` can
   * never collide with the `UNIQUE(agent_id, subject)` constraint.
   *
   * `expectedValue`, when given, is an ADDITIONAL `value = ?` precondition that pins the
   * settle to the EXACT content the caller reviewed. This matters because a world-fact, unlike
   * an append-only memory/objective proposal, is an UPSERT keyed by subject: a concurrent
   * re-propose (`proposeWorldFact` of the same still-`proposed` subject) rewrites this very row
   * IN PLACE, keeping its id and `proposed` state but changing the value. A plain
   * review_state-only CAS would then ratify a value the operator never saw and the accept path
   * never re-screened. The accept path passes the re-screened value here so the CAS only wins
   * while the content is unchanged; if it churned, the settle matches nothing and the caller
   * re-reviews the new value. (Content-exact rather than a version timestamp, so a churn back
   * to the reviewed value — ABA — correctly still ratifies what was reviewed.) The subject is
   * immutable for a given id — the upsert conflicts on subject, so one id is always one
   * subject — so pinning the value pins the whole rendered line that was screened. Reject
   * omits it (a rejected note frames nothing regardless of its value).
   *
   * Returns the settled row to the winner, or undefined to a caller that lost the race or
   * whose `expectedValue` no longer matches (or named an unknown / already-settled /
   * cross-agent id).
   */
  settleProposed(
    agentId: string,
    id: string,
    reviewState: ReviewState,
    expectedValue?: string,
  ): WorldFact | undefined {
    requireAgentId(agentId);
    validateEnum(reviewState, REVIEW_STATES, "world-fact reviewState");
    const now = new Date().toISOString();
    const clauses = ["id = ?", "agent_id = ?", "review_state = 'proposed'"];
    const params: SqlValue[] = [reviewState, now, id, agentId];
    if (expectedValue !== undefined) {
      clauses.push("value = ?");
      params.push(expectedValue);
    }
    const row = this.driver
      .prepare(
        `UPDATE world_facts SET review_state = ?, updated_at = ?
          WHERE ${clauses.join(" AND ")}
          RETURNING *`,
      )
      .get(params);
    return row ? mapWorldFact(row) : undefined;
  }
}
