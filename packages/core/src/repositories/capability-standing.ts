import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { CapabilityGrant, CapabilityStanding } from "../types.js";
import { CAPABILITY_STANDINGS, validateEnum } from "../types.js";
import { requireAgentId } from "./scope.js";

function mapGrant(row: SqlRow): CapabilityGrant {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    capability: String(row.capability),
    standing: String(row.standing) as CapabilityStanding,
    basis: String(row.basis),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The per-capability standing store — an agent's EARNED autonomy on each
 * destructive capability, scoped by `agentId` like every other repository (the
 * agent is the isolation boundary). One row per (agent, capability); a capability
 * with no row is implicitly `gated`. Standing for agent A can never be read or
 * written through agent B's id — `requireAgentId` guards every method and the
 * `agent_id` is in every filter.
 */
export class CapabilityStandingRepository {
  constructor(private readonly driver: SqlDriver) {}

  /** One capability's standing for an agent, or undefined when it has no row (implicitly gated). */
  get(agentId: string, capability: string): CapabilityGrant | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM capability_standing WHERE agent_id = ? AND capability = ?`)
      .get([agentId, capability]);
    return row ? mapGrant(row) : undefined;
  }

  /** Every recorded standing for an agent, oldest-first. Scoped like every read. */
  list(agentId: string): CapabilityGrant[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM capability_standing WHERE agent_id = ?
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapGrant);
  }

  /**
   * The capability keys this agent currently holds a `standing-grant` on — the set
   * the destructive gate reads as `autoApprove`. Scoped to `agentId` AND filtered to
   * the granted standing at the storage layer, so it can only ever return one
   * agent's own grants and never a `gated` (or revoked) capability.
   */
  grantedKeys(agentId: string): string[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT capability FROM capability_standing
           WHERE agent_id = ? AND standing = 'standing-grant'
           ORDER BY capability ASC`,
      )
      .all([agentId])
      .map((row) => String(row.capability));
  }

  /**
   * Upsert one capability's standing for an agent — the single write path, used by
   * a human ratification (→ `standing-grant`) and by a revocation (→ `gated`). The
   * standing is validated through the same enum chokepoint the rest of the kernel
   * uses, so a bad value can never reach a gate decision. `created_at` is preserved
   * across updates; `updated_at` advances on every change.
   */
  setStanding(
    agentId: string,
    capability: string,
    standing: CapabilityStanding,
    basis: string,
  ): CapabilityGrant {
    requireAgentId(agentId);
    validateEnum(standing, CAPABILITY_STANDINGS, "capability standing");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO capability_standing
           (id, agent_id, capability, standing, basis, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, capability) DO UPDATE SET
           standing = excluded.standing,
           basis = excluded.basis,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([randomUUID(), agentId, capability, standing, basis, now, now]);
    if (!row) throw new Error("capability standing upsert did not persist");
    return mapGrant(row);
  }
}
