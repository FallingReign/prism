CREATE TABLE IF NOT EXISTS oidc_authorization_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  state text NOT NULL,
  nonce text NOT NULL,
  scope text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oidc_authorization_requests_expiry_idx
  ON oidc_authorization_requests (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS oidc_authorization_codes (
  code_hash text PRIMARY KEY,
  request_id text REFERENCES oidc_authorization_requests(id) ON DELETE SET NULL,
  client_id text NOT NULL,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  nonce text NOT NULL,
  scope text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  auth_time timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oidc_authorization_codes_expiry_idx
  ON oidc_authorization_codes (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS oidc_access_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oidc_access_tokens_expiry_idx
  ON oidc_access_tokens (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE slack_oauth_states
  ADD COLUMN IF NOT EXISTS oidc_authorization_request_id text
    REFERENCES oidc_authorization_requests(id) ON DELETE SET NULL;
