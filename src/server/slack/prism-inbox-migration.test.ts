import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0026_prism_slack_inbox.sql"),
  "utf8"
);

describe("Prism Slack Inbox migration", () => {
  it("matches the text identifiers used by existing Token profiles and Slack connections", () => {
    expect(migration).toContain(
      "token_profile_id text NOT NULL REFERENCES token_profiles(id) ON DELETE CASCADE"
    );
    expect(migration).toContain(
      "slack_connection_id text NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE"
    );
    expect(migration).not.toMatch(/(?:token_profile_id|slack_connection_id) uuid/);
  });
});
