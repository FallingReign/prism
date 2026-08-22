import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function parseBootstrapArguments(args) {
  if (args.length === 0) return { recovery: false };
  if (args.length === 1 && args[0] === "--recover") return { recovery: true };
  throw new Error("setup_bootstrap_usage");
}

export function formatBootstrapSuccess({ code, expiresAt, recovery }) {
  const heading = recovery
    ? "Prism recovery setup code (shown once):"
    : "Prism setup code (shown once):";
  return [
    heading,
    code,
    `Expires at ${expiresAt.toISOString()}.`,
    "Open /setup in Prism and enter this code. Do not put it in a URL or share it in chat."
  ];
}

export async function main(args = process.argv.slice(2), output = console) {
  let options;
  try {
    options = parseBootstrapArguments(args);
  } catch {
    output.error("Usage: npm run setup:bootstrap -- [--recover]");
    return 2;
  }

  loadEnvFile(".env.local");
  loadEnvFile(".env.example");

  const [credentials, db, bootstrap, postgresStore] = await Promise.all([
    import("../src/server/credentials/factory.ts"),
    import("../src/server/db.ts"),
    import("../src/server/setup/bootstrap.ts"),
    import("../src/server/setup/bootstrap-postgres-store.ts")
  ]);

  try {
    // Bootstrap records live in Postgres, but the database must never become
    // the root of trust for the client secret it will later hold.
    credentials.createConfiguredCredentialCipher();
    const service = bootstrap.createSetupBootstrapService(
      postgresStore.createPostgresSetupBootstrapStore(db.database)
    );
    const result = await service.mintCapability({ recovery: options.recovery });
    for (const line of formatBootstrapSuccess(result)) output.log(line);
    return 0;
  } catch (error) {
    if (error instanceof bootstrap.SetupBootstrapRecoveryRequiredError) {
      output.error(
        "Slack configuration is already claimed. Use --recover only as an explicit host-level break-glass action."
      );
    } else {
      output.error("Prism could not mint a setup code. Confirm the database is migrated and the root credential key is configured.");
    }
    return 1;
  } finally {
    await db.closeDatabasePool();
  }
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = stripMatchingQuotes(rawValue);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
