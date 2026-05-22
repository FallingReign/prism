CREATE TABLE IF NOT EXISTS slack_forwarding_rate_limits (
  token_profile_id text NOT NULL REFERENCES token_profiles(id) ON DELETE CASCADE,
  slack_method text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_reset_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_profile_id, slack_method),
  CHECK (window_reset_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS slack_forwarding_rate_limits_reset_idx
  ON slack_forwarding_rate_limits (window_reset_at);
