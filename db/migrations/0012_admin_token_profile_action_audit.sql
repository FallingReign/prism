ALTER TABLE prism_activity_audit
  ADD COLUMN IF NOT EXISTS admin_actor_prism_user_id text REFERENCES prism_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admin_actor_slack_user_id text,
  ADD COLUMN IF NOT EXISTS admin_actor_slack_display_name text,
  ADD COLUMN IF NOT EXISTS admin_reason text;

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
      'admin_token_profile_deleted'
    )
  );
