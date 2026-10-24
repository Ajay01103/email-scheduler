import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { deliveryMetrics, summarize } from './metrics.js';

const integer = (fallback: number, maximum = 100000) => z.coerce.number().int().min(1).max(maximum).default(fallback);
const settings = z.object({
  DATABASE_URL: z.url(), REDIS_URL: z.url(), API_KEY: z.string().min(32),
  STRESS_API_URL: z.url().default('http://localhost:3000'),
  MAILPIT_URL: z.url().optional(), MAILPIT_UI_PORT: integer(8025, 65535),
  STRESS_COUNT: integer(300, 10000), STRESS_SENDERS: integer(5, 100),
  STRESS_CONCURRENCY: integer(10, 100),
  STRESS_API_RPS: z.coerce.number().positive().max(1000).default(3),
  STRESS_TIMEOUT_MS: integer(900000, 7200000),
  STRESS_POLL_MS: integer(5000, 60000),
  STRESS_LEAD_MS: integer(2000, 3600000),
  STRESS_SPREAD_MS: z.coerce.number().int().min(0).max(3600000).default(30000),
  STRESS_REPLAY_EVERY: integer(10, 10000),
  STRESS_ALLOW_HOURLY_DELAY: z.enum(['0', '1']).default('0'),
  MAX_EMAILS_PER_HOUR_PER_SENDER: integer(200),
  MIN_SEND_INTERVAL_MS: integer(1000), WORKER_CONCURRENCY: integer(8, 10000),
}).parse(process.env);
const apiUrl = settings.STRESS_API_URL.replace(/\/$/, '');
const mailpitUrl = (settings.MAILPIT_URL ?? `http://localhost:${settings.MAILPIT_UI_PORT}`).replace(/\/$/, '');
if (Math.ceil(settings.STRESS_COUNT / settings.STRESS_SENDERS) > settings.MAX_EMAILS_PER_HOUR_PER_SENDER
  && settings.STRESS_ALLOW_HOURLY_DELAY !== '1') {
  throw new Error('This run exceeds the declared sender hourly quota. Increase STRESS_SENDERS or explicitly set STRESS_ALLOW_HOURLY_DELAY=1 and allow enough time.');
}

const runId = `stress${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(new Error('Stress run deadline exceeded')), settings.STRESS_TIMEOUT_MS);
const interrupt = () => abort.abort(new Error('Stress run interrupted; accepted emails remain scheduled'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const pool = new pg.Pool({ connectionString: settings.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
pool.on('error', () => console.error('[stress] PostgreSQL pool error'));
const startedAt = new Date();
const wallStart = performance.now();
const emailIds: string[] = [];
const senderIds: string[] = [];
const apiLatencies: number[] = [];
const scheduleLatencies: number[] = [];
let apiRequests = 0;
let rateLimited = 0;
let networkRetries = 0;
let replayed = 0;
let apiFailures = 0;
let peakBacklog = 0;
let nextAdmission = 0;
let producing = true;
let failure: string | undefined;
let rows: EmailRow[] = [];
let captured: MailpitMessage[] = [];
let producerFinishedMs = 0;
let pending: Promise<unknown>[] = [];
let detectedWorkers = 0;

interface EmailRow {
  id: string; status: string; attempts: number; generation: number;
  scheduledAt: Date; sentAt: Date | null;
}
interface MailpitMessage { ID: string; MessageID: string; Subject: string; Created: string; Size: number }

async function paced(): Promise<void> {
  // Reserve before awaiting: concurrent producers share a single admission clock.
  const at = Math.max(Date.now(), nextAdmission);
  nextAdmission = at + 1000 / settings.STRESS_API_RPS;
  await sleep(Math.max(0, at - Date.now()), undefined, { signal: abort.signal });
}

async function request<T>(path: string, body?: unknown, idempotencyKey?: string, scheduledDelayMs?: number): Promise<{ body: T; status: number }> {
  let safeToAdjustSchedule = true;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await paced();
    if (scheduledDelayMs !== undefined && safeToAdjustSchedule) {
      (body as { scheduledAt: string }).scheduledAt = new Date(Date.now() + scheduledDelayMs).toISOString();
    }
    const requestStart = performance.now();
    let response: Response;
    try {
      apiRequests += 1;
      response = await fetch(`${apiUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-API-Key': settings.API_KEY, 'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      });
    } catch (error) {
      if (abort.signal.aborted) throw error;
      safeToAdjustSchedule = false;
      // Only scheduling requests are safe to replay after a lost response.
      if (!idempotencyKey || attempt >= 3) throw new Error(`API connection failed for ${path}`);
      networkRetries += 1;
      await sleep(1000 * (attempt + 1), undefined, { signal: abort.signal });
      continue;
    }
    apiLatencies.push(performance.now() - requestStart);
    if (response.status === 429) {
      rateLimited += 1;
      const retrySeconds = Number(response.headers.get('Retry-After') ?? '60');
      const pause = Number.isFinite(retrySeconds) ? Math.max(1000, retrySeconds * 1000 + 250) : 60250;
      nextAdmission = Math.max(nextAdmission, Date.now() + pause);
      await response.arrayBuffer();
      continue;
    }
    safeToAdjustSchedule = false;
    if (response.status >= 500 && idempotencyKey && attempt < 3) {
      networkRetries += 1;
      await response.arrayBuffer();
      await sleep(1000 * (attempt + 1), undefined, { signal: abort.signal });
      continue;
    }
    if (!response.ok) {
      apiFailures += 1;
      await response.arrayBuffer();
      throw new Error(`API returned HTTP ${response.status} for ${path}`);
    }
    return { body: await response.json() as T, status: response.status };
  }
  apiFailures += 1;
  throw new Error(`API retry budget exhausted for ${path}`);
}

async function databaseRows(): Promise<EmailRow[]> {
  if (!emailIds.length) return [];
  const result = await pool.query<EmailRow>(`SELECT id, status, attempts, generation,
    scheduled_at AS "scheduledAt", sent_at AS "sentAt" FROM emails WHERE id = ANY($1::uuid[])`, [emailIds]);
  return result.rows;
}

async function mailpitMessages(): Promise<MailpitMessage[]> {
  const messages: MailpitMessage[] = [];
  for (let offset = 0; ; offset += 100) {
    const query = new URLSearchParams({ query: `subject:${runId}`, start: String(offset), limit: '100' });
    const response = await fetch(`${mailpitUrl}/api/v1/search?${query}`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error(`Mailpit search returned HTTP ${response.status}`);
    const page = await response.json() as { messages: MailpitMessage[] };
    if (!Array.isArray(page.messages)) throw new Error('Mailpit did not return a message list');
    messages.push(...page.messages);
    if (page.messages.length < 100) return messages;
  }
}

async function monitor(): Promise<void> {
  while (!abort.signal.aborted) {
    rows = await databaseRows();
    const counts = deliveryMetrics(rows);
    peakBacklog = Math.max(peakBacklog, counts.scheduled + counts.sending);
    console.log(`[stress] accepted=${emailIds.length}/${settings.STRESS_COUNT} sent=${counts.sent} scheduled=${counts.scheduled} sending=${counts.sending} failed=${counts.failed} uncertain=${counts.uncertain} API429=${rateLimited} elapsed=${Math.round((performance.now() - wallStart) / 1000)}s`);
    if (!producing && rows.length === emailIds.length
      && counts.sent + counts.failed + counts.uncertain === emailIds.length) return;
    await sleep(settings.STRESS_POLL_MS, undefined, { signal: abort.signal });
  }
  abort.signal.throwIfAborted();
}

function payload(index: number, senderId: string) {
  // Transactional notices, richer campaign HTML, and a few large payloads.
  const kind = index % 20;
  const size = kind === 0 ? 50000 : kind < 5 ? 8000 : 800;
  const text = `Mailpit-only workload ${runId}, message ${index}.\n${'Order status and account notification. '.repeat(Math.ceil(size / 39)).slice(0, size)}`;
  const extraDelay = kind === 0 ? settings.STRESS_SPREAD_MS : kind < 5 ? settings.STRESS_SPREAD_MS / 3 : 0;
  return {
    senderId, to: `recipient-${index}-${runId}@example.test`,
    subject: `${runId} message ${String(index).padStart(5, '0')} — ${kind < 5 ? 'campaign' : 'transactional'}`,
    text, html: `<html><body><h1>Scheduled notice ${index}</h1><p>${text}</p></body></html>`,
    scheduledAt: new Date(Date.now() + settings.STRESS_LEAD_MS + extraDelay).toISOString(),
  };
}

try {
  console.log(`[stress] Run ${runId}: ${settings.STRESS_COUNT} real messages, ${settings.STRESS_SENDERS} senders, ${settings.STRESS_CONCURRENCY} producers, target ${settings.STRESS_API_RPS} API req/s`);
  console.log(`[stress] Declared worker settings: concurrency=${settings.WORKER_CONCURRENCY}, gap=${settings.MIN_SEND_INTERVAL_MS}ms, sender quota=${settings.MAX_EMAILS_PER_HOUR_PER_SENDER}/UTC hour. Existing workers are not reconfigured.`);
  console.log(`[stress] Mailpit verification: ${mailpitUrl}. Accepted jobs and captured emails will be retained.`);
  const ready = await fetch(`${apiUrl}/health/ready`, { signal: AbortSignal.timeout(10000) });
  if (ready.status !== 200) throw new Error(`API is not ready (HTTP ${ready.status}); start API and worker first`);
  const info = await fetch(`${mailpitUrl}/api/v1/info`, { signal: AbortSignal.timeout(10000) });
  if (!info.ok) throw new Error(`Mailpit is not reachable (HTTP ${info.status})`);
  await pool.query('select 1');
  const redis = new Redis(settings.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
  redis.on('error', () => console.error('[stress] Redis preflight connection error'));
  const queue = new Queue('email-delivery', { connection: redis });
  queue.on('error', () => console.error('[stress] Queue preflight error'));
  try {
    detectedWorkers = (await queue.getWorkers()).length;
    if (!detectedWorkers) throw new Error('No BullMQ workers detected. Start pnpm dev:worker before running the stress test.');
    console.log(`[stress] Detected ${detectedWorkers} BullMQ worker connection(s).`);
  } finally {
    await queue.close();
    redis.disconnect();
  }
  for (let index = 0; index < settings.STRESS_SENDERS; index += 1) {
    const sender = await request<{ id: string }>('/v1/senders', {
      name: `Stress sender ${index}`, email: `sender-${index}-${runId}@example.test`,
    });
    senderIds.push(sender.body.id);
  }
  let nextIndex = 0;
  const producer = async () => {
    while (!abort.signal.aborted) {
      const index = nextIndex++;
      if (index >= settings.STRESS_COUNT) return;
      const input = payload(index, senderIds[index % senderIds.length]!);
      const key = `${runId}-${index}`;
      const begin = performance.now();
      const result = await request<{ id: string }>('/v1/emails', input, key,
        Math.max(settings.STRESS_LEAD_MS, Date.parse(input.scheduledAt) - Date.now()));
      emailIds.push(result.body.id);
      scheduleLatencies.push(performance.now() - begin);
      if (index % settings.STRESS_REPLAY_EVERY === 0) {
        const replay = await request<{ id: string }>('/v1/emails', input, key);
        if (replay.status !== 200 || replay.body.id !== result.body.id) throw new Error('Idempotency replay did not return the original email');
        replayed += 1;
      }
    }
  };
  const monitoring = monitor();
  // Attach handlers immediately: a monitoring failure must not leave background rejections.
  const producingWork = Promise.all(Array.from({ length: settings.STRESS_CONCURRENCY }, producer))
    .finally(() => { producing = false; producerFinishedMs = performance.now() - wallStart; });
  pending = [monitoring, producingWork];
  await Promise.all(pending);
  // Verify the SMTP sink independently, not just the service's database status.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    captured = await mailpitMessages();
    if (captured.length >= emailIds.length) break;
    await sleep(1000, undefined, { signal: abort.signal });
  }
} catch (error) {
  failure = abort.signal.aborted && abort.signal.reason instanceof Error
    ? abort.signal.reason.message : error instanceof Error ? error.message : 'Stress run failed';
  abort.abort();
  await Promise.allSettled(pending);
  console.error(`[stress] ${failure}`);
  try { rows = await databaseRows(); } catch { /* Keep the last successfully observed state. */ }
} finally {
  clearTimeout(timeout);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  const counts = deliveryMetrics(rows);
  const messageCounts = new Map<string, number>();
  for (const message of captured) {
    const id = message.MessageID.replace(/^<|>$/g, '');
    messageCounts.set(id, (messageCounts.get(id) ?? 0) + 1);
  }
  const expectedMessages = new Set(rows.map((row) => `${row.id}.${row.generation}`));
  const received = new Map<string, number>();
  for (const [id, count] of messageCounts) {
    const key = id.split('@')[0]!;
    received.set(key, (received.get(key) ?? 0) + count);
  }
  const missing = [...expectedMessages].filter((id) => !received.has(id));
  const duplicates = [...received].filter(([, count]) => count > 1).map(([messageId, count]) => ({ messageId, count }));
  const unexpectedMessages = [...received.keys()].filter((id) => !expectedMessages.has(id));
  const passed = !failure && emailIds.length === settings.STRESS_COUNT && counts.sent === settings.STRESS_COUNT
    && counts.failed === 0 && counts.uncertain === 0 && counts.earlyDeliveries === 0
    && missing.length === 0 && duplicates.length === 0 && unexpectedMessages.length === 0
    && captured.length === settings.STRESS_COUNT;
  const report = {
    runId, passed, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    durationSeconds: (performance.now() - wallStart) / 1000,
    producerDurationSeconds: producerFinishedMs / 1000,
    configuration: {
      count: settings.STRESS_COUNT, senders: settings.STRESS_SENDERS, producerConcurrency: settings.STRESS_CONCURRENCY,
      apiTargetRps: settings.STRESS_API_RPS, detectedWorkers, declaredWorkerConcurrency: settings.WORKER_CONCURRENCY,
      declaredMinimumGapMs: settings.MIN_SEND_INTERVAL_MS, declaredHourlyLimitPerSender: settings.MAX_EMAILS_PER_HOUR_PER_SENDER,
    },
    api: { requests: apiRequests, accepted: emailIds.length, idempotencyReplays: replayed, rateLimited, networkRetries, failures: apiFailures,
      requestLatencyMs: summarize(apiLatencies), scheduleEndToEndLatencyMs: summarize(scheduleLatencies) },
    delivery: { ...counts, peakObservedBacklog: peakBacklog },
    mailpit: { captured: captured.length, missingMessageIds: missing, duplicates, unexpectedMessageIds: unexpectedMessages,
      totalCapturedBytes: captured.reduce((sum, message) => sum + message.Size, 0) },
    failure, senderIds, emailIds,
    interpretation: 'Measured under existing worker/API rate limits, not an unlimited SMTP benchmark. SMTP acceptance is verified in Mailpit; no external provider was used if workers point to that Mailpit instance.',
  };
  await mkdir('stress-results', { recursive: true });
  const reportPath = `stress-results/${runId}.json`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[stress] ${passed ? 'PASS' : 'FAIL'} sent=${counts.sent}/${settings.STRESS_COUNT}, Mailpit=${captured.length}, duplicates=${duplicates.length}, missing=${missing.length}`);
  console.log(`[stress] Delivery throughput=${counts.throughputPerSecond.toFixed(3)}/s (${counts.throughputPerMinute.toFixed(1)}/min); schedule lag p95=${counts.lagMs.p95.toFixed(0)}ms; API p95=${summarize(apiLatencies).p95.toFixed(0)}ms`);
  console.log(`[stress] Report: ${reportPath}. Messages remain in Mailpit for inspection.`);
  if (!passed) process.exitCode = 1;
  await pool.end();
}
