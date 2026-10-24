import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config, logger } from './config.js';
import { endpointAddress, errorDetails } from './dependency-errors.js';
import { pool } from './db/client.js';
import { createDeliveryProcessor } from './delivery.js';
import { runOutbox } from './outbox.js';
import { emailQueue, QUEUE_NAME, queueRedis, type EmailJob } from './queue.js';
import { SendGate } from './rate-limit.js';
import { ensureSearchIndex, searchClient } from './search.js';

const workerRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
workerRedis.on('error', (error) => logger.error({ ...errorDetails(error), endpoint: endpointAddress(config.REDIS_URL) }, 'Worker Redis connection error'));
const abort = new AbortController();
let worker: Worker<EmailJob> | undefined;
let outboxLoop: Promise<void> | undefined;
let stopping = false;

async function stop(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    logger.error('Worker shutdown deadline exceeded; in-flight SMTP requires review');
    process.exit(1);
  }, 90000);
  deadline.unref();
  abort.abort();
  try {
    await Promise.all([worker?.close(), outboxLoop]);
    await emailQueue.close();
    await Promise.all([workerRedis.quit(), queueRedis.quit(), pool.end(), searchClient.close()]);
    clearTimeout(deadline);
    process.exit(exitCode);
  } catch {
    logger.error('Worker shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM', () => { void stop(0); });
process.once('SIGINT', () => { void stop(0); });

async function main(): Promise<void> {
  await pool.query('select 1');
  await workerRedis.ping();
  try { await ensureSearchIndex(); } catch {
    logger.warn('Search unavailable at startup; indexing will retry through the outbox');
  }
  if (stopping) return;
  const gate = new SendGate(workerRedis, {
    hourlyLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    intervalMs: config.MIN_SEND_INTERVAL_MS,
    leaseMs: config.SEND_LEASE_MS,
  });
  worker = new Worker<EmailJob>(QUEUE_NAME, createDeliveryProcessor(gate), {
    connection: workerRedis,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: config.SEND_LEASE_MS,
    maxStalledCount: 2,
  });
  worker.on('error', (error) => logger.error(errorDetails(error), 'BullMQ worker error'));
  worker.on('failed', (job) => logger.warn({ jobId: job?.id }, 'Queue attempt failed; database state retained'));
  worker.on('stalled', (jobId) => logger.warn({ jobId }, 'Stalled queue job detected'));
  outboxLoop = runOutbox(abort.signal);
  logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'Email worker started');
}
void main().catch((error) => {
  logger.error(errorDetails(error), 'Worker startup failed');
  void stop(1);
});
