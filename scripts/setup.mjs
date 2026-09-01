#!/usr/bin/env node
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve } from "node:path";
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
  "PRISM_DELEGATED_SLACK_DELIVERY_ENABLED",
  "PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID",
  "PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI",
  "PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS",
  "PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER",
  "PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID",
  "PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP",
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
  const templateText = existsSync(examplePath)
    ? readFileSync(examplePath, "utf8")
    : "";
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
    current: configuredOr(
      values.PRISM_PUBLIC_BASE_URL,
      "http://localhost:3732",
    ),
    originOnly: true,
    output,
  });
  const defaultPlaytestCallback = "http://localhost:3847/api/auth/callback";
  const playtestCallback = await askUrl(prompt, {
    label: "Playtest login callback URL",
    current: configuredOr(
      values.PRISM_OIDC_PLAYTEST_REDIRECT_URI,
      defaultPlaytestCallback,
    ),
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
  const delegationAlreadyConfigured =
    values.PRISM_DELEGATED_SLACK_DELIVERY_ENABLED === "1" &&
    isConfigured(values.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS) &&
    isConfigured(values.PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI);
  const configureDelegation = await askYesNo(
    prompt,
    "Enable delegated Slack-message authorization for a registered application?",
    delegationAlreadyConfigured,
  );
  let delegationRegistration = null;
  if (configureDelegation) {
    const replaceRegistration = delegationAlreadyConfigured
      ? await askYesNo(
          prompt,
          "Replace the existing delegated client registration?",
          false,
        )
      : true;
    if (replaceRegistration) {
      while (!delegationRegistration) {
        const code = (
          await prompt.ask(
            "Paste the delegated client registration code: ",
          )
        ).trim();
        try {
          delegationRegistration =
            parseDelegatedDeliveryRegistrationCode(code);
        } catch {
          output.log(
            "That registration code is invalid. Generate a new code in the requesting application and try again.",
          );
        }
      }
    }
  }

  values.POSTGRES_USER = configuredOr(values.POSTGRES_USER, "prism");
  values.POSTGRES_PASSWORD = secretValue(values.POSTGRES_PASSWORD, 24, rotate);
  values.POSTGRES_DB = configuredOr(values.POSTGRES_DB, "prism");
  values.POSTGRES_HOST = "localhost";
  values.POSTGRES_PORT = configuredOr(values.POSTGRES_PORT, "5432");
  values.PRISM_PUBLIC_BASE_URL = publicBaseUrl;
  values.SLACK_OAUTH_REDIRECT_URI = new URL(
    "/v1/slack/oauth/callback",
    `${publicBaseUrl}/`,
  ).toString();
  values.PRISM_OIDC_ALLOW_INSECURE_HTTP = publicBaseUrl.startsWith("http:")
    ? "1"
    : "0";
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
  values.PRISM_DELEGATED_SLACK_DELIVERY_ENABLED = configureDelegation
    ? "1"
    : "0";
  if (configureDelegation) {
    if (delegationRegistration) {
      values.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID =
        delegationRegistration.client_id;
      values.PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI =
        delegationRegistration.callback_uri;
      values.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS = JSON.stringify(
        delegationRegistration.jwks,
      );
    }
    values.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER = generatedValue(
      values.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER,
      () => randomBytes(32).toString("base64url"),
      rotate,
    );
    values.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID = generatedId(
      values.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID,
      "delegated-grants",
      rotate,
    );
    values.PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP =
      values.PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI?.startsWith("http:") ||
      publicBaseUrl.startsWith("http:")
        ? "1"
        : "0";
  }

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

  const managedValues = Object.fromEntries(
    MANAGED_ENV_KEYS.flatMap((key) => {
      const value = values[key];
      return isConfigured(value) || requiredEvenWhenZero(key)
        ? [[key, value]]
        : [];
    }),
  );
  text = updateManagedEnvValues(text, managedValues);
  writeEnvFileAtomically(envPath, text);

  const status = inspectBootstrapConfig({ envPath });
  if (!status.configured) {
    throw new Error(
      `Prism setup could not complete: ${status.missing.join(", ")}`,
    );
  }

  output.log("");
  output.log(`Configuration saved to ${envPath}.`);
  output.log(
    "Slack apps and workspace connections remain managed in Prism's web setup.",
  );
  output.log(
    configureDelegation
      ? "Delegated Slack-message authorization is registered."
      : "Delegated Slack-message authorization remains disabled.",
  );
  output.log("");

  const selection = await askRunSelection(prompt, output, publicBaseUrl);
  prompt.close?.();
  return { selection, envPath };
}

export async function main() {
  try {
    const result = await runSetupWizard();
    if (result.selection === "none") {
      console.log(
        "Prism is configured. Start it later with `npm start` or `docker compose --env-file .env.local up -d`.",
      );
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
    console.error(
      error instanceof Error ? error.message : "Prism setup failed.",
    );
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
    const answer =
      (await prompt.ask(`${label} [${current}]: `)).trim() || current;
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
      if (
        url.protocol === "http:" &&
        !isAllowedInsecureHttpHost(url.hostname)
      ) {
        output.log(
          "HTTP is allowed only for localhost, private-network, or link-local addresses. Use HTTPS for public hosts.",
        );
        continue;
      }
      return originOnly ? url.origin : url.toString();
    } catch {
      output.log(
        originOnly
          ? "Enter an HTTP(S) origin without a path."
          : "Enter a complete HTTP(S) callback URL.",
      );
    }
  }
}

async function askYesNo(prompt, label, defaultValue) {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await prompt.ask(`${label} ${suffix}: `))
      .trim()
      .toLowerCase();
    if (!answer) return defaultValue;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

async function askRunSelection(prompt, output, publicBaseUrl) {
  output.log("How would you like to continue?");
  output.log("  1. Run on this host");
  output.log("  2. Run with Docker in the background");
  output.log("  3. Not now");
  while (true) {
    const answer = (await prompt.ask("Choose [1]: ")).trim() || "1";
    if (answer === "1") return "host";
    if (answer === "2") return "docker";
    if (answer === "3") return "none";
    output.log("Choose 1, 2, or 3.");
  }
}

export function updateManagedEnvValues(text, managedValues) {
  for (const [key, value] of Object.entries(managedValues)) {
    if (/[\r\n]/.test(value))
      throw new Error(`Invalid multiline value for ${key}.`);
  }

  const managedKeys = new Set(Object.keys(managedValues));
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  const output = [];

  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (!key || !managedKeys.has(key)) {
      output.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(`${key}=${managedValues[key]}`);
  }

  if (output.at(-1) === "") output.pop();
  for (const [key, value] of Object.entries(managedValues)) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  return `${output.join("\n")}\n`;
}

export function writeEnvFileAtomically(
  envPath,
  text,
  {
    write = writeFileSync,
    rename = renameSync,
    remove = rmSync,
    chmod = chmodSync,
  } = {},
) {
  const temporaryPath = join(
    dirname(envPath),
    `.${basename(envPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    write(temporaryPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      chmod(temporaryPath, 0o600);
    } catch {
      // Windows and some mounted filesystems do not expose POSIX modes.
    }
    rename(temporaryPath, envPath);
    try {
      chmod(envPath, 0o600);
    } catch {
      // Best effort only when the host filesystem does not expose POSIX modes.
    }
  } finally {
    try {
      remove(temporaryPath, { force: true });
    } catch {
      // The successful rename already moved the temporary file into place.
    }
  }
}

function configuredOr(value, fallback) {
  return isConfigured(value) ? value : fallback;
}

function isConfigured(value) {
  return Boolean(value && !value.includes("replace-with"));
}

function secretValue(value, bytes, rotate) {
  return generatedValue(
    value,
    () => randomBytes(bytes).toString("base64url"),
    rotate,
  );
}

function generatedValue(value, generate, rotate) {
  return rotate || !isConfigured(value) ? generate() : value;
}

function generatedId(value, purpose, rotate) {
  return generatedValue(
    value,
    () => `prism-${purpose}-${Date.now().toString(36)}`,
    rotate,
  );
}

function requiredEvenWhenZero(key) {
  return (
    key === "PRISM_OIDC_ALLOW_INSECURE_HTTP" ||
    key === "PRISM_DELEGATED_SLACK_DELIVERY_ENABLED"
  );
}

export function parseDelegatedDeliveryRegistrationCode(code) {
  if (!/^[A-Za-z0-9_-]{32,16384}$/.test(code))
    throw new Error("invalid registration");
  let candidate;
  try {
    candidate = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid registration");
  }
  if (
    candidate?.version !== 1 ||
    !/^[A-Za-z0-9._~-]{1,128}$/.test(candidate?.client_id || "") ||
    !candidate?.callback_uri ||
    !isPlainRecord(candidate?.jwks) ||
    Object.keys(candidate.jwks).length !== 1 ||
    !Array.isArray(candidate.jwks.keys) ||
    candidate.jwks.keys.length < 1 ||
    candidate.jwks.keys.length > 5
  ) {
    throw new Error("invalid registration");
  }
  const keyIds = new Set();
  for (const key of candidate.jwks.keys) {
    validateDelegatedRegistrationJwk(key);
    if (keyIds.has(key.kid)) throw new Error("invalid registration");
    keyIds.add(key.kid);
  }
  let callback;
  try {
    callback = new URL(candidate.callback_uri);
  } catch {
    throw new Error("invalid registration");
  }
  if (
    !["http:", "https:"].includes(callback.protocol) ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    (callback.protocol === "http:" &&
      !isAllowedInsecureHttpHost(callback.hostname))
  ) {
    throw new Error("invalid registration");
  }
  return candidate;
}

function validateDelegatedRegistrationJwk(key) {
  const allowedFields = new Set([
    "kty",
    "crv",
    "alg",
    "kid",
    "x",
    "y",
    "use",
    "key_ops",
  ]);
  if (
    !isPlainRecord(key) ||
    Object.keys(key).some((field) => !allowedFields.has(field)) ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    key.alg !== "ES256" ||
    !/^[A-Za-z0-9._~-]{1,128}$/.test(key.kid || "") ||
    !isP256Coordinate(key.x) ||
    !isP256Coordinate(key.y) ||
    (key.use !== undefined && key.use !== "sig") ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) ||
        key.key_ops.length !== 1 ||
        key.key_ops[0] !== "verify"))
  ) {
    throw new Error("invalid registration");
  }
  try {
    createPublicKey({
      key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      format: "jwk",
    });
  } catch {
    throw new Error("invalid registration");
  }
}

function isP256Coordinate(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, "base64url").byteLength === 32
  );
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

export function isAllowedInsecureHttpHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  if (normalized.includes(":")) {
    const first = Number.parseInt(normalized.split(":", 1)[0], 16);
    return (
      (Number.isInteger(first) && first >= 0xfc00 && first <= 0xfdff) ||
      (Number.isInteger(first) && first >= 0xfe80 && first <= 0xfebf)
    );
  }

  const octets = normalized.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
