import pg from "pg";

export interface Database {
  query<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export function createDatabase(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idleTimeoutMillis: 30000,
  });
}
