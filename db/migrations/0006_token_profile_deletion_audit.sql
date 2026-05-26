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
      'token_profile_policy_updated',
      'token_profile_deleted'
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
      'updated',
      'deleted'
    )
  );
