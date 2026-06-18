import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { AgentSettings } from "../types.js";
import { validatePositiveInt } from "../types.js";
import { requireAgentId } from "./scope.js";

/**
 * Map a raw row to the public {@link AgentSettings}. A NULL `recall_budget` is an
 * UNSET override — dropped here rather than coerced to 0 — so the resolver falls
 * back to the kernel default. `exactOptionalPropertyTypes` is on, so an unset
 * field is omitted, never set to `undefined`.
 */
function mapSettings(row: SqlRow): AgentSettings {
  const recallBudget = row.recall_budget;
  return {
    agentId: String(row.agent_id),
    ...(recallBudget !== null && recallBudget !== undefined
      ? { recallBudget: Number(recallBudget) }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The per-agent settings store — the operator-configurable knobs that tune how an
 * agent thinks, scoped by `agentId` like every other repository (the agent is the
 * isolation boundary). One row per agent; a field with no value is an UNSET
 * override the resolver fills with the kernel default. Settings for agent A can
 * never be read or written through agent B's id — `requireAgentId` guards every
 * method and `agent_id` is the primary key in every filter.
 *
 * This is the shared home for per-agent tunables: `recallBudget` is the first, and
 * a future knob adds its own typed column + setter here (each setter touches only
 * its own column, so they never clobber one another), never a column on the
 * `agents` identity table.
 */
export class AgentSettingsRepository {
  constructor(private readonly driver: SqlDriver) {}

  /** An agent's settings row, or undefined when it has none (every override unset). */
  get(agentId: string): AgentSettings | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM agent_settings WHERE agent_id = ?`)
      .get([agentId]);
    return row ? mapSettings(row) : undefined;
  }

  /**
   * An agent's recall-budget override, or undefined when unset (no row, or the
   * column is NULL) — the resolver reads this and falls back to the kernel default.
   * Scoped to `agentId`, so it can only ever return one agent's own setting.
   */
  getRecallBudget(agentId: string): number | undefined {
    return this.get(agentId)?.recallBudget;
  }

  /**
   * Set an agent's recall-budget override. Validates a positive whole number at the
   * write boundary (the kernel never trusts a surface to have checked), then upserts
   * ONLY the `recall_budget` column — a future setting's column is left untouched, so
   * setting one knob never clears another. `created_at` is preserved across updates;
   * `updated_at` advances on every change.
   */
  setRecallBudget(agentId: string, budget: number): AgentSettings {
    requireAgentId(agentId);
    validatePositiveInt(budget, "recall budget");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO agent_settings (agent_id, recall_budget, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           recall_budget = excluded.recall_budget,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([agentId, budget, now, now]);
    if (!row) throw new Error("agent settings upsert did not persist");
    return mapSettings(row);
  }

  /**
   * Clear an agent's recall-budget override (back to the kernel default) by setting
   * only that column to NULL. Returns the updated row, or undefined when the agent
   * had no settings row to begin with (nothing was set, so nothing to clear) — the
   * caller (`store.clearRecallBudget`) uses that to decide whether to audit. The row
   * itself is kept even when every override is now NULL, so a later setting on the
   * same agent preserves `created_at`.
   */
  clearRecallBudget(agentId: string): AgentSettings | undefined {
    requireAgentId(agentId);
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE agent_settings SET recall_budget = NULL, updated_at = ?
           WHERE agent_id = ? RETURNING *`,
      )
      .get([now, agentId]);
    return row ? mapSettings(row) : undefined;
  }
}
