import { describe, expect, it } from "vitest";

import {
  getCredentialEncryptionConfig,
  getDatabaseUrl,
  getDeveloperTokenConfig,
  getSlackOAuthConfig,
  isSetupRequiredError
} from "./config";

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

  it("loads developer token verifier config without echoing pepper values", () => {
    expect(getDeveloperTokenConfig({ PRISM_DEVELOPER_TOKEN_PEPPER: "pepper-secret-canary" })).toEqual({
      pepper: "pepper-secret-canary",
      pepperId: "local-dev-pepper-v1"
    });

    try {
      getDeveloperTokenConfig({ PRISM_DEVELOPER_TOKEN_PEPPER: "replace-with-pepper-secret-canary" });
    } catch (error) {
      expect(isSetupRequiredError(error)).toBe(true);
      expect(String(error)).toBe("Error: setup-required:PRISM_DEVELOPER_TOKEN_PEPPER");
      expect(String(error)).not.toContain("pepper-secret-canary");
    }
  });
});
