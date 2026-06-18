// Phase 0 schema. Every scoped table carries an `agent_id` column and is
// indexed by it — scoping is enforced at the storage layer, never left to
// application code to "remember". The `agents` table's own `id` is the agentId.
//
// `team_id` and `owner_principal_id` are reserved, nullable, and unused in
// Phase 0; they are never surfaced through the public types.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  role                TEXT NOT NULL,
  soul_ref            TEXT NOT NULL,
  workspace_dir       TEXT NOT NULL,
  trust_level         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  team_id             TEXT,
  owner_principal_id  TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  input        TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  -- The run's final output text, stored so a later reflect invocation has a
  -- transcript to learn from (the process that produced it has long exited). This
  -- is the agent's OWN content, scoped by agent_id like input -- not a secret and
  -- not an event payload (the event log stays reference-only). Nullable until a run
  -- finishes with output.
  output       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  memory_type   TEXT NOT NULL,
  content       TEXT NOT NULL,
  confidence    REAL NOT NULL,
  source_run_id TEXT,
  status        TEXT NOT NULL,
  review_state  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_agent ON skills(agent_id);

CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  key         TEXT NOT NULL,
  value_ref   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(agent_id, key)
);
CREATE INDEX IF NOT EXISTS idx_credentials_agent ON credentials(agent_id);

-- The local secret store. Holds the plaintext credential value, addressed by a
-- value_ref; the credentials table stores only that ref. Scoped by agent_id like
-- every other table — a value_ref is meaningless without its owning agentId in
-- the filter. The value is the one plaintext-bearing column in the schema; it is
-- read only through SecretStore.read (a kernel-internal, destructive-classified
-- path) and never copied into events, runs, or memory.
CREATE TABLE IF NOT EXISTS secrets (
  value_ref   TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(agent_id, key)
);
CREATE INDEX IF NOT EXISTS idx_secrets_agent ON secrets(agent_id);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  run_id      TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);

-- An agent's earned standing per destructive capability — the "trust contract"
-- underneath the coarse trust_level. Scoped by agent_id like every other table;
-- one row per (agent, capability). standing is 'gated' or 'standing-grant'; only
-- the latter joins a run's autoApprove allow-list. basis is a references-only
-- summary (counts) of the evidence at the last change -- never an action's
-- arguments, keeping the row consistent with the event log's references-only rule.
-- A capability with no row here is implicitly gated.
CREATE TABLE IF NOT EXISTS capability_standing (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  capability  TEXT NOT NULL,
  standing    TEXT NOT NULL,
  basis       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(agent_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_capability_standing_agent ON capability_standing(agent_id);

-- Per-agent kernel settings -- the operator-configurable knobs that tune how an
-- agent thinks, scoped by agent_id like everything else (the agent is the
-- isolation boundary; there is no global settings store any agent can reach).
-- One row per agent (agent_id IS the primary key), each column a nullable
-- override where NULL means "unset -- fall back to the kernel default". This is
-- the shared home for per-agent tunables: recall_budget is the first, and future
-- knobs (e.g. earned-standing thresholds) add a column here rather than accreting
-- onto the agents identity table. A nullable column added later is picked up on a
-- fresh open via this CREATE; an older database with the table already present
-- needs the additive ALTER in store.migrate(), same as every other later column.
CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id      TEXT PRIMARY KEY REFERENCES agents(id),
  recall_budget INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;
