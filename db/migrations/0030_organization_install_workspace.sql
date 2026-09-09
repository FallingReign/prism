-- Slack reports the authorizing workspace alongside org-wide installs, so an
-- organization connection may legitimately carry a team_id. The previous check
-- required team_id to be null and rejected every real enterprise installation.
ALTER TABLE slack_connections
  DROP CONSTRAINT IF EXISTS slack_connections_installation_scope_check;

ALTER TABLE slack_connections
  ADD CONSTRAINT slack_connections_installation_scope_check CHECK (
    (installation_scope = 'workspace' AND team_id IS NOT NULL AND is_enterprise_install = false)
    OR
    (installation_scope = 'organization' AND enterprise_id IS NOT NULL AND is_enterprise_install = true)
  );
