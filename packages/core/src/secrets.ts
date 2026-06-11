// The local secret store — where a credential's plaintext actually lives.
//
// The split is the point. The `credentials` table records only a `valueRef`
// (CLAUDE.md: "Credentials live in the local secret store, referenced by
// valueRef — never the plaintext"). This store holds the value behind that ref.
// Nothing outside `read()` returns plaintext: `list()` yields keys and refs but
// never values, so the store cannot accidentally leak a secret into a log line, a
// run transcript, or the event log (which records references, never values).
//
// Scoping is identical to every other table: a `valueRef` is meaningless without
// its owning `agentId` in the filter. `read(bob, aliceRef)` returns undefined —
// cross-agent secret reads fail by construction, not by convention.
//
// Reading a value is a *destructive* action under the trust model ("reading or
// exporting a credential value"). `read()` is the kernel-internal mechanism that
// injects a secret into a tool closure the kernel itself builds; it is never
// handed to the substrate. Any agent-facing capability that would surface a value
// must be registered with `effect: "destructive"` so the gate fires.

import type { SqlDriver, SqlRow } from "./db/driver.js";
import { requireAgentId } from "./repositories/scope.js";

/**
 * Keys under this prefix are RESERVED for the kernel's own internal secrets (e.g.
 * the action-fingerprint key the resume gate depends on). User credential writes
 * ({@link SecretStore.issue}) reject them, so an operator's `secrets add` can never
 * overwrite a kernel key out from under a paused run; only {@link SecretStore.ensure}
 * (the kernel's create-if-absent path) may write here.
 */
export const RESERVED_SECRET_PREFIX = "__asterism.";

/** Whether a secret key belongs to the kernel's reserved namespace. */
export function isReservedSecretKey(key: string): boolean {
  return key.startsWith(RESERVED_SECRET_PREFIX);
}

/** A stored secret's metadata — deliberately without the value. */
export interface SecretRef {
  agentId: string;
  key: string;
  /** Reference recorded on the credential row; resolves to the value via read(). */
  valueRef: string;
  createdAt: string;
}

/**
 * Build the value_ref for an agent's secret key. The ref embeds the owning
 * agentId so it is unique per agent and self-describing in a credential row;
 * reads still assert the caller's agentId independently, so the embedded id is a
 * convenience, never the access check.
 */
export function secretValueRef(agentId: string, key: string): string {
  return `secret://${agentId}/${key}`;
}

function mapRef(row: SqlRow): SecretRef {
  return {
    agentId: String(row.agent_id),
    key: String(row.key),
    valueRef: String(row.value_ref),
    createdAt: String(row.created_at),
  };
}

export class SecretStore {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Store (or rotate) a secret value for an agent's key, returning only its
   * reference — never the value back. Re-issuing an existing key rotates the
   * value in place (idempotent `secrets add`), preserving the original ref and
   * created_at against the UNIQUE(agent_id, key) constraint.
   */
  issue(agentId: string, key: string, value: string): SecretRef {
    requireAgentId(agentId);
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("a secret key is required");
    }
    // The kernel-reserved namespace is off-limits to user credential writes: a
    // `secrets add` must never rotate (and thereby invalidate) a key the kernel
    // depends on, such as the action-fingerprint key a paused run was fingerprinted
    // under. The kernel seeds its own keys via `ensure`, which is exempt.
    if (isReservedSecretKey(key)) {
      throw new Error(`the secret key "${key}" is reserved for internal use`);
    }
    const valueRef = secretValueRef(agentId, key);
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO secrets (value_ref, agent_id, key, value, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET value = excluded.value
         RETURNING value_ref, agent_id, key, created_at`,
      )
      .get([valueRef, agentId, key, value, createdAt]);
    if (!row) throw new Error("secret insert did not persist");
    return mapRef(row);
  }

  /**
   * Get-or-create: store `value` under the agent's `key` ONLY if none exists
   * there yet, and return the effective stored value — the existing one on
   * conflict, the freshly-stored one otherwise. Unlike {@link issue} this never
   * rotates (`ON CONFLICT DO NOTHING`), so two callers racing to seed the same key
   * converge on a single value rather than overwriting each other. The kernel uses
   * it for internal keys it generates lazily (e.g. the action-fingerprint key),
   * never for user credentials — and unlike {@link issue} it is EXEMPT from the
   * reserved-namespace check, since seeding those kernel keys is exactly its job.
   */
  ensure(agentId: string, key: string, value: string): string {
    requireAgentId(agentId);
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("a secret key is required");
    }
    const valueRef = secretValueRef(agentId, key);
    const createdAt = new Date().toISOString();
    this.driver
      .prepare(
        `INSERT INTO secrets (value_ref, agent_id, key, value, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO NOTHING`,
      )
      .run([valueRef, agentId, key, value, createdAt]);
    const stored = this.readByKey(agentId, key);
    if (stored === undefined) throw new Error("secret ensure did not persist");
    return stored;
  }

  /**
   * Resolve a value_ref to its plaintext, scoped to the agent. The ONLY path
   * that returns a value. Cross-agent reads return undefined — a value_ref minted
   * for one agent cannot be redeemed by another. Destructive-classified: callers
   * exposing this through a tool must gate it.
   */
  read(agentId: string, valueRef: string): string | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT value FROM secrets WHERE value_ref = ? AND agent_id = ?`)
      .get([valueRef, agentId]);
    return row ? String(row.value) : undefined;
  }

  /** Resolve by key instead of ref, scoped to the agent. Same destructive caveat. */
  readByKey(agentId: string, key: string): string | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT value FROM secrets WHERE key = ? AND agent_id = ?`)
      .get([key, agentId]);
    return row ? String(row.value) : undefined;
  }

  /** True if the agent has a secret under this key — without reading its value. */
  has(agentId: string, key: string): boolean {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT 1 AS present FROM secrets WHERE key = ? AND agent_id = ?`)
      .get([key, agentId]);
    return row !== undefined;
  }

  /**
   * List the agent's secret references — keys and refs only, NEVER values. The
   * value column is not selected, so this method has no way to leak a secret.
   */
  list(agentId: string): SecretRef[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT value_ref, agent_id, key, created_at FROM secrets
         WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId])
      .map(mapRef);
  }

  /**
   * Remove an agent's secret by key. Returns true if a row was deleted. This is
   * the low-level primitive for *standalone* secrets; a secret backing a
   * credential row must be removed via {@link AsterismStore.removeCredential},
   * which targets the credential's stored `valueRef` so the right plaintext is
   * dropped even when the ref is not the key-derived default.
   */
  delete(agentId: string, key: string): boolean {
    requireAgentId(agentId);
    const before = this.has(agentId, key);
    this.driver
      .prepare(`DELETE FROM secrets WHERE key = ? AND agent_id = ?`)
      .run([key, agentId]);
    return before;
  }

  /**
   * Remove an agent's secret by its `value_ref`, scoped to the agent. This is the
   * precise counterpart to a credential row, whose `valueRef` may be any string
   * (e.g. created via `credentials.create` directly), not necessarily the
   * key-derived default. Returns true if a row was deleted.
   */
  deleteByRef(agentId: string, valueRef: string): boolean {
    requireAgentId(agentId);
    const existed =
      this.driver
        .prepare(
          `SELECT 1 AS present FROM secrets WHERE value_ref = ? AND agent_id = ?`,
        )
        .get([valueRef, agentId]) !== undefined;
    this.driver
      .prepare(`DELETE FROM secrets WHERE value_ref = ? AND agent_id = ?`)
      .run([valueRef, agentId]);
    return existed;
  }
}
