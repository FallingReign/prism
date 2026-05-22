import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env.example");

if (!configuredValue(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL = databaseUrlFromEnv(process.env);
}

if (!process.env.DATABASE_URL) {
  console.error("Database configuration is required for migrations.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const migrationsDir = "db/migrations";
const files = readdirSync(migrationsDir).filter((file) => /^\d+.*\.sql$/.test(file)).sort();

let client;

try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (applied.rowCount) continue;
    await client.query(readFileSync(join(migrationsDir, file), "utf8"));
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
  }
  await client.query("COMMIT");
  console.log("Migrations applied.");
} catch (error) {
  if (client) await client.query("ROLLBACK");
  console.error("Migration failed: database_unavailable.");
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}

function databaseUrlFromEnv(env) {
  const user = configuredValue(env.POSTGRES_USER);
  const password = configuredValue(env.POSTGRES_PASSWORD);
  const database = configuredValue(env.POSTGRES_DB);
  if (!user || !password || !database) return undefined;

  const host = configuredValue(env.POSTGRES_HOST) ?? "localhost";
  const port = configuredValue(env.POSTGRES_PORT) ?? "5432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function configuredValue(value) {
  if (!value || value.includes("replace-with")) return undefined;
  return value;
}
