import { describe, expect, it } from "vitest";

import { getCredentialEncryptionConfig, getDatabaseUrl, getSlackOAuthConfig, isSetupRequiredError } from "./config";

describe("server setup config", () => {
  it("derives the local database URL from canonical Postgres fields", () => {
    expect(
      getDatabaseUrl({
        POSTGRES_USER: "prism user",
        POSTGRES_PASSWORD: "local password",
        POSTGRES_DB: "prism-db",
        POSTGRES_HOST: "localhost",
        POSTGRES_PORT: "5433"
      })
    ).toBe("postgres://prism%20user:local%20password@localhost:5433/prism-db");
  });

  it("throws sanitized setup-required errors without echoing missing secret values", () => {
    expect(() => getSlackOAuthConfig({ SLACK_CLIENT_ID: "replace-with-client", SLACK_CLIENT_SECRET: "super-secret-canary" })).toThrow(
      "setup-required:SLACK_CLIENT_ID"
    );

    try {
      getCredentialEncryptionConfig({ PRISM_CREDENTIAL_ENCRYPTION_KEY: "replace-with-key", PRISM_CREDENTIAL_ENCRYPTION_KEY_ID: "local" });
    } catch (error) {
      expect(isSetupRequiredError(error)).toBe(true);
      expect(String(error)).not.toContain("super-secret-canary");
      expect(String(error)).not.toContain("replace-with-key");
    }
  });
});
