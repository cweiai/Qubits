-- Qubits data layer schema (idempotent; runs automatically on service startup)
-- Business records use a generic constrained table; conversations/messages/build tasks are
-- persisted per-project; arbitrary tables are never created for AI output.

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  app_spec_json      TEXT,
  product_brief_json TEXT,
  app_blueprint_json TEXT,
  manifest_json      TEXT,
  current_snapshot_id TEXT,
  preview_bundle_id  TEXT,
  preview_version    INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Each conversation owns one generated application's manifest, snapshot, preview, and version.
CREATE TABLE IF NOT EXISTS conversations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  title               TEXT NOT NULL,
  title_source        TEXT NOT NULL DEFAULT 'auto', -- auto | user
  status              TEXT NOT NULL DEFAULT 'active', -- active | archived
  manifest_json       TEXT,
  current_snapshot_id TEXT,
  preview_bundle_id   TEXT,
  preview_version     INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  last_message_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id, last_message_at DESC);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL, -- user | assistant | system
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'completed', -- pending | streaming | completed | error
  error_code      TEXT,
  metadata_json   TEXT,
  request_id      TEXT,
  task_id         TEXT,
  role_id         TEXT,
  message_kind    TEXT, -- role | error | NULL
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_task ON conversation_messages (task_id);

CREATE TABLE IF NOT EXISTS build_tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT,
  prompt          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | ready | failed | conflict
  stage           TEXT NOT NULL DEFAULT 'idle',
  roles_json      TEXT,
  agent_runs_json TEXT,
  tool_events_json TEXT,
  error_code      TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  request_id      TEXT UNIQUE,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON build_tasks (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON build_tasks (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  app_id          TEXT NOT NULL,
  app_version     INTEGER NOT NULL,
  collections_json TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sandbox_sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sandbox_sessions (expires_at);

CREATE TABLE IF NOT EXISTS app_records (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  app_id     TEXT NOT NULL,
  collection TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_scope ON app_records (project_id, app_id, collection);

-- Immutable code snapshots: one row per promoted version; files live on disk under
-- data/snapshots/<projectId>/<snapshotId>/ and files_json records path + sha256 + size.
CREATE TABLE IF NOT EXISTS code_snapshots (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  version           INTEGER NOT NULL,
  manifest_json     TEXT NOT NULL,
  files_json        TEXT NOT NULL,
  deps_json         TEXT NOT NULL DEFAULT '[]',
  build_report_json TEXT,
  test_report_json  TEXT,
  review_report_json TEXT,
  preview_bundle_id TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON code_snapshots (project_id, version DESC);

-- Persisted artifacts (product_brief / app_blueprint / code_workspace / code_snapshot / build_report /
-- test_report / review_report / preview_bundle / ...). Content is capped and redacted.
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id    TEXT,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_by TEXT,
  parent_agent_run_id TEXT,
  schema_version INTEGER,
  size_bytes INTEGER,
  artifact_order INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id);

-- User decisions for high-risk tool calls. Rows are durable so a browser reconnect
-- cannot silently lose a pending request and a process restart cannot grant by default.
CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  task_id    TEXT,
  run_id     TEXT NOT NULL,
  tool_call_id TEXT,
  tool_name  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | granted | denied | expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals (run_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals (task_id, status);

-- One-click public deployments: each row is one containerized deployment of a
-- conversation's built preview bundle, exposed through the deploy router / tunnel.
CREATE TABLE IF NOT EXISTS deployments (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  conversation_id    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'starting', -- starting | live | stopped | expired | failed
  session_id         TEXT,
  container_name     TEXT,
  port               INTEGER,
  bundle_artifact_id TEXT,
  error_code         TEXT,
  error_message      TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  stopped_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deployments_conversation ON deployments (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments (status);
