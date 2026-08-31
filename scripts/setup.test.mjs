import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectBootstrapConfig,
  parseEnv,
  runSetupWizard,
  updateManagedEnvValues,
  writeEnvFileAtomically,
} from "./setup.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Prism setup wizard", () => {
  it("creates one shared configuration and allows Docker for explicitly configured private HTTP", async () => {
    const directory = temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const examplePath = join(directory, ".env.example");
    writeFileSync(examplePath, minimalTemplate());
    const answers = ["", "", "2"];
    const messages = [];

    const result = await runSetupWizard({
      envPath,
      examplePath,
      ask: fakePrompt(answers),
      output: captureOutput(messages),
    });

    expect(result.selection).toBe("docker");
    expect(inspectBootstrapConfig({ envPath })).toMatchObject({ configured: true, missing: [] });
    const env = parseEnv(readFileSync(envPath, "utf8"));
    expect(env.PRISM_PUBLIC_BASE_URL).toBe("http://localhost:3732");
    expect(env.SLACK_OAUTH_REDIRECT_URI).toBe("http://localhost:3732/v1/slack/oauth/callback");
    expect(env.PRISM_CREDENTIAL_ENCRYPTION_KEY).not.toContain("replace-with");
    expect(env.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64).not.toContain("replace-with");
  });

  it("returns Docker when setup uses an HTTPS public URL", async () => {
    const directory = temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const examplePath = join(directory, ".env.example");
    writeFileSync(examplePath, minimalTemplate());

    const result = await runSetupWizard({
      envPath,
      examplePath,
      ask: fakePrompt([
        "https://prism.example",
        "https://playtest.example/api/auth/callback",
        "2",
      ]),
      output: quietOutput(),
    });

    expect(result.selection).toBe("docker");
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

  it("rejects public HTTP while accepting private and link-local HTTP URLs", async () => {
    const directory = temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const examplePath = join(directory, ".env.example");
    writeFileSync(examplePath, minimalTemplate());
    const messages = [];

    await runSetupWizard({
      envPath,
      examplePath,
      ask: fakePrompt([
        "http://prism.example:3732",
        "http://169.254.10.20:3732",
        "http://playtest.example/api/auth/callback",
        "http://10.20.30.40:3847/api/auth/callback",
        "3",
      ]),
      output: captureOutput(messages),
    });

    const env = parseEnv(readFileSync(envPath, "utf8"));
    expect(env.PRISM_PUBLIC_BASE_URL).toBe("http://169.254.10.20:3732");
    expect(env.PRISM_OIDC_PLAYTEST_REDIRECT_URI).toBe("http://10.20.30.40:3847/api/auth/callback");
    expect(messages.filter((message) => message.includes("HTTP is allowed only"))).toHaveLength(2);
  });

  it("deduplicates managed keys without changing unknown lines or comments", () => {
    const updated = updateManagedEnvValues([
      "# keep this comment",
      "PRISM_PUBLIC_BASE_URL=http://old.example",
      "UNKNOWN_VALUE=\"keep exactly\"",
      "PRISM_PUBLIC_BASE_URL=http://duplicate.example",
      "",
    ].join("\n"), {
      PRISM_PUBLIC_BASE_URL: "https://prism.example",
      POSTGRES_PORT: "5432",
    });

    expect(updated.match(/^PRISM_PUBLIC_BASE_URL=/gm)).toHaveLength(1);
    expect(updated).toContain("# keep this comment\n");
    expect(updated).toContain('UNKNOWN_VALUE="keep exactly"\n');
    expect(updated).toContain("PRISM_PUBLIC_BASE_URL=https://prism.example\n");
    expect(updated).toContain("POSTGRES_PORT=5432\n");
  });

  it("atomically replaces the env file and cleans temporary files on failure", () => {
    const directory = temporaryDirectory();
    const envPath = join(directory, ".env.local");
    writeFileSync(envPath, "VALUE=old\n");

    writeEnvFileAtomically(envPath, "VALUE=new\n");
    expect(readFileSync(envPath, "utf8")).toBe("VALUE=new\n");
    expect(readdirSync(directory)).toEqual([".env.local"]);

    expect(() => writeEnvFileAtomically(envPath, "VALUE=broken\n", {
      rename: () => { throw new Error("rename failed"); },
    })).toThrow("rename failed");
    expect(readFileSync(envPath, "utf8")).toBe("VALUE=new\n");
    expect(readdirSync(directory)).toEqual([".env.local"]);
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

function captureOutput(messages) {
  return { log: (message = "") => messages.push(String(message)), error: () => undefined };
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
