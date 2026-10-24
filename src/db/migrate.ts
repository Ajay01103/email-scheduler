import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  // Serialize concurrent deployment migrations on one connection.
  await client.query('select pg_advisory_lock(864209311)');
  await migrate(drizzle({ client }), { migrationsFolder: './drizzle' });
  console.log('Database migrations applied');
} finally {
  await client.query('select pg_advisory_unlock(864209311)').catch(() => undefined);
  client.release();
  await pool.end();
}
