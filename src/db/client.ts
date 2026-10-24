import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config, logger } from '../config.js';


export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 30_000,
});

pool.on('error', () => {
  logger.error('Unexpected idle PostgreSQL connection error');
});

export const db = drizzle({ client: pool });
