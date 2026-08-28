import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0022_prism_session_slack_connection.sql"),
  "utf8"
);

describe("Prism session Slack connection binding migration", () => {
  it("backfills each legacy session from one deterministic owned connection", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS slack_connection_id text");
    expect(migration).toContain("PARTITION BY s.session_token_hash");
    expect(migration).toContain("c.updated_at DESC");
    expect(migration).toContain("c.created_at DESC");
    expect(migration).toContain("c.id DESC");
    expect(migration).toContain("WHERE ranked.rank = 1");
  });

  it("requires the selected connection to belong to the session Prism user", () => {
    expect(migration).toContain("FOREIGN KEY (slack_connection_id, prism_user_id)");
    expect(migration).toContain("REFERENCES slack_connections(id, prism_user_id)");
    expect(migration).toContain("ON DELETE CASCADE");
  });

  it("invalidates orphaned legacy sessions before requiring a bound connection", () => {
    const deletePosition = migration.indexOf("DELETE FROM prism_sessions");
    const notNullPosition = migration.indexOf("ALTER COLUMN slack_connection_id SET NOT NULL");

    expect(deletePosition).toBeGreaterThan(-1);
    expect(migration).toContain("WHERE slack_connection_id IS NULL");
    expect(notNullPosition).toBeGreaterThan(deletePosition);
    expect(migration).toContain("ALTER COLUMN slack_connection_id SET NOT NULL");
  });
});
