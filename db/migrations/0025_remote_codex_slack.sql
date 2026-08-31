CREATE TABLE IF NOT EXISTS remote_codex_slack_rate_limits (
  owner_key text NOT NULL CHECK (char_length(owner_key) BETWEEN 1 AND 128),
  slack_method text NOT NULL CHECK (char_length(slack_method) BETWEEN 1 AND 120),
  window_started_at timestamptz NOT NULL,
  window_reset_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, slack_method),
  CHECK (window_reset_at > window_started_at)
);

CREATE TABLE IF NOT EXISTS slack_inbound_receipts (
  team_id text NOT NULL,
  callback_id text NOT NULL,
  callback_type text NOT NULL CHECK (callback_type IN ('event', 'interaction')),
  retry_number integer,
  status text NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, callback_id, callback_type)
);

CREATE INDEX IF NOT EXISTS slack_inbound_receipt_expiry_idx ON slack_inbound_receipts (expires_at);

CREATE TABLE IF NOT EXISTS remote_codex_slack_bindings (
  id text PRIMARY KEY,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  codex_thread_id text NOT NULL,
  team_id text NOT NULL,
  channel_id text,
  thread_ts text,
  root_message_ts text,
  state text NOT NULL CHECK (state IN ('creating', 'active', 'failed', 'detached')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  detached_at timestamptz,
  FOREIGN KEY (installation_id, codex_thread_id)
    REFERENCES remote_codex_sessions(installation_id, codex_thread_id) ON DELETE CASCADE,
  FOREIGN KEY (slack_connection_id, prism_user_id)
    REFERENCES slack_connections(id, prism_user_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id, prism_user_id, slack_connection_id)
    REFERENCES remote_codex_installations(id, prism_user_id, slack_connection_id) ON DELETE CASCADE,
  CHECK (team_id ~ '^T[A-Z0-9]{2,31}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS remote_codex_active_session_binding_idx
  ON remote_codex_slack_bindings (installation_id, codex_thread_id)
  WHERE state IN ('creating', 'active');

CREATE UNIQUE INDEX IF NOT EXISTS remote_codex_active_slack_thread_binding_idx
  ON remote_codex_slack_bindings (team_id, channel_id, thread_ts)
  WHERE state = 'active';

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
      'admin_global_admin_granted',
      'admin_global_admin_revoked',
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
      'configuration_admin_claimed',
      'remote_codex_app_home_published',
      'remote_codex_binding_created',
      'remote_codex_binding_status_updated'
    )
  );
