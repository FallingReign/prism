ALTER TABLE slack_connections
  ADD COLUMN IF NOT EXISTS team_name text,
  ADD COLUMN IF NOT EXISTS enterprise_name text;
