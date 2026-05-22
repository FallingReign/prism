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
  transaction: <T>(callback: (database: Database) => Promise<T>) => Promise<T>;
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
  },
  async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    const transactionalDatabase: Database = {
      async query<Row extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
        return client.query<Row>(sql, params);
      },
      async transaction<Nested>(nested: (database: Database) => Promise<Nested>): Promise<Nested> {
        return nested(transactionalDatabase);
      }
    };
    try {
      await client.query("BEGIN");
      const result = await callback(transactionalDatabase);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
};
