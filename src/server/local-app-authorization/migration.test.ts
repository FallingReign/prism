import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0023_generic_local_app_device_authorization.sql"),
  "utf8"
);

describe("generic local-app device authorization migration", () => {
  it("stores only hashed codes and binds approval to an owned Slack connection", () => {
    expect(migration).toContain("device_code_hash text NOT NULL UNIQUE");
    expect(migration).toContain("user_code_hash text NOT NULL UNIQUE");
    expect(migration).toContain("FOREIGN KEY (approved_slack_connection_id, approved_prism_user_id)");
    expect(migration).toContain("REFERENCES slack_connections (id, prism_user_id)");
    expect(migration).toMatch(
      /CONSTRAINT prism_local_app_authorizations_connection_owner_fkey[\s\S]*?REFERENCES slack_connections \(id, prism_user_id\)[\s\S]*?ON DELETE CASCADE/
    );
    expect(migration).not.toMatch(
      /CONSTRAINT prism_local_app_authorizations_connection_owner_fkey[\s\S]*?ON DELETE RESTRICT/
    );
    expect(migration).not.toMatch(/raw_(?:device|user|developer)_?(?:code|token)|plaintext/i);
  });

  it("allows exactly one typed OAuth continuation", () => {
    expect(migration).toContain("local_app_authorization_id uuid");
    expect(migration).toContain("num_nonnulls(");
    expect(migration).toContain("continuation_type IN ('none', 'oidc', 'delegated_delivery', 'local_app')");
  });
});
