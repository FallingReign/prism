CREATE TABLE IF NOT EXISTS oidc_authorization_rate_limits (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  window_reset_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_reset_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS oidc_authorization_rate_limits_reset_idx
  ON oidc_authorization_rate_limits (window_reset_at);

ALTER TABLE oidc_authorization_requests
  ADD COLUMN IF NOT EXISTS source_key text;

UPDATE oidc_authorization_requests
SET source_key = 'legacy'
WHERE source_key IS NULL;

ALTER TABLE oidc_authorization_requests
  ALTER COLUMN source_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS oidc_authorization_requests_outstanding_idx
  ON oidc_authorization_requests (client_id, source_key, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS slack_oauth_states_expiry_idx
  ON slack_oauth_states (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS slack_connections_id_owner_idx
  ON slack_connections (id, prism_user_id);

ALTER TABLE oidc_access_tokens
  ADD CONSTRAINT oidc_access_tokens_connection_owner_fk
  FOREIGN KEY (slack_connection_id, prism_user_id)
  REFERENCES slack_connections (id, prism_user_id)
  ON DELETE CASCADE;
