ALTER TABLE slack_connections
  ADD COLUMN IF NOT EXISTS authed_user_display_name text,
  ADD COLUMN IF NOT EXISTS display_names_enriched_at timestamptz;
