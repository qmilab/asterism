import type { SqlDriver, SqlRow } from "../db/driver.js";
import type {
  AgentSettings,
  CognitionProviderId,
  RecallProviderId,
  StandingThresholds,
} from "../types.js";
import {
  COGNITION_PROVIDER_IDS,
  RECALL_PROVIDER_IDS,
  validateEnum,
  validatePositiveInt,
} from "../types.js";
import { requireAgentId } from "./scope.js";

/** A NULLable integer column → a number, or undefined when NULL/absent. */
function intOrUnset(value: unknown): number | undefined {
  return value !== null && value !== undefined ? Number(value) : undefined;
}

/**
 * Map a raw row to the public {@link AgentSettings}. A NULL column is an UNSET
 * override — dropped here rather than coerced to 0 — so the resolver falls back to
 * the kernel default. `exactOptionalPropertyTypes` is on, so an unset field is
 * omitted, never set to `undefined`.
 */
function mapSettings(row: SqlRow): AgentSettings {
  const recallBudget = intOrUnset(row.recall_budget);
  const minCleanExecutions = intOrUnset(row.min_clean_executions);
  const minDistinctTargets = intOrUnset(row.min_distinct_targets);
  const recallProvider = textOrUnset(row.recall_provider);
  const cognitionProvider = textOrUnset(row.cognition_provider);
  return {
    agentId: String(row.agent_id),
    ...(recallBudget !== undefined ? { recallBudget } : {}),
    ...(minCleanExecutions !== undefined ? { minCleanExecutions } : {}),
    ...(minDistinctTargets !== undefined ? { minDistinctTargets } : {}),
    // Validate on read too: a value reaches here only through the validated setter, so
    // any unknown string is a corrupt row, not a new provider — coerce it to unset
    // (the safe default) rather than surface an unrecognized selection to the host.
    ...(recallProvider !== undefined && isRecallProviderId(recallProvider)
      ? { recallProvider }
      : {}),
    ...(cognitionProvider !== undefined && isCognitionProviderId(cognitionProvider)
      ? { cognitionProvider }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** A NULLable text column → a non-empty string, or undefined when NULL/absent/blank. */
function textOrUnset(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  return s.length > 0 ? s : undefined;
}

/** Whether `value` is a recognized opt-in recall provider id. */
function isRecallProviderId(value: string): value is RecallProviderId {
  return (RECALL_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Whether `value` is a recognized opt-in cognition provider id. */
function isCognitionProviderId(value: string): value is CognitionProviderId {
  return (COGNITION_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * The standing-threshold columns, mapped from the public field name to its SQL
 * column. The ONLY source of column names for the dynamic upsert below — every name
 * is a literal here, never user input, so interpolating it into SQL is safe.
 */
const THRESHOLD_COLUMN: Record<keyof StandingThresholds, string> = {
  minCleanExecutions: "min_clean_executions",
  minDistinctTargets: "min_distinct_targets",
};
const THRESHOLD_FIELDS = Object.keys(THRESHOLD_COLUMN) as (keyof StandingThresholds)[];

/** Human labels for the threshold validation errors, by field. */
const STANDING_LABEL: Record<keyof StandingThresholds, string> = {
  minCleanExecutions: "minimum clean executions",
  minDistinctTargets: "minimum distinct targets",
};

/**
 * The per-agent settings store — the operator-configurable knobs that tune how an
 * agent thinks, scoped by `agentId` like every other repository (the agent is the
 * isolation boundary). One row per agent; a field with no value is an UNSET
 * override the resolver fills with the kernel default. Settings for agent A can
 * never be read or written through agent B's id — `requireAgentId` guards every
 * method and `agent_id` is the primary key in every filter.
 *
 * This is the shared home for per-agent tunables: `recallBudget` was the first, the
 * earned-standing thresholds are the second, and a future knob adds its own typed
 * column + setter here (each setter touches only its own column(s), so they never
 * clobber one another), never a column on the `agents` identity table.
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

  /**
   * An agent's opt-in recall-provider selection, or undefined when unset (no row, or
   * the column is NULL) — the host reads this and, when set, wires the matching opt-in
   * provider into the run; unset ⇒ the built-in lexical ranker. Scoped to `agentId`,
   * so it can only ever return one agent's own selection.
   */
  getRecallProvider(agentId: string): RecallProviderId | undefined {
    return this.get(agentId)?.recallProvider;
  }

  /**
   * Set an agent's opt-in recall provider. Validates the id against the known set at
   * the write boundary (the kernel never trusts a surface to have checked), then
   * upserts ONLY the `recall_provider` column — every other setting is left untouched.
   * `created_at` is preserved across updates; `updated_at` advances on every change.
   */
  setRecallProvider(agentId: string, provider: RecallProviderId): AgentSettings {
    requireAgentId(agentId);
    const value = validateEnum(provider, RECALL_PROVIDER_IDS, "recall provider");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO agent_settings (agent_id, recall_provider, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           recall_provider = excluded.recall_provider,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([agentId, value, now, now]);
    if (!row) throw new Error("agent settings upsert did not persist");
    return mapSettings(row);
  }

  /**
   * Clear an agent's recall-provider override (back to the built-in lexical ranker) by
   * setting only that column to NULL. Returns the updated row, or undefined when the
   * agent had no settings row at all (nothing to clear) — symmetric with
   * {@link clearRecallBudget}. The row itself is kept even when every override is now
   * NULL, so a later setting preserves `created_at`.
   */
  clearRecallProvider(agentId: string): AgentSettings | undefined {
    requireAgentId(agentId);
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE agent_settings SET recall_provider = NULL, updated_at = ?
           WHERE agent_id = ? RETURNING *`,
      )
      .get([now, agentId]);
    return row ? mapSettings(row) : undefined;
  }

  /**
   * An agent's opt-in cognition-provider selection, or undefined when unset (no row, or
   * the column is NULL) — the host reads this and, when set, wraps the run adapter in the
   * matching opt-in provider; unset ⇒ the default Pi loop with no trace. Scoped to
   * `agentId`, so it can only ever return one agent's own selection.
   */
  getCognitionProvider(agentId: string): CognitionProviderId | undefined {
    return this.get(agentId)?.cognitionProvider;
  }

  /**
   * Set an agent's opt-in cognition provider. Validates the id against the known set at
   * the write boundary (the kernel never trusts a surface to have checked), then upserts
   * ONLY the `cognition_provider` column — every other setting is left untouched.
   * `created_at` is preserved across updates; `updated_at` advances on every change.
   */
  setCognitionProvider(agentId: string, provider: CognitionProviderId): AgentSettings {
    requireAgentId(agentId);
    const value = validateEnum(provider, COGNITION_PROVIDER_IDS, "cognition provider");
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO agent_settings (agent_id, cognition_provider, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           cognition_provider = excluded.cognition_provider,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get([agentId, value, now, now]);
    if (!row) throw new Error("agent settings upsert did not persist");
    return mapSettings(row);
  }

  /**
   * Clear an agent's cognition-provider override (back to the default Pi loop, no trace)
   * by setting only that column to NULL. Returns the updated row, or undefined when the
   * agent had no settings row at all (nothing to clear) — symmetric with
   * {@link clearRecallProvider}. The row itself is kept even when every override is now
   * NULL, so a later setting preserves `created_at`.
   */
  clearCognitionProvider(agentId: string): AgentSettings | undefined {
    requireAgentId(agentId);
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE agent_settings SET cognition_provider = NULL, updated_at = ?
           WHERE agent_id = ? RETURNING *`,
      )
      .get([now, agentId]);
    return row ? mapSettings(row) : undefined;
  }

  /**
   * An agent's earned-standing threshold overrides — only the fields it has actually
   * set (a NULL column is omitted), so the resolver fills the rest from the kernel
   * default. Scoped to `agentId`, so it returns one agent's own bar, never another's.
   */
  getStandingThresholds(agentId: string): StandingThresholds {
    const settings = this.get(agentId);
    const out: StandingThresholds = {};
    for (const field of THRESHOLD_FIELDS) {
      const value = settings?.[field];
      if (value !== undefined) out[field] = value;
    }
    return out;
  }

  /**
   * Set an agent's earned-standing thresholds. Writes ONLY the provided fields — an
   * omitted field is left exactly as it was, so raising the execution bar never
   * clears a custom target bar, and neither touches `recall_budget`. Each provided
   * value is validated as a positive whole number at the write boundary (the kernel
   * never trusts a surface to have checked). `created_at` is preserved across an
   * upsert; `updated_at` advances. Throws if no field is provided.
   */
  setStandingThresholds(agentId: string, thresholds: StandingThresholds): AgentSettings {
    requireAgentId(agentId);
    const columns: string[] = [];
    const values: number[] = [];
    for (const field of THRESHOLD_FIELDS) {
      const value = thresholds[field];
      if (value === undefined) continue;
      validatePositiveInt(value, STANDING_LABEL[field]);
      columns.push(THRESHOLD_COLUMN[field]);
      values.push(value);
    }
    if (columns.length === 0) throw new Error("no standing thresholds to set");

    const now = new Date().toISOString();
    // Column names come only from THRESHOLD_COLUMN (all literals), never user input.
    const insertCols = ["agent_id", ...columns, "created_at", "updated_at"].join(", ");
    const placeholders = ["?", ...columns.map(() => "?"), "?", "?"].join(", ");
    const updates = [
      ...columns.map((c) => `${c} = excluded.${c}`),
      "updated_at = excluded.updated_at",
    ].join(", ");
    const row = this.driver
      .prepare(
        `INSERT INTO agent_settings (${insertCols}) VALUES (${placeholders})
         ON CONFLICT(agent_id) DO UPDATE SET ${updates}
         RETURNING *`,
      )
      .get([agentId, ...values, now, now]);
    if (!row) throw new Error("agent settings upsert did not persist");
    return mapSettings(row);
  }

  /**
   * Clear BOTH earned-standing threshold overrides (back to the kernel default) by
   * NULLing only those columns — `recall_budget` is untouched. Returns the updated
   * row, or undefined when the agent had no settings row at all. The row itself is
   * kept even when every override is now NULL, so a later setting preserves
   * `created_at`.
   */
  clearStandingThresholds(agentId: string): AgentSettings | undefined {
    requireAgentId(agentId);
    const now = new Date().toISOString();
    const row = this.driver
      .prepare(
        `UPDATE agent_settings
           SET min_clean_executions = NULL, min_distinct_targets = NULL, updated_at = ?
           WHERE agent_id = ? RETURNING *`,
      )
      .get([now, agentId]);
    return row ? mapSettings(row) : undefined;
  }
}
