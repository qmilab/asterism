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
  output       TEXT,
  -- When a reflect --propose tick has reflected on this run (ISO timestamp), or NULL
  -- if not yet. This is the per-run CLAIM that makes scheduled reflection single-flight:
  -- a tick atomically claims a run (NULL -> now) before queueing its proposals, so two
  -- overlapping proposers can't both process the same run and double-queue it. Cleared
  -- back to NULL if the model call for that run fails, so a transient failure is retried.
  reflected_at TEXT
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

-- An agent's standing objectives -- durable current purpose, scoped by agent_id
-- like every other table. status is 'active' | 'done' | 'dropped'; content is the
-- agent's own content, scoped by agent_id like memory.content -- and, because it
-- frames runs, firewall-screened on the write path exactly like memory.
--
-- review_state ('proposed' | 'accepted' | 'rejected', the canonical ReviewState
-- memory uses) governs ratification: an operator-declared objective is 'accepted'
-- (the create default); reflection PROPOSES a 'proposed' one that is INERT until a
-- human accepts it. ONLY 'active' AND 'accepted' frames a run -- so a proposed
-- objective never shapes behaviour until ratified, and done/dropped/rejected ones
-- are kept for history. A fresh open picks the column up via this CREATE; an older
-- database that already has the (slice-1) table gets it via the additive ALTER in
-- store.migrate() with DEFAULT 'accepted' (every pre-slice-2 objective was
-- operator-declared, hence implicitly ratified).
CREATE TABLE IF NOT EXISTS objectives (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  content      TEXT NOT NULL,
  status       TEXT NOT NULL,
  review_state TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objectives_agent ON objectives(agent_id);

-- An agent's WORLD-FACTS -- its own running record of the current situation
-- ("working notes"), scoped by agent_id like every other table. A (subject, value)
-- the agent maintains ITSELF mid-run; UNIQUE(agent_id, subject) makes a re-write of a
-- subject an UPSERT (superseded, not accumulated). subject and value are the agent's
-- own content, scoped by agent_id like memory.content -- and, because they frame runs,
-- firewall-screened on the write path exactly like memory. This is the one framing
-- input the agent writes without per-write human review, so the kernel caps the row
-- count per agent and frames these as the agent's OWN UNVERIFIED notes. A new table
-- (added after slice 1/2 shipped objectives), so a fresh open picks it up via this
-- CREATE and no store.migrate() ALTER is needed (only later COLUMNS need that).
CREATE TABLE IF NOT EXISTS world_facts (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  subject     TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(agent_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_world_facts_agent ON world_facts(agent_id);

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
-- the shared home for per-agent tunables: recall_budget was the first; the
-- earned-standing thresholds (min_clean_executions / min_distinct_targets) are
-- the second -- a new knob adds a column here rather than accreting onto the
-- agents identity table. Each setter touches only its own column(s), so tuning one
-- knob never clears another. A nullable column added later is picked up on a fresh
-- open via this CREATE; an older database with the table already present needs the
-- additive ALTER in store.migrate(), same as every other later column.
CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id             TEXT PRIMARY KEY REFERENCES agents(id),
  recall_budget        INTEGER,
  -- The agent's opt-in recall provider selection, or NULL for the built-in lexical
  -- ranker (the default). The only non-NULL value today is 'local' (local
  -- embeddings). The kernel stores the selection only; the host builds the provider,
  -- so core never imports ML. NULL ⇒ default, like every other column here.
  recall_provider      TEXT,
  -- The agent's opt-in cognition provider selection, or NULL for the default Pi loop
  -- (no trace). The only non-NULL value today is 'lodestar' (an auditable epistemic
  -- trace). The kernel stores the selection only; the host wraps the adapter, so core
  -- never imports Lodestar. Observe-only -- it records, it never gates. NULL ⇒ default.
  cognition_provider   TEXT,
  -- How much the cognition trace captures, or NULL for the references-only baseline (the
  -- default: no content). The only non-NULL value today is 'content', which also records
  -- redacted tool-output content behind the kernel's redaction boundary. A deliberate
  -- escalation kept separate from cognition_provider; inert unless that is set. NULL ⇒
  -- references only, like every other column here.
  cognition_capture    TEXT,
  -- The earning bar for a per-capability standing grant, overriding the kernel
  -- DEFAULT_STANDING_POLICY for this agent: how many clean confirmed executions,
  -- across how many distinct targets, a destructive capability must clear to be
  -- PROPOSED for auto-approval. NULL on either ⇒ that half uses the default.
  min_clean_executions INTEGER,
  min_distinct_targets INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
`;
