import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0017_prism_slack_app_configuration.sql"
);
const migration = readFileSync(migrationPath, "utf8");

describe("Prism Slack configuration migration", () => {
  it("stores only hashed setup capabilities and sessions", () => {
    expect(migration).toContain("token_hash text NOT NULL UNIQUE");
    expect(migration).toContain("session_token_hash text NOT NULL UNIQUE");
    expect(migration).toContain("CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(migration).toContain("CHECK (session_token_hash ~ '^[0-9a-f]{64}$')");
    expect(migration).not.toMatch(/plaintext_(token|secret)|raw_(token|secret)/i);
  });

  it("persists only the global circuit-breaker and HMAC-attributed source buckets", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS prism_setup_rate_limit_buckets");
    expect(migration).toContain("bucket_key = 'global:initial_slack_configuration'");
    expect(migration).toContain("bucket_key ~ '^source:[0-9a-f]{64}$'");
    expect(migration).toContain("attempt_count integer NOT NULL");
    expect(migration).not.toMatch(/bucket_key\s+LIKE\s+'source:%'/i);
  });

  it("creates immutable configuration versions and one active version", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS prism_slack_app_configuration_versions");
    expect(migration).toContain("version bigint GENERATED ALWAYS AS IDENTITY UNIQUE");
    expect(migration).toContain("prism_slack_app_configuration_one_active_idx");
    expect(migration).toContain("client_secret_envelope jsonb NOT NULL");
  });

  it("binds OAuth state to one exact database or environment configuration", () => {
    expect(migration).toContain("slack_app_configuration_version_id text");
    expect(migration).toContain("setup_session_id text");
    expect(migration).toContain("environment_configuration_fingerprint text");
    expect(migration).toContain("slack_oauth_states_configuration_binding_check");
  });
});
