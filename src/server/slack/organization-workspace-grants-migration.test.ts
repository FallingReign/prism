import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0021_slack_organization_workspace_grants.sql"),
  "utf8"
);

describe("Slack organization workspace grant migration", () => {
  it("keeps workspace and organization installations in separate identity namespaces", () => {
    expect(migration).toContain("installation_scope = 'workspace'");
    expect(migration).toContain("installation_scope = 'organization'");
    expect(migration).toContain("slack_connections_workspace_install_idx");
    expect(migration).toContain("slack_connections_organization_install_idx");
    expect(migration).not.toContain("coalesce(team_id, enterprise_id)");
  });

  it("backfills one explicit active workspace grant per existing workspace connection", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS slack_connection_workspace_grants");
    expect(migration).toContain("source IN ('legacy_backfill', 'oauth', 'auth_teams_list', 'event')");
    expect(migration).toContain("WHERE c.installation_scope = 'workspace'");
    expect(migration).toContain("c.team_id ~ '^T[A-Z0-9]{2,31}$'");
    expect(migration).toContain("ON CONFLICT (slack_connection_id, team_id) DO NOTHING");
  });

  it("retains revoked grants as auditable rows", () => {
    expect(migration).toContain("status IN ('active', 'revoked')");
    expect(migration).toContain("revoked_at timestamptz");
    expect(migration).toContain("slack_connection_workspace_grants_revocation_check");
  });
});
