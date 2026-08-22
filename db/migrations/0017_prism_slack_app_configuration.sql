CREATE TABLE IF NOT EXISTS prism_setup_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT prism_setup_rate_limit_bucket_key_check
    CHECK (
      bucket_key = 'global:initial_slack_configuration'
      OR bucket_key ~ '^source:[0-9a-f]{64}$'
    ),
  CONSTRAINT prism_setup_rate_limit_attempt_count_check
    CHECK (attempt_count > 0),
  CONSTRAINT prism_setup_rate_limit_time_order_check
    CHECK (updated_at >= window_started_at)
);

CREATE INDEX IF NOT EXISTS prism_setup_rate_limit_buckets_updated_idx
  ON prism_setup_rate_limit_buckets (updated_at);

CREATE TABLE IF NOT EXISTS prism_setup_bootstrap_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'initial_slack_configuration',
  recovery boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  used_by_request_id text,
  CONSTRAINT prism_setup_bootstrap_tokens_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prism_setup_bootstrap_tokens_purpose_check
    CHECK (purpose = 'initial_slack_configuration'),
  CONSTRAINT prism_setup_bootstrap_tokens_text_bounds_check
    CHECK (
      char_length(id) BETWEEN 1 AND 160
      AND (used_by_request_id IS NULL OR char_length(used_by_request_id) BETWEEN 1 AND 120)
    ),
  CONSTRAINT prism_setup_bootstrap_tokens_time_order_check
    CHECK (
      expires_at > created_at
      AND (used_at IS NULL OR used_at >= created_at)
      AND (revoked_at IS NULL OR revoked_at >= created_at)
      AND NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL)
      AND ((used_at IS NULL) = (used_by_request_id IS NULL))
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS prism_setup_bootstrap_tokens_one_live_idx
  ON prism_setup_bootstrap_tokens (purpose)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS prism_setup_bootstrap_tokens_expiry_idx
  ON prism_setup_bootstrap_tokens (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS prism_setup_sessions (
  id text PRIMARY KEY,
  session_token_hash text NOT NULL UNIQUE,
  bootstrap_token_id text NOT NULL REFERENCES prism_setup_bootstrap_tokens(id) ON DELETE RESTRICT,
  purpose text NOT NULL DEFAULT 'initial_slack_configuration',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  claimed_at timestamptz,
  claimed_by_prism_user_id text REFERENCES prism_users(id) ON DELETE SET NULL,
  CONSTRAINT prism_setup_sessions_hash_check
    CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prism_setup_sessions_purpose_check
    CHECK (purpose = 'initial_slack_configuration'),
  CONSTRAINT prism_setup_sessions_text_bounds_check
    CHECK (char_length(id) BETWEEN 1 AND 160),
  CONSTRAINT prism_setup_sessions_time_order_check
    CHECK (
      expires_at > created_at
      AND (revoked_at IS NULL OR revoked_at >= created_at)
      AND (claimed_at IS NULL OR claimed_at >= created_at)
      AND NOT (revoked_at IS NOT NULL AND claimed_at IS NOT NULL)
    ),
  CONSTRAINT prism_setup_sessions_claim_check
    CHECK ((claimed_at IS NULL) = (claimed_by_prism_user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS prism_setup_sessions_expiry_idx
  ON prism_setup_sessions (expires_at)
  WHERE revoked_at IS NULL AND claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS prism_slack_app_configuration_versions (
  id text PRIMARY KEY,
  version bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  client_id text NOT NULL,
  client_secret_envelope jsonb NOT NULL,
  bot_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  user_scopes text[] NOT NULL,
  created_via text NOT NULL,
  created_by_prism_user_id text REFERENCES prism_users(id) ON DELETE RESTRICT,
  setup_session_id text REFERENCES prism_setup_sessions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT prism_slack_app_configuration_status_check
    CHECK (status IN ('pending', 'active', 'superseded')),
  CONSTRAINT prism_slack_app_configuration_client_id_check
    CHECK (char_length(client_id) BETWEEN 1 AND 255),
  CONSTRAINT prism_slack_app_configuration_secret_check
    CHECK (jsonb_typeof(client_secret_envelope) = 'object'),
  CONSTRAINT prism_slack_app_configuration_source_check
    CHECK (
      (created_via = 'bootstrap' AND setup_session_id IS NOT NULL AND created_by_prism_user_id IS NULL)
      OR
      (created_via = 'configuration_admin' AND setup_session_id IS NULL AND created_by_prism_user_id IS NOT NULL)
    ),
  CONSTRAINT prism_slack_app_configuration_time_order_check
    CHECK (
      (activated_at IS NULL OR activated_at >= created_at)
      AND (superseded_at IS NULL OR superseded_at >= created_at)
      AND (status <> 'pending' OR (activated_at IS NULL AND superseded_at IS NULL))
      AND (status <> 'active' OR (activated_at IS NOT NULL AND superseded_at IS NULL))
      AND (status <> 'superseded' OR superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS prism_slack_app_configuration_one_active_idx
  ON prism_slack_app_configuration_versions ((status))
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS prism_slack_app_configuration_setup_pending_idx
  ON prism_slack_app_configuration_versions (setup_session_id)
  WHERE status = 'pending' AND setup_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS prism_slack_app_configuration_pending_cleanup_idx
  ON prism_slack_app_configuration_versions (created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS prism_configuration_admins (
  prism_user_id text PRIMARY KEY REFERENCES prism_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'global_configuration_admin',
  claim_source text NOT NULL DEFAULT 'initial_bootstrap',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT prism_configuration_admins_role_check
    CHECK (role = 'global_configuration_admin'),
  CONSTRAINT prism_configuration_admins_claim_source_check
    CHECK (claim_source = 'initial_bootstrap'),
  CONSTRAINT prism_configuration_admins_time_order_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

ALTER TABLE slack_oauth_states
  ADD COLUMN IF NOT EXISTS slack_app_configuration_version_id text
    REFERENCES prism_slack_app_configuration_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS setup_session_id text
    REFERENCES prism_setup_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS environment_configuration_fingerprint text;

ALTER TABLE slack_oauth_states
  DROP CONSTRAINT IF EXISTS slack_oauth_states_configuration_binding_check;

ALTER TABLE slack_oauth_states
  ADD CONSTRAINT slack_oauth_states_configuration_binding_check CHECK (
    (environment_configuration_fingerprint IS NULL OR environment_configuration_fingerprint ~ '^[0-9a-f]{64}$')
    AND NOT (
      slack_app_configuration_version_id IS NOT NULL
      AND environment_configuration_fingerprint IS NOT NULL
    )
    AND (setup_session_id IS NULL OR slack_app_configuration_version_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS slack_oauth_states_configuration_version_idx
  ON slack_oauth_states (slack_app_configuration_version_id)
  WHERE used_at IS NULL AND slack_app_configuration_version_id IS NOT NULL;

ALTER TABLE prism_activity_audit DROP CONSTRAINT IF EXISTS prism_activity_audit_activity_type_check;

ALTER TABLE prism_activity_audit
  ADD CONSTRAINT prism_activity_audit_activity_type_check CHECK (
    activity_type IN (
      'slack_method',
      'token_profile_created',
      'token_profiles_listed',
      'token_profile_revoked',
      'token_profile_rotated',
      'token_profile_policy_updated',
      'token_profile_deleted',
      'slack_connection_removed',
      'global_token_profile_policy_updated',
      'admin_token_profile_revoked',
      'admin_token_profile_deleted',
      'admin_slack_connection_removed',
      'delegated_delivery_requested',
      'delegated_delivery_approved',
      'delegated_delivery_denied',
      'delegated_delivery_grant_issued',
      'delegated_delivery_execution',
      'delegated_delivery_cancelled',
      'delegated_delivery_expired',
      'delegated_delivery_rate_limited',
      'delegated_delivery_outcome_unknown',
      'slack_configuration_candidate_created',
      'slack_configuration_activated',
      'configuration_admin_claimed'
    )
  );
