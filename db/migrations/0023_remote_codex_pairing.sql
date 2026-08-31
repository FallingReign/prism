CREATE TABLE IF NOT EXISTS remote_codex_pairing_requests (
  id text PRIMARY KEY,
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  signing_public_key text NOT NULL,
  encryption_public_key text NOT NULL,
  machine_label text NOT NULL CHECK (char_length(machine_label) BETWEEN 1 AND 60),
  companion_version text NOT NULL CHECK (char_length(companion_version) BETWEEN 1 AND 32),
  verification_phrase text NOT NULL CHECK (char_length(verification_phrase) BETWEEN 5 AND 64),
  source_key text NOT NULL CHECK (source_key ~ '^[a-f0-9]{64}$'),
  source_attributed boolean NOT NULL,
  signing_key_fingerprint text NOT NULL CHECK (signing_key_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  approved_prism_user_id text REFERENCES prism_users(id) ON DELETE CASCADE,
  approved_slack_connection_id text,
  approved_team_id text CHECK (approved_team_id IS NULL OR approved_team_id ~ '^T[A-Z0-9]{2,31}$'),
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (approved_prism_user_id IS NULL)
    = (approved_slack_connection_id IS NULL)
    AND (approved_slack_connection_id IS NULL) = (approved_team_id IS NULL)
  ),
  FOREIGN KEY (approved_slack_connection_id, approved_prism_user_id)
    REFERENCES slack_connections(id, prism_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS remote_codex_pairing_expiry_idx
  ON remote_codex_pairing_requests (expires_at)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS remote_codex_pairing_source_outstanding_idx
  ON remote_codex_pairing_requests (source_key, expires_at)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS remote_codex_pairing_signing_outstanding_idx
  ON remote_codex_pairing_requests (signing_key_fingerprint, expires_at)
  WHERE status IN ('pending', 'approved');

ALTER TABLE slack_oauth_states
  ADD COLUMN IF NOT EXISTS remote_codex_pairing_id text
    REFERENCES remote_codex_pairing_requests(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS slack_oauth_states_continuation_expiry_idx;

ALTER TABLE slack_oauth_states
  DROP CONSTRAINT IF EXISTS slack_oauth_states_continuation_check;

ALTER TABLE slack_oauth_states
  DROP COLUMN IF EXISTS continuation_type;

ALTER TABLE slack_oauth_states
  ADD COLUMN continuation_type text GENERATED ALWAYS AS (
    CASE
      WHEN oidc_authorization_request_id IS NOT NULL
        AND delegated_delivery_request_id IS NULL
        AND remote_codex_pairing_id IS NULL THEN 'oidc'
      WHEN oidc_authorization_request_id IS NULL
        AND delegated_delivery_request_id IS NOT NULL
        AND remote_codex_pairing_id IS NULL THEN 'delegated_delivery'
      WHEN oidc_authorization_request_id IS NULL
        AND delegated_delivery_request_id IS NULL
        AND remote_codex_pairing_id IS NOT NULL THEN 'remote_codex_pairing'
      ELSE 'none'
    END
  ) STORED;

ALTER TABLE slack_oauth_states
  ADD CONSTRAINT slack_oauth_states_continuation_check CHECK (
    num_nonnulls(
      oidc_authorization_request_id,
      delegated_delivery_request_id,
      remote_codex_pairing_id
    ) <= 1
    AND continuation_type IN ('none', 'oidc', 'delegated_delivery', 'remote_codex_pairing')
  );

CREATE INDEX IF NOT EXISTS slack_oauth_states_continuation_expiry_idx
  ON slack_oauth_states (continuation_type, expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS remote_codex_pairing_create_limits (
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('global', 'source', 'signing_key')),
  bucket_key text NOT NULL CHECK (bucket_key ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  window_reset_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_kind, bucket_key),
  CHECK (window_reset_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS remote_codex_pairing_limit_reset_idx
  ON remote_codex_pairing_create_limits (window_reset_at);

CREATE TABLE IF NOT EXISTS remote_codex_installations (
  id text PRIMARY KEY,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  default_team_id text NOT NULL CHECK (default_team_id ~ '^T[A-Z0-9]{2,31}$'),
  signing_public_key text NOT NULL,
  encryption_public_key text NOT NULL,
  machine_label text NOT NULL CHECK (char_length(machine_label) BETWEEN 1 AND 60),
  companion_version text NOT NULL CHECK (char_length(companion_version) BETWEEN 1 AND 32),
  state text NOT NULL CHECK (state IN ('offline', 'online', 'needs_attention', 'revoked')) DEFAULT 'offline',
  paired_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE remote_codex_installations
  ADD CONSTRAINT remote_codex_installation_connection_owner_fkey
  FOREIGN KEY (slack_connection_id, prism_user_id)
  REFERENCES slack_connections(id, prism_user_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS remote_codex_installation_owner_connection_idx
  ON remote_codex_installations (id, prism_user_id, slack_connection_id);

CREATE UNIQUE INDEX IF NOT EXISTS remote_codex_active_signing_key_idx
  ON remote_codex_installations (signing_public_key)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS remote_codex_installation_credentials (
  installation_id text PRIMARY KEY REFERENCES remote_codex_installations(id) ON DELETE CASCADE,
  access_token_hash text NOT NULL CHECK (access_token_hash ~ '^[a-f0-9]{64}$'),
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_hash text NOT NULL CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  refresh_family_id text NOT NULL,
  refresh_rotation integer NOT NULL DEFAULT 0 CHECK (refresh_rotation >= 0),
  refresh_token_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS remote_codex_access_token_hash_idx
  ON remote_codex_installation_credentials (access_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS remote_codex_refresh_token_hash_idx
  ON remote_codex_installation_credentials (refresh_token_hash);

CREATE TABLE IF NOT EXISTS remote_codex_refresh_token_history (
  installation_id text NOT NULL REFERENCES remote_codex_installations(id) ON DELETE CASCADE,
  refresh_family_id text NOT NULL,
  refresh_token_hash text NOT NULL CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  rotation integer NOT NULL CHECK (rotation >= 0),
  used_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, refresh_token_hash)
);

CREATE TABLE IF NOT EXISTS remote_codex_request_nonces (
  installation_id text NOT NULL REFERENCES remote_codex_installations(id) ON DELETE CASCADE,
  nonce text NOT NULL CHECK (char_length(nonce) BETWEEN 16 AND 128),
  request_timestamp timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, nonce)
);

CREATE INDEX IF NOT EXISTS remote_codex_nonce_expiry_idx
  ON remote_codex_request_nonces (expires_at);
