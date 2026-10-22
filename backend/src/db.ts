import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from './config';

let pool: Pool = createDefaultPool();

function createDefaultPool(): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}

export function getPool(): Pool {
  return pool;
}

/** Test hook: swap in an in-memory pool (pg-mem) without touching app code. */
export function setPoolForTests(testPool: Pool): void {
  pool = testPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
