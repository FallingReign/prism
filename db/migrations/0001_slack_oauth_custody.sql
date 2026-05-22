CREATE TABLE IF NOT EXISTS prism_users (
  id text PRIMARY KEY,
  slack_team_id text NOT NULL,
  slack_user_id text NOT NULL,
  slack_enterprise_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slack_team_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS prism_sessions (
  session_token_hash text PRIMARY KEY,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slack_oauth_states (
  state_hash text PRIMARY KEY,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slack_connections (
  id text PRIMARY KEY,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  team_id text NOT NULL,
  enterprise_id text,
  authed_user_id text NOT NULL,
  app_id text NOT NULL,
  bot_scopes text NOT NULL DEFAULT '',
  user_scopes text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('healthy', 'reauth_required')),
  last_error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, authed_user_id)
);

CREATE TABLE IF NOT EXISTS slack_credentials (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('bot', 'user')),
  token_type text,
  access_token_envelope jsonb NOT NULL,
  refresh_token_envelope jsonb,
  expires_at timestamptz,
  scopes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, kind)
);

CREATE TABLE IF NOT EXISTS token_profiles (
  id text PRIMARY KEY,
  prism_user_id text NOT NULL REFERENCES prism_users(id) ON DELETE CASCADE,
  slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prism_user_id, slack_connection_id)
);
