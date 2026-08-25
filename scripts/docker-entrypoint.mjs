#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { Client } from "pg";
import { missingBootstrapConfiguration } from "./bootstrap-config.mjs";

const DB_WAIT_ATTEMPTS = Number(process.env.DB_WAIT_ATTEMPTS ?? 60);
const DB_WAIT_MS = Number(process.env.DB_WAIT_MS ?? 1000);

function getDbConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5432,
    user: process.env.POSTGRES_USER ?? "prism",
    password: process.env.POSTGRES_PASSWORD ?? "prism_local_password",
    database: process.env.POSTGRES_DB ?? "prism",
  };
}

function assertRequiredEnv() {
  const missing = missingBootstrapConfiguration(process.env);
  if (missing.length > 0) {
    throw new Error(
      `Prism bootstrap configuration is incomplete: ${missing.join(", ")}. Run npm run setup on the host, then run docker compose up -d again.`,
    );
  }
}

async function waitForDb() {
  const cfg = getDbConfig();
  for (let i = 0; i < DB_WAIT_ATTEMPTS; i++) {
    try {
      const client = new Client(cfg);
      await client.connect();
      await client.end();
      console.log("Database is ready.");
      return;
    } catch (err) {
      const remaining = DB_WAIT_ATTEMPTS - i - 1;
      console.log(`Database not ready yet, retrying... (${remaining} attempts left)`);
      await wait(DB_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for database.");
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit", shell: false, env: process.env, ...opts });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main() {
  try {
    assertRequiredEnv();
    await waitForDb();

    const MAX_MIGRATE_ATTEMPTS = 5;
    for (let i = 0; i < MAX_MIGRATE_ATTEMPTS; i++) {
      try {
        console.log(`Running migrations (attempt ${i + 1}/${MAX_MIGRATE_ATTEMPTS})`);
        await runCommand("npm", ["run", "db:migrate"]);
        console.log("Migrations completed successfully.");
        break;
      } catch (err) {
        if (i === MAX_MIGRATE_ATTEMPTS - 1) throw err;
        console.error("Migrations failed, retrying in 2s:", err.message || err);
        await wait(2000);
      }
    }

    console.log("Starting server...");
    const server = spawn("npm", ["run", "start:web"], { stdio: "inherit", env: process.env });
    server.on("exit", (code) => process.exit(code ?? 0));
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const s of signals) process.on(s, () => server.kill(s));
  } catch (err) {
    console.error("Entrypoint failed:", err);
    process.exit(1);
  }
}

main();
