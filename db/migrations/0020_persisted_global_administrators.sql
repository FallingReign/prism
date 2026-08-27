ALTER TABLE prism_configuration_admins
  ADD COLUMN IF NOT EXISTS granted_by_prism_user_id text REFERENCES prism_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revoked_by_prism_user_id text REFERENCES prism_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grant_reason text,
  ADD COLUMN IF NOT EXISTS revoke_reason text;

ALTER TABLE prism_configuration_admins
  DROP CONSTRAINT IF EXISTS prism_configuration_admins_claim_source_check;

ALTER TABLE prism_configuration_admins
  ADD CONSTRAINT prism_configuration_admins_claim_source_check
    CHECK (claim_source IN ('initial_bootstrap', 'setup_recovery', 'admin_grant')),
  ADD CONSTRAINT prism_configuration_admins_grant_reason_check
    CHECK (grant_reason IS NULL OR (char_length(btrim(grant_reason)) BETWEEN 1 AND 240)),
  ADD CONSTRAINT prism_configuration_admins_revoke_reason_check
    CHECK (revoke_reason IS NULL OR (char_length(btrim(revoke_reason)) BETWEEN 1 AND 240));

CREATE INDEX IF NOT EXISTS prism_configuration_admins_active_idx
  ON prism_configuration_admins (prism_user_id)
  WHERE role = 'global_configuration_admin' AND revoked_at IS NULL;

ALTER TABLE prism_activity_audit DROP CONSTRAINT IF EXISTS prism_activity_audit_activity_type_check;

ALTER TABLE prism_activity_audit
  ADD CONSTRAINT prism_activity_audit_activity_type_check CHECK (
    activity_type IN (
      'slack_method', 'token_profile_created', 'token_profiles_listed',
      'token_profile_revoked', 'token_profile_rotated', 'token_profile_policy_updated',
      'token_profile_deleted', 'slack_connection_removed',
      'global_token_profile_policy_updated', 'admin_token_profile_revoked',
      'admin_token_profile_deleted', 'admin_slack_connection_removed',
      'admin_global_admin_granted', 'admin_global_admin_revoked',
      'delegated_delivery_requested', 'delegated_delivery_approved',
      'delegated_delivery_denied', 'delegated_delivery_grant_issued',
      'delegated_delivery_execution', 'delegated_delivery_cancelled',
      'delegated_delivery_expired', 'delegated_delivery_rate_limited',
      'delegated_delivery_outcome_unknown', 'slack_configuration_candidate_created',
      'slack_configuration_activated', 'configuration_admin_claimed'
    )
  );
