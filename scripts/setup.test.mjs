import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectBootstrapConfig, parseEnv, runSetupWizard } from "./setup.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Prism setup wizard", () => {
  it("creates one shared host and Docker configuration and returns the selected runtime", async () => {
    const directory = temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const examplePath = join(directory, ".env.example");
    writeFileSync(examplePath, minimalTemplate());
    const answers = ["", "", "2"];

    const result = await runSetupWizard({
      envPath,
      examplePath,
      ask: fakePrompt(answers),
      output: quietOutput(),
    });

    expect(result.selection).toBe("docker");
    expect(inspectBootstrapConfig({ envPath })).toMatchObject({ configured: true, missing: [] });
    const env = parseEnv(readFileSync(envPath, "utf8"));
    expect(env.PRISM_PUBLIC_BASE_URL).toBe("http://localhost:3732");
    expect(env.SLACK_OAUTH_REDIRECT_URI).toBe("http://localhost:3732/v1/slack/oauth/callback");
    expect(env.PRISM_CREDENTIAL_ENCRYPTION_KEY).not.toContain("replace-with");
    expect(env.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64).not.toContain("replace-with");
  });

  it("reconfigures public values while preserving generated secrets by default", async () => {
    const directory = temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const examplePath = join(directory, ".env.example");
    writeFileSync(examplePath, minimalTemplate());
    writeFileSync(envPath, `${configuredEnv({
      PRISM_CREDENTIAL_ENCRYPTION_KEY: "existing-encryption-key",
      PRISM_DEVELOPER_TOKEN_PEPPER: "existing-pepper",
      PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: "existing-oidc-key",
    })}\nSLACK_CLIENT_SECRET="secret with spaces"\n`);
    const answers = ["https://prism.example", "https://playtest.example/api/auth/callback", "n", "3"];

    await runSetupWizard({
      envPath,
      examplePath,
      ask: fakePrompt(answers),
      output: quietOutput(),
    });

    const env = parseEnv(readFileSync(envPath, "utf8"));
    expect(env.PRISM_PUBLIC_BASE_URL).toBe("https://prism.example");
    expect(env.POSTGRES_PORT).toBe("5432");
    expect(env.PRISM_CREDENTIAL_ENCRYPTION_KEY).toBe("existing-encryption-key");
    expect(env.PRISM_DEVELOPER_TOKEN_PEPPER).toBe("existing-pepper");
    expect(env.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64).toBe("existing-oidc-key");
    expect(readFileSync(envPath, "utf8")).toContain('SLACK_CLIENT_SECRET="secret with spaces"');
  });

  it("fails clearly instead of prompting during noninteractive startup", async () => {
    await expect(
      runSetupWizard({ interactive: false, output: quietOutput() }),
    ).rejects.toThrow("interactive terminal");
  });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "prism-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakePrompt(answers) {
  return {
    ask: async () => answers.shift() ?? "",
    close: () => undefined,
  };
}

function quietOutput() {
  return { log: () => undefined, error: () => undefined };
}

function minimalTemplate() {
  return configuredEnv({
    POSTGRES_PASSWORD: "replace-with-password",
    PRISM_CREDENTIAL_ENCRYPTION_KEY: "replace-with-key",
    PRISM_CREDENTIAL_ENCRYPTION_KEY_ID: "replace-with-key-id",
    PRISM_DEVELOPER_TOKEN_PEPPER: "replace-with-pepper",
    PRISM_DEVELOPER_TOKEN_PEPPER_ID: "replace-with-pepper-id",
    PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: "replace-with-private-key",
    PRISM_OIDC_SIGNING_KEY_ID: "replace-with-signing-key-id",
  });
}

function configuredEnv(overrides = {}) {
  return Object.entries({
    POSTGRES_USER: "prism",
    POSTGRES_PASSWORD: "password",
    POSTGRES_DB: "prism",
    POSTGRES_HOST: "localhost",
    POSTGRES_PORT: "5432",
    PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
    SLACK_OAUTH_REDIRECT_URI: "http://localhost:3732/v1/slack/oauth/callback",
    PRISM_OIDC_ALLOW_INSECURE_HTTP: "1",
    PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
    PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback",
    PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: "private-key",
    PRISM_OIDC_SIGNING_KEY_ID: "oidc-key-id",
    PRISM_CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    PRISM_CREDENTIAL_ENCRYPTION_KEY_ID: "credential-key-id",
    PRISM_DEVELOPER_TOKEN_PEPPER: "developer-pepper",
    PRISM_DEVELOPER_TOKEN_PEPPER_ID: "developer-pepper-id",
    ...overrides,
  }).map(([key, value]) => `${key}=${value}`).join("\n");
}
