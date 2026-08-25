#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";

import { missingBootstrapConfiguration } from "./bootstrap-config.mjs";

const DEFAULT_ENV_PATH = ".env.local";
const DEFAULT_EXAMPLE_PATH = ".env.example";
const MANAGED_ENV_KEYS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "PRISM_PUBLIC_BASE_URL",
  "SLACK_OAUTH_REDIRECT_URI",
  "PRISM_OIDC_ALLOW_INSECURE_HTTP",
  "PRISM_OIDC_PLAYTEST_CLIENT_ID",
  "PRISM_OIDC_PLAYTEST_REDIRECT_URI",
  "PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64",
  "PRISM_OIDC_SIGNING_KEY_ID",
  "PRISM_CREDENTIAL_ENCRYPTION_KEY",
  "PRISM_CREDENTIAL_ENCRYPTION_KEY_ID",
  "PRISM_DEVELOPER_TOKEN_PEPPER",
  "PRISM_DEVELOPER_TOKEN_PEPPER_ID",
];

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (key) values[key] = stripMatchingQuotes(raw);
  }
  return values;
}

export function inspectBootstrapConfig({ envPath = DEFAULT_ENV_PATH } = {}) {
  if (!existsSync(envPath)) {
    return { configured: false, missing: [".env.local"] };
  }
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const missing = missingBootstrapConfiguration(env);
  return { configured: missing.length === 0, missing, env };
}

export async function runSetupWizard({
  envPath = DEFAULT_ENV_PATH,
  examplePath = DEFAULT_EXAMPLE_PATH,
  interactive = Boolean(stdin.isTTY && stdout.isTTY),
  ask,
  output = console,
} = {}) {
  if (!interactive && !ask) {
    throw new Error(
      "Prism setup needs an interactive terminal. Run `npm run setup` from a terminal, then start the service again.",
    );
  }

  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const templateText = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
  let text = existingText || templateText;
  const values = { ...parseEnv(templateText), ...parseEnv(existingText) };
  const prompt = ask ?? createTerminalPrompt();
  const reconfiguring = existingText.length > 0;

  output.log("");
  output.log(reconfiguring ? "Prism configuration" : "Welcome to Prism");
  output.log(
    reconfiguring
      ? "Update the server configuration below. Existing security keys are preserved unless you rotate them."
      : "This one-time setup creates the local configuration used by both host and Docker runs.",
  );
  output.log("");

  const publicBaseUrl = await askUrl(prompt, {
    label: "Prism public URL",
    current: configuredOr(values.PRISM_PUBLIC_BASE_URL, "http://localhost:3732"),
    originOnly: true,
    output,
  });
  const defaultPlaytestCallback = "http://localhost:3847/api/auth/callback";
  const playtestCallback = await askUrl(prompt, {
    label: "Playtest login callback URL",
    current: configuredOr(values.PRISM_OIDC_PLAYTEST_REDIRECT_URI, defaultPlaytestCallback),
    originOnly: false,
    output,
  });
  const rotate = reconfiguring
    ? await askYesNo(
        prompt,
        "Rotate generated security keys? Existing encrypted connections and developer tokens may need to be recreated.",
        false,
      )
    : false;

  values.POSTGRES_USER = configuredOr(values.POSTGRES_USER, "prism");
  values.POSTGRES_PASSWORD = secretValue(values.POSTGRES_PASSWORD, 24, rotate);
  values.POSTGRES_DB = configuredOr(values.POSTGRES_DB, "prism");
  values.POSTGRES_HOST = "localhost";
  values.POSTGRES_PORT = configuredOr(values.POSTGRES_PORT, "5432");
  values.PRISM_PUBLIC_BASE_URL = publicBaseUrl;
  values.SLACK_OAUTH_REDIRECT_URI = new URL("/v1/slack/oauth/callback", `${publicBaseUrl}/`).toString();
  values.PRISM_OIDC_ALLOW_INSECURE_HTTP = publicBaseUrl.startsWith("http:") ? "1" : "0";
  values.PRISM_OIDC_PLAYTEST_CLIENT_ID = configuredOr(
    values.PRISM_OIDC_PLAYTEST_CLIENT_ID,
    "shg-playtest",
  );
  values.PRISM_OIDC_PLAYTEST_REDIRECT_URI = playtestCallback;
  values.PRISM_CREDENTIAL_ENCRYPTION_KEY = generatedValue(
    values.PRISM_CREDENTIAL_ENCRYPTION_KEY,
    () => randomBytes(32).toString("base64"),
    rotate,
  );
  values.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID = generatedId(
    values.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID,
    "aes-gcm",
    rotate,
  );
  values.PRISM_DEVELOPER_TOKEN_PEPPER = generatedValue(
    values.PRISM_DEVELOPER_TOKEN_PEPPER,
    () => randomBytes(32).toString("base64url"),
    rotate,
  );
  values.PRISM_DEVELOPER_TOKEN_PEPPER_ID = generatedId(
    values.PRISM_DEVELOPER_TOKEN_PEPPER_ID,
    "developer-pepper",
    rotate,
  );

  if (rotate || !isConfigured(values.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64)) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    values.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64 = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "utf8",
    ).toString("base64");
  }
  values.PRISM_OIDC_SIGNING_KEY_ID = generatedId(
    values.PRISM_OIDC_SIGNING_KEY_ID,
    "oidc-rs256",
    rotate,
  );

  for (const key of MANAGED_ENV_KEYS) {
    const value = values[key];
    if (isConfigured(value) || requiredEvenWhenZero(key)) text = setEnvValue(text, key, value);
  }
  writeFileSync(envPath, ensureFinalNewline(text), { encoding: "utf8", mode: 0o600 });

  const status = inspectBootstrapConfig({ envPath });
  if (!status.configured) {
    throw new Error(`Prism setup could not complete: ${status.missing.join(", ")}`);
  }

  output.log("");
  output.log(`Configuration saved to ${envPath}.`);
  output.log("Slack apps and workspace connections remain managed in Prism's web setup.");
  output.log("");

  const selection = await askRunSelection(prompt, output);
  prompt.close?.();
  return { selection, envPath };
}

export async function main() {
  try {
    const result = await runSetupWizard();
    if (result.selection === "none") {
      console.log("Prism is configured. Start it later with `npm start` or `docker compose --env-file .env.local up -d`.");
      return 0;
    }

    const startup = await import("./start-local.mjs");
    if (result.selection === "docker") {
      await startup.startDockerPrism();
    } else {
      await startup.startLocalPrism({ setupIfMissing: false });
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Prism setup failed.");
    return 1;
  }
}

function createTerminalPrompt() {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    ask: (question) => readline.question(question),
    close: () => readline.close(),
  };
}

async function askUrl(prompt, { label, current, originOnly, output }) {
  while (true) {
    const answer = (await prompt.ask(`${label} [${current}]: `)).trim() || current;
    try {
      const url = new URL(answer);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (originOnly ? url.pathname !== "/" : url.pathname === "/")
      ) {
        throw new Error("invalid");
      }
      return originOnly ? url.origin : url.toString();
    } catch {
      output.log(originOnly ? "Enter an HTTP(S) origin without a path." : "Enter a complete HTTP(S) callback URL.");
    }
  }
}

async function askYesNo(prompt, label, defaultValue) {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await prompt.ask(`${label} ${suffix}: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

async function askRunSelection(prompt, output) {
  output.log("How would you like to continue?");
  output.log("  1. Run on this host");
  output.log("  2. Run with Docker in the background (HTTPS public URL required)");
  output.log("  3. Not now");
  while (true) {
    const answer = (await prompt.ask("Choose [1]: ")).trim() || "1";
    if (answer === "1") return "host";
    if (answer === "2") return "docker";
    if (answer === "3") return "none";
    output.log("Choose 1, 2, or 3.");
  }
}

function setEnvValue(text, key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid multiline value for ${key}.`);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^${escaped}=.*$`, "m");
  const line = `${key}=${value}`;
  if (expression.test(text)) return text.replace(expression, line);
  return `${text.replace(/\s*$/, "\n")}${line}\n`;
}

function configuredOr(value, fallback) {
  return isConfigured(value) ? value : fallback;
}

function isConfigured(value) {
  return Boolean(value && !value.includes("replace-with"));
}

function secretValue(value, bytes, rotate) {
  return generatedValue(value, () => randomBytes(bytes).toString("base64url"), rotate);
}

function generatedValue(value, generate, rotate) {
  return rotate || !isConfigured(value) ? generate() : value;
}

function generatedId(value, purpose, rotate) {
  return generatedValue(value, () => `prism-${purpose}-${Date.now().toString(36)}`, rotate);
}

function requiredEvenWhenZero(key) {
  return key === "PRISM_OIDC_ALLOW_INSECURE_HTTP";
}

function stripMatchingQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function ensureFinalNewline(text) {
  return `${text.replace(/\s*$/, "")}\n`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
