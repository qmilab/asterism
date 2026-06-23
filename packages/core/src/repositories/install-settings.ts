import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { InstallSettings } from "../types.js";
import { validatePositiveInt } from "../types.js";

/** A NULLable integer column → a number, or undefined when NULL/absent. */
function intOrUnset(value: unknown): number | undefined {
  return value !== null && value !== undefined ? Number(value) : undefined;
}

/** Map the single install-settings row to the public {@link InstallSettings}. */
function mapSettings(row: SqlRow): InstallSettings {
  const recallBudget = intOrUnset(row.recall_budget);
  return {
    ...(recallBudget !== undefined ? { recallBudget } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The install-wide settings store — a SINGLE-row sibling of {@link AgentSettingsRepository}
 * for defaults that apply across every agent. The row is pinned to `singleton = 1` (the
 * table's CHECK constraint enforces it), so there is exactly one. A field with no value is
 * an UNSET override that the resolver fills with the kernel's built-in constant; a per-agent
 * setting still wins over the install-wide default here.
 *
 * Unlike every other repository, this one is NOT scoped by `agentId` — it holds no agent
 * data, only install-wide configuration. It is the deliberate, narrow exception to "the
 * agent is the isolation boundary": there is no cross-agent leak surface because there is no
 * agent data here to leak. The kernel owning this resolution (rather than a surface) is what
 * lets every run path read the same default without each one threading it through.
 */
export class InstallSettingsRepository {
  constructor(private readonly driver: SqlDriver) {}

  /** The install settings row, or undefined when nothing has been set (every default unset). */
  get(): InstallSettings | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM install_settings WHERE singleton = 1`)
      .get([]);
    return row ? mapSettings(row) : undefined;
  }

  /**
   * The install-wide default recall budget, or undefined when unset (no row, or the column
   * is NULL) — the resolver reads this BELOW a per-agent override and ABOVE the kernel
   * constant.
   */
  getRecallBudget(): number | undefined {
    return this.get()?.recallBudget;
  }

  /**
   * Set the install-wide default recall budget. Validates a positive whole number at the
   * write boundary (the kernel never trusts a surface to have checked), then upserts the
   * single row. `created_at` is preserved across updates; `updated_at` advances.
   */
  setRecallBudget(budget: number): InstallSettings {
    validatePositiveInt(budget, "install recall budget");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO install_settings (singleton, recall_budget, created_at, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           recall_budget = excluded.recall_budget,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([budget, now, now]);
    if (!row) throw new Error("install settings upsert did not persist");
    return mapSettings(row);
  }

  /**
   * Clear the install-wide default recall budget (back to the kernel constant) by setting
   * only that column to NULL. Returns the updated row, or undefined when no row existed
   * (nothing was set, so nothing to clear) — the caller uses that to decide what to report.
   * The row itself is kept even when every default is now NULL, so a later setting preserves
   * `created_at`.
   */
  clearRecallBudget(): InstallSettings | undefined {
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE install_settings SET recall_budget = NULL, updated_at = ?
           WHERE singleton = 1 RETURNING *`,
      )
      .get([now]);
    return row ? mapSettings(row) : undefined;
  }
}
