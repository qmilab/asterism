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
  finished_at  TEXT
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

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  run_id      TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
`;
