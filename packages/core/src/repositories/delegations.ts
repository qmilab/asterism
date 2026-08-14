import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { BoundEndpoint, Connection, ConnectionMode, Delegation, DelegationStatus } from "../types.js";
import { isDelegableCapabilityKey } from "../capabilities.js";
import { requireAgentId } from "./scope.js";

/**
 * The one connection mode a delegation may sit on. Exported and bound as a SQL PARAMETER
 * rather than written as a literal in each statement, for the reason
 * {@link BRIEF_CONNECTION_MODE} records: a review round found the brief audit trusting a
 * caller-supplied `connection.mode` while the SQL enforced its own.
 */
export const DELEGATION_CONNECTION_MODE: ConnectionMode = "delegated-tool";

function mapDelegation(row: SqlRow): Delegation {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    fromAgentId: String(row.from_agent_id),
    toAgentId: String(row.to_agent_id),
    capability: String(row.capability),
    url: String(row.url),
    credentialKey: String(row.credential_key),
    status: String(row.status) as DelegationStatus,
    createdAt: String(row.created_at),
    ...(row.ended_at != null ? { endedAt: String(row.ended_at) } : {}),
  };
}

/**
 * The delegations store — which of the callee's capabilities a `delegated-tool` channel
 * actually reaches (Phase 3 · T3b; design note §21).
 *
 * Scoping follows {@link BriefRepository} exactly, and for the same reason: a delegation
 * links TWO agents, so writes assert both ids and reads assert a participant through the
 * CONNECTION rather than through the row's own columns. A row's self-declared participants
 * are a claim; the authorizing row's are the fact — the correction that cost the brief
 * repository two review rounds, applied here from the first line.
 *
 * Every grant test lives INSIDE the statement it authorizes, as a `WHERE EXISTS` over
 * `connections`, so there is no instant between deciding and writing. `disconnect` in
 * another shell is exactly the concurrent writer this phase invented, and an argument that
 * depends on nobody mis-remembering SQLite's isolation rules is the weaker kind.
 *
 * The status lifecycle is `active → ended`, one way. Nothing here writes `active` onto an
 * existing row, so a withdrawn grant can never quietly resume granting.
 */
export class DelegationRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Grant one capability on a `delegated-tool` channel, snapshotting the binding it was
   * granted against.
   *
   * Takes the {@link BoundEndpoint} rather than a capability key so the snapshot cannot be
   * assembled by a caller: the key, the URL and the credential key all come off one row the
   * kernel just read from the CALLEE's own scoped repository. That is what makes "this grant
   * names a binding the callee currently holds" a property of the write rather than of the
   * caller's diligence — and a grant for an unbound name would otherwise sit dormant until
   * the callee bound it, which is precisely the widening this lock exists to prevent.
   *
   * BOTH halves of the grant test live inside the INSERT: the channel, and **the binding
   * itself**. The endpoint half was outside it at first — the caller read a `BoundEndpoint`
   * and this statement checked only the connection — and the gap that leaves is not a
   * hypothetical. `api remove` in another shell, landing between the read and this write,
   * ended nothing (there was no grant yet) and then this wrote a grant snapshotting a
   * binding that no longer existed. Calls refuse it as `changed`, so nothing leaks — but a
   * later `api add` of the SAME name, URL and credential is a first bind, ends nothing, and
   * makes that grant live again with no `delegate` in between. A removal is supposed to be
   * the end of a grant, not a pause in it. [Codex review R2 P2.]
   *
   * The predicate compares the tuple the call itself compares — agent, name, URL, credential
   * key — rather than the row id, because `api add` rebinds IN PLACE and preserves the id, so
   * the id is exactly the field that cannot tell a rebind from the original.
   *
   * Returns `undefined` when the grant does not hold at the moment of the write — no such
   * live channel, wrong mode, wrong direction, a `Connection` whose participants do not match
   * the row it names, or a binding that has since been removed or re-pointed. Deliberately
   * not a throw: another operator revoking a channel or re-pointing an endpoint between a
   * surface's read and this write is an ordinary event this flow models, not an invariant
   * violation. The caller distinguishes the two causes so the surface never names one it did
   * not verify.
   *
   * The partial unique index `(connection_id, capability) WHERE status = 'active'` is the
   * storage-layer backstop against a concurrent double-grant; the caller ends any existing
   * active grant in the same transaction when re-granting.
   */
  create(connection: Connection, endpoint: BoundEndpoint, capability: string): Delegation | undefined {
    requireAgentId(connection.fromAgentId);
    requireAgentId(connection.toAgentId);
    // The delegable set is a NAMED classification, enforced where it is written rather than
    // where it is read. Nothing that reaches here through a surface can fail this — the key
    // is derived from a binding — which is exactly why it is asserted: a rule kept only by
    // the callers that happen to respect it is not a rule, and this is the chokepoint every
    // other write boundary in this kernel uses (`validateEnum`, `validateCapabilityKeys`).
    // A throw, not `undefined`: a withdrawn channel is an ordinary outcome, an undelegable
    // capability is a programming error.
    if (!isDelegableCapabilityKey(capability)) {
      throw new Error(
        `capability ${JSON.stringify(capability)} is not delegable — only a bound endpoint is, because it is the one capability that takes no arguments from the agent asking for it`,
      );
    }
    // The binding must belong to the CALLEE. Asserted here rather than trusted from the
    // caller because this is the one place the two facts meet: `endpoint` was read from some
    // agent's scoped repository, and only the connection knows which agent is supposed to own
    // it. A binding of the caller's own would otherwise be delegable to itself through a
    // channel, granting a capability the callee never held.
    if (endpoint.agentId !== connection.toAgentId) return undefined;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO delegations
           (id, connection_id, from_agent_id, to_agent_id, capability, url, credential_key,
            status, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?
          WHERE EXISTS (
            SELECT 1 FROM connections
             WHERE id = ?
               AND status = 'active'
               AND mode = ?
               AND from_agent_id = ?
               AND to_agent_id = ?
          )
            AND EXISTS (
              SELECT 1 FROM agent_endpoints
               WHERE agent_id = ?
                 AND name = ?
                 AND url = ?
                 AND credential_key = ?
            )
         RETURNING *`,
      )
      .get([
        id,
        connection.id,
        connection.fromAgentId,
        connection.toAgentId,
        capability,
        endpoint.url,
        endpoint.credentialKey,
        createdAt,
        connection.id,
        DELEGATION_CONNECTION_MODE,
        connection.fromAgentId,
        connection.toAgentId,
        connection.toAgentId,
        endpoint.name,
        endpoint.url,
        endpoint.credentialKey,
      ]);
    return row ? mapDelegation(row) : undefined;
  }

  /**
   * Does the callee still hold the exact binding `endpoint` describes?
   *
   * The same predicate {@link create}'s INSERT carries, as a standalone read — used ONLY to
   * tell a caller WHICH half of the grant test declined, never as the authorization. The
   * INSERT keeps its own copy, so nothing here can be raced into a write that should not
   * have happened; if this returns true and the binding is re-pointed a microsecond later,
   * the insert still declines.
   *
   * It exists so a surface never reports a cause it did not check. Without it, a `delegate`
   * that lost a race to `api remove` was reported as "no active delegated-tool connection" —
   * a specific, confident, wrong diagnosis, and the sentence pattern this project has had to
   * walk back more than any other.
   */
  bindingHolds(agentId: string, endpoint: BoundEndpoint): boolean {
    requireAgentId(agentId);
    return (
      this.driver
        .prepare(
          `SELECT 1 FROM agent_endpoints
             WHERE agent_id = ? AND name = ? AND url = ? AND credential_key = ?`,
        )
        .get([agentId, endpoint.name, endpoint.url, endpoint.credentialKey]) !== undefined
    );
  }

  /**
   * End the ACTIVE grant for one capability on a channel, returning the row as it now
   * stands, or undefined when there was none.
   *
   * One atomic compare-and-set — `WHERE status = 'active'` is the comparison, `SET status =
   * 'ended'` the set — so two concurrent withdrawals cannot both report success and both
   * emit, and re-withdrawing is a clean no-op.
   *
   * Carries {@link create}'s grant test in full, participant comparison included. The brief
   * repository's rationale for omitting it ("there is nothing to attribute") was wrong there
   * and would be wrong here for the same two reasons: the audit is emitted to the pair these
   * ids name, and a forged `Connection` must not be able to end a grant on a channel it does
   * not join.
   */
  endActive(connection: Connection, capability: string): Delegation | undefined {
    requireAgentId(connection.fromAgentId);
    requireAgentId(connection.toAgentId);
    const endedAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE delegations SET status = 'ended', ended_at = ?
           WHERE connection_id = ?
             AND capability = ?
             AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM connections
                WHERE id = ?
                  AND status = 'active'
                  AND mode = ?
                  AND from_agent_id = ?
                  AND to_agent_id = ?
             )
         RETURNING *`,
      )
      .get([
        endedAt,
        connection.id,
        capability,
        connection.id,
        DELEGATION_CONNECTION_MODE,
        connection.fromAgentId,
        connection.toAgentId,
      ]);
    return row ? mapDelegation(row) : undefined;
  }

  /**
   * End every ACTIVE grant of `capability` that names `agentId` as the CALLEE — the write
   * behind "a binding that changes ends its delegations" (D42).
   *
   * Deliberately NOT conditioned on the connection's status or mode, unlike every other
   * write here. This is not an authorization: it is a withdrawal, reached only from the
   * callee's own `api remove` / rebind, and a withdrawal that skipped rows on a channel
   * someone had already revoked would leave grants that reactivate if the pair reconnects.
   * Ending more than strictly grants anything is the safe direction.
   *
   * Scoped to `to_agent_id` because only the CALLEE's binding backs a grant; a caller
   * rebinding an endpoint of its own with the same name touches nothing here.
   *
   * Returns the rows it ended so the caller can audit each one on both logs — the
   * withdrawal must appear on the record of the pair it affected, not only of the agent
   * whose command caused it.
   */
  endAllForCapability(agentId: string, capability: string): Delegation[] {
    requireAgentId(agentId);
    const endedAt = new Date().toISOString();
    return this.driver
      .prepare(
        `UPDATE delegations SET status = 'ended', ended_at = ?
           WHERE to_agent_id = ? AND capability = ? AND status = 'active'
         RETURNING *`,
      )
      .all([endedAt, agentId, capability])
      .map(mapDelegation);
  }

  /**
   * The LIVE grant for one capability on a channel, or undefined — the permission read the
   * call itself makes, and the one that must be right.
   *
   * Three predicates, each load-bearing:
   *
   *   1. `d.status = 'active'` — a withdrawn grant grants nothing.
   *   2. **`c.status = 'active' AND c.mode = 'delegated-tool'`** — the channel is re-read
   *      HERE, live, joined rather than trusted from whenever the grant was made. This is
   *      what makes `disconnect` withdraw every delegation on a channel without touching a
   *      delegation row, the same connection-keyed property `exchanges` and briefs have.
   *   3. **The grant's participants must MATCH its connection's.** Not redundant with the
   *      caller's own lookup: a row naming a third agent while sitting on a real A→B channel
   *      is refused here even though `create` derives the ids from the connection and cannot
   *      produce one. A permission read must not trust the row it is authorizing to describe
   *      its own scope.
   */
  findActive(connection: Connection, capability: string): Delegation | undefined {
    requireAgentId(connection.fromAgentId);
    requireAgentId(connection.toAgentId);
    const row = this.driver
      .prepare(
        `SELECT d.* FROM delegations d
           JOIN connections c ON c.id = d.connection_id
           WHERE d.connection_id = ?
             AND d.capability = ?
             AND d.status = 'active'
             AND c.status = 'active'
             AND c.mode = ?
             AND d.from_agent_id = c.from_agent_id
             AND d.to_agent_id = c.to_agent_id
             AND c.from_agent_id = ?
             AND c.to_agent_id = ?
         `,
      )
      .get([
        connection.id,
        capability,
        DELEGATION_CONNECTION_MODE,
        connection.fromAgentId,
        connection.toAgentId,
      ]);
    return row ? mapDelegation(row) : undefined;
  }

  /**
   * Every capability a channel currently reaches, for a caller that PARTICIPATES in it.
   *
   * The view read behind `asterism connections`, and the same resolver the call itself uses
   * — {@link findActive}'s predicates verbatim, minus the capability. That is deliberate and
   * is this slice's answer to the most repeated defect of the #123 slices (*the surface
   * states a completeness it has not checked*): the list an operator reads and the set a
   * call is authorized against are one query, so there is no second place to keep true.
   */
  listActiveForConnection(agentId: string, connectionId: string): Delegation[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT d.* FROM delegations d
           JOIN connections c ON c.id = d.connection_id
           WHERE d.connection_id = ?
             AND d.status = 'active'
             AND c.status = 'active'
             AND c.mode = ?
             AND d.from_agent_id = c.from_agent_id
             AND d.to_agent_id = c.to_agent_id
             AND (c.from_agent_id = ? OR c.to_agent_id = ?)
           ORDER BY d.capability ASC, d.rowid ASC`,
      )
      .all([connectionId, DELEGATION_CONNECTION_MODE, agentId, agentId])
      .map(mapDelegation);
  }
}
