ALTER TABLE prism_developer_tokens DROP CONSTRAINT IF EXISTS prism_developer_tokens_superseded_by_token_id_fkey;

DROP INDEX IF EXISTS prism_developer_tokens_current_profile_key;

ALTER TABLE prism_developer_tokens ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE prism_developer_tokens ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE prism_developer_tokens ADD COLUMN IF NOT EXISTS superseded_by_token_id text;
ALTER TABLE prism_developer_tokens ADD COLUMN IF NOT EXISTS rotation_overlap_expires_at timestamptz;

UPDATE prism_developer_tokens
SET is_current = false
WHERE revoked_at IS NOT NULL;

ALTER TABLE prism_developer_tokens
  ADD CONSTRAINT prism_developer_tokens_superseded_by_token_id_fkey
  FOREIGN KEY (superseded_by_token_id) REFERENCES prism_developer_tokens(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prism_developer_tokens_current_supersede_check'
  ) THEN
    ALTER TABLE prism_developer_tokens
      ADD CONSTRAINT prism_developer_tokens_current_supersede_check CHECK (
        (is_current AND superseded_at IS NULL AND superseded_by_token_id IS NULL AND rotation_overlap_expires_at IS NULL)
        OR NOT is_current
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prism_developer_tokens_overlap_expiry_check'
  ) THEN
    ALTER TABLE prism_developer_tokens
      ADD CONSTRAINT prism_developer_tokens_overlap_expiry_check CHECK (
        rotation_overlap_expires_at IS NULL
        OR (
          superseded_at IS NOT NULL
          AND expires_at IS NOT NULL
          AND expires_at = rotation_overlap_expires_at
          AND rotation_overlap_expires_at > superseded_at
          AND rotation_overlap_expires_at <= superseded_at + interval '24 hours'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS prism_developer_tokens_current_profile_key
  ON prism_developer_tokens (token_profile_id)
  WHERE is_current = true AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS prism_developer_tokens_profile_current_idx
  ON prism_developer_tokens (token_profile_id, is_current, created_at DESC);

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
      'token_profile_policy_updated'
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
      'updated'
    )
  );
