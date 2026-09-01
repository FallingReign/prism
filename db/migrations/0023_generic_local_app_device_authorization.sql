CREATE TABLE IF NOT EXISTS prism_local_app_authorizations (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  client_id text NOT NULL,
  display_name text NOT NULL,
  intended_use text NOT NULL,
  requested_preset text NOT NULL DEFAULT 'messages_only',
  execution_identity text NOT NULL DEFAULT 'user',
  source_key text,
  status text NOT NULL DEFAULT 'pending',
  poll_interval_seconds integer NOT NULL DEFAULT 5,
  last_polled_at timestamptz,
  approved_prism_user_id text,
  approved_slack_connection_id text,
  token_profile_id text REFERENCES token_profiles(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  exchanged_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prism_local_app_authorizations_hashes_check CHECK (
    device_code_hash ~ '^[0-9a-f]{64}$'
    AND user_code_hash ~ '^[0-9a-f]{64}$'
    AND (source_key IS NULL OR source_key ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT prism_local_app_authorizations_client_check CHECK (
    client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT prism_local_app_authorizations_text_check CHECK (
    char_length(display_name) BETWEEN 1 AND 80
    AND char_length(intended_use) BETWEEN 1 AND 240
  ),
  CONSTRAINT prism_local_app_authorizations_policy_check CHECK (
    requested_preset = 'messages_only' AND execution_identity = 'user'
  ),
  CONSTRAINT prism_local_app_authorizations_status_check CHECK (
    status IN ('pending', 'approved', 'denied', 'exchanged', 'expired', 'policy_denied')
  ),
  CONSTRAINT prism_local_app_authorizations_poll_check CHECK (
    poll_interval_seconds BETWEEN 2 AND 30
  ),
  CONSTRAINT prism_local_app_authorizations_time_check CHECK (
    expires_at > created_at
    AND updated_at >= created_at
    AND (decided_at IS NULL OR decided_at >= created_at)
    AND (exchanged_at IS NULL OR exchanged_at >= created_at)
    AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  CONSTRAINT prism_local_app_authorizations_approval_check CHECK (
    (approved_prism_user_id IS NULL) = (approved_slack_connection_id IS NULL)
    AND (status NOT IN ('approved', 'exchanged') OR approved_prism_user_id IS NOT NULL)
  ),
  CONSTRAINT prism_local_app_authorizations_connection_owner_fkey
    FOREIGN KEY (approved_slack_connection_id, approved_prism_user_id)
    REFERENCES slack_connections (id, prism_user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS prism_local_app_authorizations_user_code_idx
  ON prism_local_app_authorizations (user_code_hash, expires_at)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS prism_local_app_authorizations_device_code_idx
  ON prism_local_app_authorizations (device_code_hash, client_id, expires_at);

CREATE INDEX IF NOT EXISTS prism_local_app_authorizations_client_outstanding_idx
  ON prism_local_app_authorizations (client_id, expires_at)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS prism_local_app_authorizations_source_outstanding_idx
  ON prism_local_app_authorizations (source_key, expires_at)
  WHERE source_key IS NOT NULL AND status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS prism_local_app_authorizations_cleanup_idx
  ON prism_local_app_authorizations (terminal_at, expires_at);

CREATE TABLE IF NOT EXISTS prism_local_app_authorization_rate_limits (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  window_reset_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prism_local_app_authorization_rate_bucket_check CHECK (
    bucket_key ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT prism_local_app_authorization_rate_count_check CHECK (request_count >= 0),
  CONSTRAINT prism_local_app_authorization_rate_time_check CHECK (
    window_reset_at > window_started_at AND updated_at >= created_at
  )
);

CREATE INDEX IF NOT EXISTS prism_local_app_authorization_rate_reset_idx
  ON prism_local_app_authorization_rate_limits (window_reset_at);

ALTER TABLE slack_oauth_states
  ADD COLUMN IF NOT EXISTS local_app_authorization_id uuid
    REFERENCES prism_local_app_authorizations(id) ON DELETE SET NULL;

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
        AND local_app_authorization_id IS NULL THEN 'oidc'
      WHEN oidc_authorization_request_id IS NULL
        AND delegated_delivery_request_id IS NOT NULL
        AND local_app_authorization_id IS NULL THEN 'delegated_delivery'
      WHEN oidc_authorization_request_id IS NULL
        AND delegated_delivery_request_id IS NULL
        AND local_app_authorization_id IS NOT NULL THEN 'local_app'
      ELSE 'none'
    END
  ) STORED;

ALTER TABLE slack_oauth_states
  ADD CONSTRAINT slack_oauth_states_continuation_check CHECK (
    num_nonnulls(
      oidc_authorization_request_id,
      delegated_delivery_request_id,
      local_app_authorization_id
    ) <= 1
    AND continuation_type IN ('none', 'oidc', 'delegated_delivery', 'local_app')
  );

CREATE INDEX IF NOT EXISTS slack_oauth_states_continuation_expiry_idx
  ON slack_oauth_states (continuation_type, expires_at)
  WHERE used_at IS NULL;

ALTER TABLE prism_activity_audit
  DROP CONSTRAINT IF EXISTS prism_activity_audit_activity_type_check;

ALTER TABLE prism_activity_audit
  ADD CONSTRAINT prism_activity_audit_activity_type_check CHECK (
    activity_type IN (
      'slack_method', 'token_profile_created', 'token_profiles_listed',
      'token_profile_revoked', 'token_profile_rotated', 'token_profile_policy_updated',
      'token_profile_deleted', 'slack_connection_removed',
      'global_token_profile_policy_updated', 'admin_token_profile_revoked',
      'admin_token_profile_deleted', 'admin_slack_connection_removed',
      'admin_global_admin_granted', 'admin_global_admin_revoked',
      'delegated_delivery_requested', 'delegated_delivery_approved',
      'delegated_delivery_denied', 'delegated_delivery_grant_issued',
      'delegated_delivery_execution', 'delegated_delivery_cancelled',
      'delegated_delivery_expired', 'delegated_delivery_rate_limited',
      'delegated_delivery_outcome_unknown', 'slack_configuration_candidate_created',
      'slack_configuration_activated', 'configuration_admin_claimed',
      'local_app_authorization_approved', 'local_app_authorization_denied',
      'local_app_token_issued'
    )
  );
