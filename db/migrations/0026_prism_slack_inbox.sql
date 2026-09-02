CREATE TABLE IF NOT EXISTS prism_slack_inbound_routes (
  id uuid PRIMARY KEY,
  route_key_hash text NOT NULL UNIQUE,
  token_profile_id uuid NOT NULL REFERENCES token_profiles(id) ON DELETE CASCADE,
  slack_connection_id uuid NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  channel_id text NOT NULL,
  slack_user_id text NOT NULL,
  envelope_type text NOT NULL CHECK (envelope_type IN ('block_actions')),
  action_type text NOT NULL CHECK (action_type IN ('static_select')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prism_slack_inbound_routes_owner_idx
  ON prism_slack_inbound_routes(token_profile_id, status, expires_at);

CREATE TABLE IF NOT EXISTS prism_slack_inbound_deliveries (
  id uuid PRIMARY KEY,
  route_id uuid NOT NULL REFERENCES prism_slack_inbound_routes(id) ON DELETE CASCADE,
  token_profile_id uuid NOT NULL REFERENCES token_profiles(id) ON DELETE CASCADE,
  envelope_id text NOT NULL,
  payload_type text NOT NULL CHECK (payload_type IN ('block_actions')),
  api_app_id text NOT NULL,
  workspace_id text NOT NULL,
  enterprise_id text,
  slack_user_id text NOT NULL,
  channel_id text NOT NULL,
  message_ts text NOT NULL,
  block_id text,
  action_id text,
  action_type text NOT NULL CHECK (action_type IN ('static_select')),
  selected_option_value text,
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  lease_id uuid,
  lease_expires_at timestamptz,
  acknowledged_at timestamptz,
  payload_removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id, route_id)
);

CREATE INDEX IF NOT EXISTS prism_slack_inbound_deliveries_inbox_idx
  ON prism_slack_inbound_deliveries(token_profile_id, acknowledged_at, expires_at, lease_expires_at, received_at);

CREATE TABLE IF NOT EXISTS prism_slack_socket_worker_health (
  worker_key text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('disabled', 'starting', 'connected', 'disconnected', 'error', 'standby')),
  connected_at timestamptz,
  heartbeat_at timestamptz NOT NULL,
  last_error_class text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prism_slack_inbound_routes IS 'Generic, short-lived Slack inbound filters owned by one Prism Token profile.';
COMMENT ON TABLE prism_slack_inbound_deliveries IS 'Normalized short-lived Slack interaction deliveries. Raw Socket envelopes are never stored.';
