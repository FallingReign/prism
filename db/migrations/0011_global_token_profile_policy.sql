CREATE TABLE IF NOT EXISTS prism_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_prism_user_id text REFERENCES prism_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE token_profiles
  ADD COLUMN IF NOT EXISTS policy_effective_at timestamptz;

UPDATE token_profiles
SET policy_effective_at = COALESCE(policy_effective_at, updated_at, created_at)
WHERE policy_effective_at IS NULL;

ALTER TABLE token_profiles
  ALTER COLUMN policy_effective_at SET DEFAULT now(),
  ALTER COLUMN policy_effective_at SET NOT NULL;

INSERT INTO prism_settings (key, value, version)
VALUES (
  'global_token_profile_policy',
  '{
    "version": 1,
    "presets": {
      "allowed": ["read_only", "messages_only", "full_slack_bridge", "custom"],
      "default": "read_only"
    },
    "executionIdentities": {
      "allowed": ["automatic", "user", "bot", "selectable"],
      "default": "automatic"
    },
    "capabilities": {
      "defaults": {
        "actions": {
          "read": true,
          "search": true,
          "writeMessages": false,
          "reactions": false,
          "filesMetadata": false,
          "destructive": false
        },
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
        }
      },
      "maximum": {
        "actions": {
          "read": true,
          "search": true,
          "writeMessages": true,
          "reactions": true,
          "filesMetadata": true,
          "destructive": true
        },
        "surfaces": {
          "publicChannels": true,
          "privateChannels": true,
          "directMessages": true,
          "groupDirectMessages": true,
          "search": true,
          "filesMetadata": true,
          "canvases": false,
          "lists": false,
          "future": false
        }
      }
    },
    "expiry": {
      "allowNoExpiryForReadOnly": true,
      "maximumDays": {
        "readOnly": null,
        "nonDestructive": 90,
        "destructive": 30
      },
      "allowedExperimentTtls": ["24h", "7d"],
      "defaultExperimentTtl": null
    },
    "mutation": {
      "broadeningRequiresRotation": true,
      "narrowingAppliesImmediately": true,
      "maxRotationOverlap": "24h"
    }
  }'::jsonb,
  1
)
ON CONFLICT (key) DO NOTHING;

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
      'global_token_profile_policy_updated'
    )
  );
