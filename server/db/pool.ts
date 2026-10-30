import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let realPool: pg.Pool | null = null;

export interface DbConnectionStatus {
  connected: boolean;
  configured: boolean;
  database?: string;
  version?: string;
  error?: string;
  tablesCount?: number;
  tablesReady?: boolean;
  ping?: number;
}

export function getPool(): pg.Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '' || databaseUrl.includes('username:password')) {
    throw new Error('DATABASE_URL environment variable is not configured or contains placeholder credentials.');
  }

  if (!realPool) {
    const isNeonOrSsl = databaseUrl.includes('neon.tech') || databaseUrl.includes('sslmode=') || process.env.NODE_ENV === 'production';
    
    realPool = new Pool({
      connectionString: databaseUrl,
      ssl: isNeonOrSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    realPool.on('error', (err) => {
      console.error('[PostgreSQL Pool Client Error]:', err.message);
    });
  }

  return realPool;
}

/**
 * Execute a SQL query directly against the Neon PostgreSQL database.
 * No in-memory mock fallback is executed on error or disconnection.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  return await pool.query<T>(text, params);
}

/**
 * Verify Neon PostgreSQL health by executing a real 'SELECT 1' query,
 * checking the server version, current database name, and public tables.
 */
export async function checkDbConnection(): Promise<DbConnectionStatus> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '' || databaseUrl.includes('username:password')) {
    return {
      connected: false,
      configured: false,
      error: 'DATABASE_URL is not set or contains placeholder credentials.',
      tablesCount: 0,
      tablesReady: false,
    };
  }

  try {
    const pool = getPool();
    const pingRes = await pool.query<{
      ping: number;
      database_name: string;
      server_version: string;
    }>(
      "SELECT 1 as ping, current_database() as database_name, current_setting('server_version') as server_version"
    );

    const tableRes = await pool.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const tablesCount = parseInt(tableRes.rows[0]?.count || '0', 10);

    return {
      connected: true,
      configured: true,
      database: pingRes.rows[0]?.database_name,
      version: pingRes.rows[0]?.server_version,
      tablesCount,
      tablesReady: tablesCount >= 4,
      ping: pingRes.rows[0]?.ping,
    };
  } catch (err: any) {
    console.error('[PostgreSQL Connection Health Error]:', err.message);
    return {
      connected: false,
      configured: true,
      error: `Neon database connection failed: ${err.message}`,
      tablesCount: 0,
      tablesReady: false,
    };
  }
}

/**
 * Explicit helper for isolated tests only.
 * Production runtime must NEVER invoke mock store or executeMockQuery.
 */
export { executeMockQuery } from './mock_query.js';
export { mockStore } from './mock_store.js';
