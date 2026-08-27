ALTER TABLE token_profiles
  ADD COLUMN IF NOT EXISTS client_id text;

ALTER TABLE token_profiles
  DROP CONSTRAINT IF EXISTS token_profiles_client_id_check;

ALTER TABLE token_profiles
  ADD CONSTRAINT token_profiles_client_id_check CHECK (
    client_id IS NULL OR client_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS token_profiles_active_user_client_key
  ON token_profiles (prism_user_id, client_id)
  WHERE status = 'active' AND client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS token_profiles_client_connection_idx
  ON token_profiles (client_id, slack_connection_id)
  WHERE status = 'active' AND client_id IS NOT NULL;
