-- Runtime policy defaults allow non-expiring, non-destructive Token profiles.
-- Align only the untouched policy seeded by migration 0011. Policies changed
-- through the administrator UI have a newer version and an administrator ID,
-- so this does not override deployment-specific expiry choices.
UPDATE prism_settings
SET value = jsonb_set(
      value,
      '{expiry,maximumDays,nonDestructive}',
      'null'::jsonb,
      false
    ),
    updated_at = now()
WHERE key = 'global_token_profile_policy'
  AND version = 1
  AND updated_by_prism_user_id IS NULL
  AND value #>> '{expiry,maximumDays,nonDestructive}' = '90';
