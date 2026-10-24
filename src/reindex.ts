import { pool } from './db/client.js';
import { logger } from './config.js';
import { reindexAllEmails, searchClient } from './search.js';

try {
  await reindexAllEmails();
} catch {
  logger.error('Reindex failed; rerun after restoring search connectivity');
  process.exitCode = 1;
} finally {
  await Promise.all([pool.end(), searchClient.close()]);
}
