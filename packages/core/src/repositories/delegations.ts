import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { BoundEndpoint, Connection, ConnectionMode, Delegation, DelegationStatus } from "../types.js";
import { isDelegableCapabilityKey } from "../capabilities.js";
import { endpointCapabilityKey } from "../endpoints.js";
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
   * Takes the {@link BoundEndpoint} and NOTHING ELSE about the grant: the capability key, the
   * URL and the credential key are all DERIVED from that one row, which the kernel just read
   * from the CALLEE's own scoped repository. That is what makes "this grant names a binding
   * the callee currently holds" a property of the write rather than of the caller's
   * diligence — and a grant for an unbound name would otherwise sit dormant until the callee
   * bound it, which is precisely the widening this lock exists to prevent.
   *
   * The key was a THIRD PARAMETER when this was first written, and that sentence above was
   * false of it. A caller could pass the `issues` row with capability `api.payroll`, and the
   * binding predicate — which checks the row, not the key — would accept it: a dormant grant
   * naming one endpoint, snapshotted from another, that comes alive the moment `payroll` is
   * bound to a matching URL and credential. Deriving the key makes that state unrepresentable
   * rather than refused, which is the stronger of the two fixes and the one the doc comment
   * was already claiming. [Codex review R3 P2.]
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
  create(connection: Connection, endpoint: BoundEndpoint): Delegation | undefined {
    requireAgentId(connection.fromAgentId);
    requireAgentId(connection.toAgentId);
    // Derived, never accepted. One source of truth for what this grant names.
    const capability = endpointCapabilityKey(endpoint.name);
    // The delegable set is a NAMED classification, and this is the backstop for it.
    //
    // HONEST ABOUT ITS REACH: now that the key is derived, no in-process caller can fail
    // this — `endpointCapabilityKey` only ever produces the credential-bearing namespace, so
    // the branch is unreachable and deleting it breaks no test. That was measured, not
    // assumed. It is kept for one reason worth stating rather than leaving a reader to
    // wonder: it is the assertion that fires if `endpointCapabilityKey` is ever changed to
    // mint a key outside that namespace, which would silently widen what a channel may carry
    // — and a classification with no assertion anywhere is the thing this kernel refuses
    // ("never a vibe"). A throw, not `undefined`: a withdrawn channel is an ordinary
    // outcome, an undelegable capability is a programming error.
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
   * Carries {@link findActive}'s predicate — the same question, so this ends exactly the
   * grants that were granting something and nothing else.
   *
   * It was unconditional at first, justified by "a withdrawal that skipped rows on a channel
   * someone had already revoked would leave grants that reactivate if the pair reconnects."
   * That is false, and the schema is what makes it false: a delegation is keyed on
   * `connection_id`, and a reconnect mints a FRESH connection row (D20), so a row left behind
   * on a revoked channel can never match a later channel's id. Such rows are permanently
   * inert — the brief precedent exactly, where a revoked channel's brief also stays `active`
   * and frames nothing.
   *
   * So the unconditional form ended nothing that was granting, and did two things that were
   * wrong: it emitted `delegation.ended` on both logs for a permission `disconnect` had
   * already withdrawn, and it made `api remove` tell the operator that another agent "can no
   * longer ask" for something that agent had already lost. An audit entry for a transition
   * that did not happen is worse than a missing one. [Codex review R5 P2.]
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
             AND EXISTS (
               SELECT 1 FROM connections c
                WHERE c.id = delegations.connection_id
                  AND c.status = 'active'
                  AND c.mode = ?
                  AND delegations.from_agent_id = c.from_agent_id
                  AND delegations.to_agent_id = c.to_agent_id
             )
         RETURNING *`,
      )
      .all([endedAt, agentId, capability, DELEGATION_CONNECTION_MODE])
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
   *   3. **The grant's participants must MATCH its connection's.** A permission read must not
   *      trust the row it is authorizing to describe its own scope.
   *
   *      HONEST ABOUT ITS REACH: no in-process path can produce a row that fails this.
   *      {@link create} derives both ids from the connection, and its INSERT only fires when
   *      those ids match a live `connections` row — so a stored delegation's participants are
   *      always a real channel's. Deleting this predicate breaks no test, and that was
   *      measured rather than assumed.
   *
   *      It stays because this class is EXPORTED from `@qmilab/asterism-core`, and a host
   *      that constructs one over its own `SqlDriver` can insert whatever it likes. That is
   *      a real caller, not a hypothetical one, and it is the caller for whom "the row says
   *      it belongs to these two agents" is a claim rather than a fact. The brief repository
   *      carries the identical predicate for a reason that WAS reachable in-process, which is
   *      how the shape got here.
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
