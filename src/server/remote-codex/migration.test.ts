import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("remote Codex database migration", () => {
  it("keeps pairing and installation credentials hash-only with ownership and replay constraints", async () => {
    const sql = (await readFile("db/migrations/0023_remote_codex_pairing.sql", "utf8")).toLowerCase();

    for (const table of [
      "remote_codex_pairing_requests",
      "remote_codex_pairing_create_limits",
      "remote_codex_installations",
      "remote_codex_installation_credentials",
      "remote_codex_request_nonces"
    ]) {
      expect(sql).toContain(table);
    }
    expect(sql).toContain("references prism_users(id)");
    expect(sql).toContain("references slack_connections(id)");
    expect(sql).toContain("unique (installation_id, nonce)");
    expect(sql).toContain("signing_key_fingerprint");
    expect(sql).toContain("default_team_id");
    expect(sql).not.toMatch(/\bone_time_secret\b|\baccess_token\b|\brefresh_token\b/);
  });
});
