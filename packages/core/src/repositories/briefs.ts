import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { Brief, BriefStatus, Connection } from "../types.js";
import { assertMemorySafe } from "../firewall.js";
import { requireAgentId } from "./scope.js";

function mapBrief(row: SqlRow): Brief {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    fromAgentId: String(row.from_agent_id),
    toAgentId: String(row.to_agent_id),
    content: String(row.content),
    status: String(row.status) as BriefStatus,
    createdAt: String(row.created_at),
    ...(row.ended_at != null ? { endedAt: String(row.ended_at) } : {}),
  };
}

/**
 * The briefs store — standing operator-authored context on a `shared-brief` connection
 * (Phase 3 · T3a; design note §17).
 *
 * Scoping follows {@link ConnectionRepository} rather than the single-`agent_id` shape:
 * a brief links TWO agents, so writes assert both ids and reads assert a participant
 * (`from_agent_id = ? OR to_agent_id = ?`). A brief between A and B is reachable through
 * A's id or B's id and never through a third agent C's — the agent is still the isolation
 * boundary.
 *
 * The firewall screen lives on {@link create}, deliberately at the write boundary rather
 * than in the store: a brief's content enters ANOTHER agent's system prompt, so it is
 * screened exactly like memory and objectives, and no caller — including a future one — can
 * reach a code path that persists unscreened text. This is `ObjectiveRepository`'s rule
 * ("because an objective's content frames runs it is firewall-screened on the write path
 * exactly like memory") applied to text that frames someone ELSE's runs.
 *
 * The status lifecycle is `active → ended`, one way. {@link create} is the only writer of
 * `active`; {@link endActiveForConnection} is the only writer of `ended`, and nothing here
 * can move a row back (D28). Reads split on it the way connections' do:
 * {@link listActiveForAgent} resolves what FRAMES a run — and joins `connections` so a
 * revoked channel yields nothing — while {@link listForAgent} reports HISTORY and returns
 * every status.
 */
export class BriefRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Create a new `active` brief on a connection.
   *
   * The content is screened FIRST, before an id is minted or a row is written: a brief is
   * free text authored on one side of an isolation boundary that will frame runs on the
   * other, which is precisely the memory firewall's remit (an inbound write, screened for
   * injection/exfiltration before persistence). `redactForTrace` is the wrong tool here and
   * the distinction is the one design note D18 drew — it scrubs secret VALUES out of text
   * crossing outward, whereas neutralising a span of an injection-shaped brief would leave
   * the rest of a sentence written to steer a reader. Inbound, *block* is the right verb.
   *
   * Takes the CONNECTION and DERIVES both participants from it, rather than accepting three
   * loose ids. Probed before it was written this way, and the loose form was reachable: a row
   * naming a third agent as `to_agent_id` while sitting on a real A→B channel framed that
   * third agent, who was on no channel at all. Deriving means a brief cannot be attributed to
   * a pair the channel does not join — the same correction `startExchangeRun` made for the
   * run stamp, and for the same reason (an id a caller supplies is a claim; an id read off
   * the authorizing row is a fact). {@link listActiveForAgent} enforces the same thing again
   * at the point of USE, so the two halves hold independently.
   *
   * The caller (the store) is responsible for ending any existing active brief in the same
   * transaction; the partial unique index `(connection_id) WHERE status = 'active'` is the
   * storage-layer backstop that makes a concurrent double-create fail rather than silently
   * give one channel two briefs.
   */
  create(connection: Connection, content: string): Brief {
    requireAgentId(connection.fromAgentId);
    requireAgentId(connection.toAgentId);
    assertMemorySafe(content);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO briefs
           (id, connection_id, from_agent_id, to_agent_id, content, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)
         RETURNING *`,
      )
      .get([
        id,
        connection.id,
        connection.fromAgentId,
        connection.toAgentId,
        content,
        createdAt,
      ]);
    if (!row) throw new Error("brief insert did not persist");
    return mapBrief(row);
  }

  /**
   * End the ACTIVE brief on `connectionId`, returning the row as it now stands, or
   * undefined when there was none.
   *
   * One atomic compare-and-set, `ConnectionRepository.revoke`'s shape: `WHERE status =
   * 'active'` is the comparison and `SET status = 'ended'` the set, so two concurrent ends
   * cannot both report success or both emit, and re-ending is a clean no-op. Terminal by
   * omission — nothing in this repository writes `active` onto an existing row, so a brief
   * can never quietly resume framing another agent's prompt (D28).
   *
   * Keyed on the connection rather than a brief id because that is how both callers reach
   * it: `unbrief` names a channel, and a supersede ends "whatever is active here" before
   * inserting. The connection id is itself only obtainable from a scoped read, so this
   * inherits that scoping.
   */
  endActiveForConnection(connectionId: string): Brief | undefined {
    const endedAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE briefs SET status = 'ended', ended_at = ?
           WHERE connection_id = ? AND status = 'active'
         RETURNING *`,
      )
      .get([endedAt, connectionId]);
    return row ? mapBrief(row) : undefined;
  }

  /** The ACTIVE brief on `connectionId`, or undefined. Reports state, not permission. */
  findActiveForConnection(connectionId: string): Brief | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM briefs WHERE connection_id = ? AND status = 'active'`)
      .get([connectionId]);
    return row ? mapBrief(row) : undefined;
  }

  /**
   * Every brief that currently FRAMES `agentId`'s runs — the framing read, and the only one
   * whose result reaches a system prompt.
   *
   * Three predicates, all load-bearing:
   *
   *   1. `b.status = 'active'` — an ended or superseded brief frames nothing.
   *   2. **`c.status = 'active' AND c.mode = 'shared-brief'`** — the grant is re-read HERE,
   *      live, at framing time, rather than trusted from when the brief was written. A
   *      brief written today frames a run started next week, which is the longest
   *      "checked here, used there" window in the phase, and four of revoke's eight review
   *      rounds were windows of exactly that shape. Because the join carries it, revoking
   *      the channel un-frames the brief on the next run of either agent without touching
   *      the brief row at all (D28) — the same connection-keyed property `exchanges` has.
   *   3. `b.from_agent_id = ? OR b.to_agent_id = ?` — the participant scope. A brief between
   *      two other agents can never frame this one.
   *   4. **The brief's participants must MATCH its connection's.** Not redundant with (3):
   *      without it, a row naming a third agent while sitting on a real A→B channel framed
   *      that third agent, who was on no channel at all — verified reachable before this
   *      predicate was added. `create` now derives the ids from the connection so the
   *      ordinary path cannot produce such a row, and this refuses one anyway. A permission
   *      read must not trust the row it is authorizing to describe its own scope.
   *
   * Ordering is `created_at` then `rowid`, the same stable total order every other list
   * uses, so the same brief set always produces a byte-identical prompt.
   */
  listActiveForAgent(agentId: string): Brief[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT b.* FROM briefs b
           JOIN connections c ON c.id = b.connection_id
           WHERE b.status = 'active'
             AND c.status = 'active'
             AND c.mode = 'shared-brief'
             AND b.from_agent_id = c.from_agent_id
             AND b.to_agent_id = c.to_agent_id
             AND (b.from_agent_id = ? OR b.to_agent_id = ?)
           ORDER BY b.created_at ASC, b.rowid ASC`,
      )
      .all([agentId, agentId])
      .map(mapBrief);
  }

  /**
   * Every brief `agentId` participates in, in any status and on any connection — outbound
   * (it is `from`) AND inbound (it is `to`), oldest-first.
   *
   * The HISTORY read behind `asterism briefs`, deliberately unfiltered by connection status:
   * an operator must be able to see that a brief was superseded or that its channel was
   * withdrawn, exactly as `connections` keeps revoked rows listed (D22). Scoped by
   * participant, so a third agent's briefs can never appear.
   */
  listForAgent(agentId: string): Brief[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM briefs
           WHERE from_agent_id = ? OR to_agent_id = ?
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId, agentId])
      .map(mapBrief);
  }
}
