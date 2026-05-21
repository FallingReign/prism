import "server-only";

import { Pool } from "pg";

import { getServerConfig } from "./config";

let pool: Pool | undefined;

function getPool(): Pool {
  const { databaseUrl } = getServerConfig();

  if (!databaseUrl) {
    throw new Error("database-unconfigured");
  }

  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl });
    pool.on("error", () => {
      // Keep idle client failures from surfacing secrets through unhandled errors.
    });
  }

  return pool;
}

export const database = {
  async query(sql: string): Promise<unknown> {
    return getPool().query(sql);
  }
};
