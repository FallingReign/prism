import "server-only";

import { Pool, type QueryResultRow } from "pg";

import { getServerConfig } from "./config";

let pool: Pool | undefined;

export type QueryResult<Row = unknown> = {
  rows: Row[];
  rowCount: number | null;
};

export type Database = {
  query: <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<Row>>;
};

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

export const database: Database = {
  async query<Row extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    return getPool().query<Row>(sql, params);
  }
};
