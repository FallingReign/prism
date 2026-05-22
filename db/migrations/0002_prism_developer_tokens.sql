ALTER TABLE token_profiles DROP CONSTRAINT IF EXISTS token_profiles_prism_user_id_slack_connection_id_key;

ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS name_normalized text;
ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS intended_use text;
ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS preset text;
ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS capability_map jsonb;
ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE token_profiles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

UPDATE token_profiles
SET
  status = 'bootstrap',
  name = COALESCE(name, 'Slack OAuth bootstrap'),
  name_normalized = COALESCE(name_normalized, 'slack oauth bootstrap'),
  intended_use = COALESCE(intended_use, 'Slack link placeholder; create a named Token profile to issue a Prism developer token.'),
  preset = COALESCE(preset, 'read_only'),
  capability_map = COALESCE(
    capability_map,
    '{
      "version": 1,
      "preset": "read_only",
      "workspaces": { "mode": "linked_slack_connection" },
      "surfaces": {
        "publicChannels": true,
        "privateChannels": true,
        "directMessages": true,
        "groupDirectMessages": true,
        "search": true,
        "filesMetadata": false,
        "canvases": false,
        "lists": false,
        "future": false
      },
      "actions": {
        "read": true,
        "search": true,
        "writeMessages": false,
        "reactions": false,
        "filesMetadata": false,
        "destructive": false
      },
      "executionIdentity": "automatic",
      "experiment": { "enabled": false, "ttl": null },
      "mutation": {
        "destructiveOptIn": false,
        "narrowingAppliesImmediately": true,
        "broadeningRequiresRotation": true
      },
      "deferred": {
        "admin": false,
        "fileTransfer": false,
        "events": false,
        "slashCommands": false,
        "interactivity": false,
        "canvases": false,
        "lists": false
      }
    }'::jsonb
  )
WHERE name IS NULL OR name_normalized IS NULL OR intended_use IS NULL OR preset IS NULL OR capability_map IS NULL;

ALTER TABLE token_profiles ALTER COLUMN name SET NOT NULL;
ALTER TABLE token_profiles ALTER COLUMN name_normalized SET NOT NULL;
ALTER TABLE token_profiles ALTER COLUMN intended_use SET NOT NULL;
ALTER TABLE token_profiles ALTER COLUMN preset SET NOT NULL;
ALTER TABLE token_profiles ALTER COLUMN capability_map SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_profiles_status_check'
  ) THEN
    ALTER TABLE token_profiles
      ADD CONSTRAINT token_profiles_status_check CHECK (status IN ('active', 'bootstrap', 'revoked'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_profiles_preset_check'
  ) THEN
    ALTER TABLE token_profiles
      ADD CONSTRAINT token_profiles_preset_check CHECK (preset IN ('read_only', 'messages_only', 'full_slack_bridge', 'custom'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_profiles_non_empty_profile_check'
  ) THEN
    ALTER TABLE token_profiles
      ADD CONSTRAINT token_profiles_non_empty_profile_check CHECK (
        length(btrim(name)) > 0
        AND length(btrim(name_normalized)) > 0
        AND length(btrim(intended_use)) > 0
        AND jsonb_typeof(capability_map) = 'object'
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_profiles_expiry_after_create_check'
  ) THEN
    ALTER TABLE token_profiles
      ADD CONSTRAINT token_profiles_expiry_after_create_check CHECK (expires_at IS NULL OR expires_at > created_at);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS token_profiles_active_user_name_key
  ON token_profiles (prism_user_id, name_normalized)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS token_profiles_active_connection_idx
  ON token_profiles (prism_user_id, slack_connection_id, created_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS prism_developer_tokens (
  id text PRIMARY KEY,
  token_profile_id text NOT NULL REFERENCES token_profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  hash_algorithm text NOT NULL CHECK (hash_algorithm = 'hmac-sha256'),
  pepper_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS prism_developer_tokens_current_profile_key
  ON prism_developer_tokens (token_profile_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS prism_developer_tokens_profile_idx
  ON prism_developer_tokens (token_profile_id, created_at DESC);
