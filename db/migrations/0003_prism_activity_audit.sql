CREATE TABLE IF NOT EXISTS prism_activity_audit (
  id text PRIMARY KEY,
  prism_user_id text REFERENCES prism_users(id) ON DELETE SET NULL,
  slack_connection_id text REFERENCES slack_connections(id) ON DELETE SET NULL,
  token_profile_id text REFERENCES token_profiles(id) ON DELETE SET NULL,
  token_profile_name text,
  slack_user_id text,
  slack_team_id text,
  slack_enterprise_id text,
  activity_type text NOT NULL CHECK (activity_type IN ('slack_method', 'token_profile_created', 'token_profiles_listed')),
  endpoint text,
  slack_method text,
  action_category text,
  surface text,
  object_type text,
  object_id text,
  execution_mode text,
  status text NOT NULL CHECK (
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
      'listed'
    )
  ),
  error_class text,
  http_status integer,
  request_id text,
  upstream_called boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prism_activity_audit_user_recent_idx
  ON prism_activity_audit (prism_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS prism_activity_audit_profile_recent_idx
  ON prism_activity_audit (token_profile_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS prism_activity_audit_request_idx
  ON prism_activity_audit (request_id);

CREATE INDEX IF NOT EXISTS prism_activity_audit_retention_idx
  ON prism_activity_audit (retention_expires_at);
