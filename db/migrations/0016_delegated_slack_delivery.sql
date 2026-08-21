CREATE TABLE IF NOT EXISTS slack_delivery_delegation_requests (
  id text PRIMARY KEY,
  approval_handle_hash text NOT NULL UNIQUE,
  approval_handle_envelope jsonb,
  oauth_resume_handle_hash text UNIQUE,
  client_id text NOT NULL,
  source_key text NOT NULL,
  external_job_id text NOT NULL,
  revision integer NOT NULL,
  idempotency_key text NOT NULL,
  callback_uri text NOT NULL,
  expected_prism_user_id text NOT NULL,
  action text NOT NULL DEFAULT 'chat.postMessage',
  execution_mode text NOT NULL DEFAULT 'user',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  payload_envelope jsonb,
  payload_sha256 text NOT NULL,
  immutable_digest text NOT NULL,
  return_state_envelope jsonb,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  dpop_jkt text NOT NULL,
  not_before timestamptz NOT NULL,
  approval_expires_at timestamptz NOT NULL,
  delivery_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  approved_slack_connection_id text,
  approved_connection_id_snapshot text,
  approved_prism_user_id text,
  approved_slack_user_id text,
  approved_slack_team_id text,
  approved_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_delivery_requests_client_check
    CHECK (client_id = 'shg-playtest-delegation'),
  CONSTRAINT slack_delivery_requests_revision_check
    CHECK (revision >= 1),
  CONSTRAINT slack_delivery_requests_action_check
    CHECK (action = 'chat.postMessage'),
  CONSTRAINT slack_delivery_requests_execution_mode_check
    CHECK (execution_mode = 'user'),
  CONSTRAINT slack_delivery_requests_payload_hash_check
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_requests_approval_handle_hash_check
    CHECK (approval_handle_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_requests_oauth_resume_handle_hash_check
    CHECK (oauth_resume_handle_hash IS NULL OR oauth_resume_handle_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_requests_source_key_check
    CHECK (source_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_requests_immutable_digest_check
    CHECK (immutable_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_requests_pkce_check
    CHECK (code_challenge_method = 'S256' AND code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT slack_delivery_requests_dpop_jkt_check
    CHECK (dpop_jkt ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT slack_delivery_requests_team_check
    CHECK (team_id ~ '^T[A-Z0-9]{2,31}$'),
  CONSTRAINT slack_delivery_requests_channel_check
    CHECK (channel_id ~ '^[CG][A-Z0-9]{2,31}$'),
  CONSTRAINT slack_delivery_requests_envelopes_check
    CHECK (
      (payload_envelope IS NULL OR jsonb_typeof(payload_envelope) = 'object')
      AND (approval_handle_envelope IS NULL OR jsonb_typeof(approval_handle_envelope) = 'object')
      AND (return_state_envelope IS NULL OR jsonb_typeof(return_state_envelope) = 'object')
    ),
  CONSTRAINT slack_delivery_requests_state_check
    CHECK (state IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  CONSTRAINT slack_delivery_requests_pending_custody_check
    CHECK (
      state <> 'pending'
      OR (
        payload_envelope IS NOT NULL
        AND approval_handle_envelope IS NOT NULL
        AND return_state_envelope IS NOT NULL
      )
    ),
  CONSTRAINT slack_delivery_requests_text_bounds_check
    CHECK (
      char_length(id) BETWEEN 1 AND 160
      AND char_length(external_job_id) BETWEEN 1 AND 160
      AND char_length(idempotency_key) BETWEEN 1 AND 200
      AND char_length(callback_uri) BETWEEN 1 AND 2048
      AND char_length(expected_prism_user_id) BETWEEN 1 AND 160
    ),
  CONSTRAINT slack_delivery_requests_time_order_check
    CHECK (
      approval_expires_at > created_at
      AND delivery_expires_at > not_before
      AND delivery_expires_at > approval_expires_at
      AND updated_at >= created_at
      AND (approved_at IS NULL OR approved_at >= created_at)
      AND (terminal_at IS NULL OR terminal_at >= created_at)
    ),
  CONSTRAINT slack_delivery_requests_approval_snapshot_check
    CHECK (
      (
        (approved_at IS NULL
          AND approved_slack_connection_id IS NULL
          AND approved_connection_id_snapshot IS NULL
          AND approved_prism_user_id IS NULL
          AND approved_slack_user_id IS NULL
          AND approved_slack_team_id IS NULL)
        OR
        (approved_at IS NOT NULL
          AND approved_slack_connection_id IS NOT NULL
          AND approved_connection_id_snapshot IS NOT NULL
          AND approved_prism_user_id IS NOT NULL
          AND approved_slack_user_id IS NOT NULL
          AND approved_slack_team_id IS NOT NULL)
      )
      AND (state <> 'approved' OR approved_at IS NOT NULL)
      AND (state <> 'pending' OR approved_at IS NULL)
    ),
  CONSTRAINT slack_delivery_requests_connection_owner_fk
    FOREIGN KEY (approved_slack_connection_id, approved_prism_user_id)
    REFERENCES slack_connections (id, prism_user_id)
    ON DELETE RESTRICT,
  UNIQUE (client_id, external_job_id, revision),
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS slack_delivery_requests_pending_expiry_idx
  ON slack_delivery_delegation_requests (approval_expires_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS slack_delivery_requests_client_outstanding_idx
  ON slack_delivery_delegation_requests (client_id, approval_expires_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS slack_delivery_requests_source_outstanding_idx
  ON slack_delivery_delegation_requests (client_id, source_key, approval_expires_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS slack_delivery_requests_user_outstanding_idx
  ON slack_delivery_delegation_requests (expected_prism_user_id, approval_expires_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS slack_delivery_requests_due_idx
  ON slack_delivery_delegation_requests (not_before, delivery_expires_at)
  WHERE state = 'approved';

CREATE INDEX IF NOT EXISTS slack_delivery_requests_terminal_cleanup_idx
  ON slack_delivery_delegation_requests (terminal_at)
  WHERE terminal_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS slack_delivery_authorization_codes (
  code_hash text PRIMARY KEY,
  request_id text NOT NULL UNIQUE
    REFERENCES slack_delivery_delegation_requests(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_delivery_codes_hash_check
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_codes_time_order_check
    CHECK (expires_at > created_at AND (used_at IS NULL OR used_at >= created_at))
);

CREATE INDEX IF NOT EXISTS slack_delivery_codes_active_expiry_idx
  ON slack_delivery_authorization_codes (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS slack_delivery_grants (
  id text PRIMARY KEY,
  grant_hash text NOT NULL UNIQUE,
  pepper_id text NOT NULL,
  request_id text NOT NULL UNIQUE
    REFERENCES slack_delivery_delegation_requests(id) ON DELETE RESTRICT,
  dpop_jkt text NOT NULL,
  slack_connection_id text,
  connection_id_snapshot text NOT NULL,
  prism_user_id text NOT NULL,
  slack_user_id text NOT NULL,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_id text,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  upstream_called boolean NOT NULL DEFAULT false,
  slack_request_id text,
  slack_ts text,
  slack_permalink text,
  last_error_code text,
  expires_at timestamptz NOT NULL,
  status_retained_until timestamptz NOT NULL,
  executed_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_delivery_grants_hash_check
    CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_grants_dpop_jkt_check
    CHECK (dpop_jkt ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT slack_delivery_grants_team_check
    CHECK (team_id ~ '^T[A-Z0-9]{2,31}$'),
  CONSTRAINT slack_delivery_grants_channel_check
    CHECK (channel_id ~ '^[CG][A-Z0-9]{2,31}$'),
  CONSTRAINT slack_delivery_grants_state_check
    CHECK (state IN ('active', 'executing', 'sent', 'failed', 'cancelled', 'expired', 'outcome_unknown')),
  CONSTRAINT slack_delivery_grants_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT slack_delivery_grants_lease_check
    CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT slack_delivery_grants_text_bounds_check
    CHECK (
      char_length(id) BETWEEN 1 AND 160
      AND char_length(pepper_id) BETWEEN 1 AND 128
      AND char_length(connection_id_snapshot) BETWEEN 1 AND 160
      AND char_length(prism_user_id) BETWEEN 1 AND 160
      AND char_length(slack_user_id) BETWEEN 1 AND 64
      AND (slack_permalink IS NULL OR char_length(slack_permalink) <= 2048)
      AND (last_error_code IS NULL OR char_length(last_error_code) <= 120)
    ),
  CONSTRAINT slack_delivery_grants_time_order_check
    CHECK (
      expires_at > created_at
      AND status_retained_until >= expires_at
      AND updated_at >= created_at
      AND (lease_expires_at IS NULL OR lease_expires_at > created_at)
      AND (retry_after IS NULL OR (retry_after >= created_at AND retry_after < expires_at))
      AND (executed_at IS NULL OR executed_at >= created_at)
      AND (terminal_at IS NULL OR terminal_at >= created_at)
    ),
  CONSTRAINT slack_delivery_grants_connection_owner_fk
    FOREIGN KEY (slack_connection_id, prism_user_id)
    REFERENCES slack_connections (id, prism_user_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS slack_delivery_grants_active_work_idx
  ON slack_delivery_grants (state, expires_at)
  WHERE state IN ('active', 'executing');

CREATE INDEX IF NOT EXISTS slack_delivery_grants_due_idx
  ON slack_delivery_grants (retry_after, expires_at)
  WHERE state = 'active' AND upstream_called = false;

CREATE INDEX IF NOT EXISTS slack_delivery_grants_lease_expiry_idx
  ON slack_delivery_grants (lease_expires_at)
  WHERE state = 'executing';

CREATE INDEX IF NOT EXISTS slack_delivery_grants_status_cleanup_idx
  ON slack_delivery_grants (status_retained_until);

CREATE INDEX IF NOT EXISTS slack_delivery_grants_connection_active_idx
  ON slack_delivery_grants (slack_connection_id, expires_at)
  WHERE slack_connection_id IS NOT NULL AND state IN ('active', 'executing');

CREATE TABLE IF NOT EXISTS slack_delivery_dpop_replay (
  dpop_jkt text NOT NULL,
  jti_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dpop_jkt, jti_hash),
  CONSTRAINT slack_delivery_dpop_replay_jkt_check
    CHECK (dpop_jkt ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT slack_delivery_dpop_replay_hash_check
    CHECK (jti_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_dpop_replay_time_order_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS slack_delivery_dpop_replay_expiry_idx
  ON slack_delivery_dpop_replay (expires_at);

CREATE TABLE IF NOT EXISTS slack_delivery_rate_limits (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  window_reset_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_delivery_rate_limits_bucket_check
    CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_delivery_rate_limits_count_check
    CHECK (request_count >= 0),
  CONSTRAINT slack_delivery_rate_limits_time_order_check
    CHECK (window_reset_at > window_started_at AND updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS slack_delivery_rate_limits_reset_idx
  ON slack_delivery_rate_limits (window_reset_at);

ALTER TABLE slack_oauth_states
  ADD COLUMN IF NOT EXISTS delegated_delivery_request_id text
    REFERENCES slack_delivery_delegation_requests(id) ON DELETE SET NULL;

ALTER TABLE slack_oauth_states
  ADD COLUMN IF NOT EXISTS continuation_type text GENERATED ALWAYS AS (
    CASE
      WHEN oidc_authorization_request_id IS NOT NULL AND delegated_delivery_request_id IS NULL THEN 'oidc'
      WHEN oidc_authorization_request_id IS NULL AND delegated_delivery_request_id IS NOT NULL THEN 'delegated_delivery'
      ELSE 'none'
    END
  ) STORED;

ALTER TABLE slack_oauth_states
  DROP CONSTRAINT IF EXISTS slack_oauth_states_continuation_check;

ALTER TABLE slack_oauth_states
  ADD CONSTRAINT slack_oauth_states_continuation_check CHECK (
    NOT (oidc_authorization_request_id IS NOT NULL AND delegated_delivery_request_id IS NOT NULL)
    AND continuation_type IN ('none', 'oidc', 'delegated_delivery')
  );

CREATE INDEX IF NOT EXISTS slack_oauth_states_continuation_expiry_idx
  ON slack_oauth_states (continuation_type, expires_at)
  WHERE used_at IS NULL;

ALTER TABLE prism_activity_audit DROP CONSTRAINT IF EXISTS prism_activity_audit_activity_type_check;
ALTER TABLE prism_activity_audit DROP CONSTRAINT IF EXISTS prism_activity_audit_status_check;

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
      'delegated_delivery_outcome_unknown'
    )
  );

ALTER TABLE prism_activity_audit
  ADD CONSTRAINT prism_activity_audit_status_check CHECK (
    status IN (
      'attempted',
      'forwarded',
      'upstream_error',
      'denied',
      'unsupported',
      'auth_failed',
      'identity_unavailable',
      'parse_error',
      'rate_limited',
      'created',
      'listed',
      'revoked',
      'rotated',
      'updated',
      'deleted',
      'approved',
      'issued',
      'cancelled',
      'expired',
      'sent',
      'failed',
      'outcome_unknown'
    )
  );
