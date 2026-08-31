ALTER TABLE prism_users
  ADD COLUMN IF NOT EXISTS identity_scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS identity_scope_id text;

UPDATE prism_users
SET identity_scope_id = slack_team_id
WHERE identity_scope_id IS NULL;

ALTER TABLE prism_users
  ALTER COLUMN slack_team_id DROP NOT NULL;

ALTER TABLE prism_users
  DROP CONSTRAINT IF EXISTS prism_users_identity_scope_check;

ALTER TABLE prism_users
  ADD CONSTRAINT prism_users_identity_scope_check CHECK (
    (identity_scope = 'workspace' AND slack_team_id IS NOT NULL AND identity_scope_id = slack_team_id)
    OR
    (identity_scope = 'organization' AND slack_team_id IS NULL AND slack_enterprise_id IS NOT NULL AND identity_scope_id = slack_enterprise_id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS prism_users_organization_identity_idx
  ON prism_users (slack_enterprise_id, slack_user_id)
  WHERE identity_scope = 'organization';

ALTER TABLE slack_connections
  ADD COLUMN IF NOT EXISTS installation_scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS is_enterprise_install boolean NOT NULL DEFAULT false;

ALTER TABLE slack_connections
  ALTER COLUMN team_id DROP NOT NULL;

ALTER TABLE slack_connections
  DROP CONSTRAINT IF EXISTS slack_connections_team_id_authed_user_id_key;

ALTER TABLE slack_connections
  DROP CONSTRAINT IF EXISTS slack_connections_installation_scope_check;

ALTER TABLE slack_connections
  ADD CONSTRAINT slack_connections_installation_scope_check CHECK (
    (installation_scope = 'workspace' AND team_id IS NOT NULL AND is_enterprise_install = false)
    OR
    (installation_scope = 'organization' AND team_id IS NULL AND enterprise_id IS NOT NULL AND is_enterprise_install = true)
  );

CREATE UNIQUE INDEX IF NOT EXISTS slack_connections_workspace_install_idx
  ON slack_connections (app_id, team_id, authed_user_id)
  WHERE installation_scope = 'workspace';

CREATE UNIQUE INDEX IF NOT EXISTS slack_connections_organization_install_idx
  ON slack_connections (app_id, enterprise_id, authed_user_id)
  WHERE installation_scope = 'organization';

CREATE TABLE IF NOT EXISTS slack_connection_workspace_grants (
  id text PRIMARY KEY,
  slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  team_id text NOT NULL,
  team_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  source text NOT NULL CHECK (source IN ('legacy_backfill', 'oauth', 'auth_teams_list', 'event')),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_connection_workspace_grants_team_check
    CHECK (team_id ~ '^T[A-Z0-9]{2,31}$'),
  CONSTRAINT slack_connection_workspace_grants_revocation_check
    CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  UNIQUE (slack_connection_id, team_id)
);

CREATE INDEX IF NOT EXISTS slack_connection_workspace_grants_active_idx
  ON slack_connection_workspace_grants (slack_connection_id, status, team_id);

INSERT INTO slack_connection_workspace_grants
  (id, slack_connection_id, team_id, team_name, status, source)
SELECT
  'swg_' || md5(c.id || ':' || c.team_id),
  c.id,
  c.team_id,
  c.team_name,
  'active',
  'legacy_backfill'
FROM slack_connections c
WHERE c.installation_scope = 'workspace'
  AND c.team_id IS NOT NULL
  AND c.team_id ~ '^T[A-Z0-9]{2,31}$'
ON CONFLICT (slack_connection_id, team_id) DO NOTHING;
