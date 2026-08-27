import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0018_retry_missing_user_display_names.sql"),
  "utf8"
);

describe("missing Slack user display-name retry migration", () => {
  it("clears only stale attempt markers on healthy connections without a user display name", () => {
    expect(migration).toContain("SET display_names_enriched_at = NULL");
    expect(migration).toContain("status = 'healthy'");
    expect(migration).toContain("NULLIF(authed_user_display_name, '') IS NULL");
    expect(migration).toContain("display_names_enriched_at IS NOT NULL");
  });
});
