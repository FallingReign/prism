import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0024_align_default_non_destructive_token_expiry.sql"),
  "utf8"
);

describe("default non-destructive Token profile expiry migration", () => {
  it("aligns only an untouched bootstrap policy", () => {
    expect(migration).toContain("'{expiry,maximumDays,nonDestructive}'");
    expect(migration).toContain("'null'::jsonb");
    expect(migration).toContain("version = 1");
    expect(migration).toContain("updated_by_prism_user_id IS NULL");
    expect(migration).toContain("= '90'");
  });
});
