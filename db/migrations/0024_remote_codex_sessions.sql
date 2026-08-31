CREATE TABLE IF NOT EXISTS remote_codex_sessions (
  installation_id text NOT NULL REFERENCES remote_codex_installations(id) ON DELETE CASCADE,
  codex_thread_id text NOT NULL CHECK (char_length(codex_thread_id) BETWEEN 1 AND 128),
  safe_title text NOT NULL CHECK (char_length(safe_title) BETWEEN 1 AND 90),
  project_label text NOT NULL CHECK (char_length(project_label) BETWEEN 1 AND 60),
  status text NOT NULL CHECK (status IN ('ready', 'active', 'attention', 'unavailable')),
  last_activity_at timestamptz NOT NULL,
  catalog_version text NOT NULL CHECK (char_length(catalog_version) BETWEEN 1 AND 128),
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, codex_thread_id)
);

CREATE INDEX IF NOT EXISTS remote_codex_session_activity_idx
  ON remote_codex_sessions (installation_id, last_activity_at DESC);
