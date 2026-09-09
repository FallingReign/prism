import type { QueryResultRow } from "pg";
import { vi, type Mock } from "vitest";

import type { Database, QueryResult } from "../src/server/db";

export type TestQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>;
export type TestDatabase = Database & {
  query: Mock<Database["query"]>;
  transaction: Mock<Database["transaction"]>;
};

/** Keep the row-type adaptation at the same boundary as PostgreSQL's query API. */
export function createTestDatabase(resolveQuery: TestQuery): TestDatabase {
  const query: Database["query"] = async <Row extends QueryResultRow>(sql: string, params?: unknown[]) => {
    const result = await resolveQuery(sql, params);
    return result as QueryResult<Row>;
  };
  const transaction: Database["transaction"] = async (callback) => callback(database);
  // Vitest's Mock return type erases generic call signatures. The implementations
  // above retain Database's generic contract; restore that contract only here.
  const database: TestDatabase = {
    query: vi.fn(query) as TestDatabase["query"],
    transaction: vi.fn(transaction) as TestDatabase["transaction"]
  };
  return database;
}
