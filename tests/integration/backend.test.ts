import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

type PublicEmail = {
  id: string;
  status: string;
  attempts: number;
  generation: number;
  sentAt: string | null;
};
type MailpitMessage = { ID: string; Subject: string };
type WorkerChild = {
  child: ChildProcess;
  logs: string;
  started: boolean;
  stopped: boolean;
  error?: Error;
  exited: Promise<void>;
};

test('backend survives worker restarts, queue loss, and uncertain delivery', {
  skip: process.env.RUN_INTEGRATION !== '1' ? 'Set RUN_INTEGRATION=1 to use real services' : false,
  timeout: 90_000,
}, async (t) => {
  // Import application modules only after defaults are set; parent-provided URLs win.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://emails:local-postgres-password@localhost:5432/emails';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.ELASTICSEARCH_URL ??= 'http://localhost:9200';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.MAILPIT_URL ??= 'http://localhost:8025';
  process.env.API_KEY ??= 'integration-api-key-at-least-32-characters';
  process.env.DASHBOARD_PASSWORD ??= 'integration-dashboard-password';

  const workers: WorkerChild[] = [];
  const emailIds = new Set<string>();
  const generations = new Map<string, Set<number>>();
  let senderId: string | undefined;
  let server: Server | undefined;
  let baseUrl = '';
  const token = randomUUID().replaceAll('-', '');
  const subjects = new Set<string>();
  const mailpitUrl = process.env.MAILPIT_URL.replace(/\/$/, '');

  const { app, shutdown } = await import('../../src/api.js');
  const { pool } = await import('../../src/db/client.js');
  const { emailQueue, emailJobId } = await import('../../src/queue.js');
  const { dispatchOne, reconcile } = await import('../../src/outbox.js');
  const { ensureSearchIndex, searchClient } = await import('../../src/search.js');
  const { config } = await import('../../src/config.js');

  function workerLogs(): string {
    return workers.map((worker, index) =>
      `Worker ${index + 1} (pid ${worker.child.pid ?? 'not spawned'}):\n${worker.logs}`).join('\n');
  }

  async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean,
    timeoutMs = 12_000, intervalMs = 500): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    do {
      t.signal.throwIfAborted();
      last = await read();
      if (ready(last)) return last;
      await sleep(intervalMs, undefined, { signal: t.signal });
    } while (Date.now() < deadline);
    assert.fail(`${label}; last value: ${JSON.stringify(last)}\n${workerLogs()}`);
  }

  async function startWorker(): Promise<WorkerChild> {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OUTBOX_POLL_MS: '100',
        RECONCILE_INTERVAL_MS: '300',
        MIN_SEND_INTERVAL_MS: '50',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const worker: WorkerChild = {
      child, logs: '', started: false, stopped: false, exited: Promise.resolve(),
    };
    worker.exited = new Promise<void>((resolve) => {
      child.once('close', () => { worker.stopped = true; resolve(); });
      child.once('error', (error) => { worker.error = error; });
    });
    const collect = (chunk: Buffer) => {
      const combined = worker.logs + chunk.toString('utf8');
      worker.started ||= combined.includes('Email worker started');
      worker.logs = combined.slice(-10_000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    workers.push(worker);
    await until('Worker did not start', async () => {
      assert.ifError(worker.error);
      assert.ok(!worker.stopped, `Worker exited during startup\n${worker.logs}`);
      return worker.started;
    }, Boolean, 12_000, 100);
    return worker;
  }

  async function stopWorker(worker: WorkerChild): Promise<void> {
    if (worker.stopped) return;
    // Windows may terminate abruptly on SIGTERM; no delivery is in flight at planned stops.
    worker.child.kill('SIGTERM');
    async function waitForExit(milliseconds: number): Promise<boolean> {
      const timer = new AbortController();
      try {
        return await Promise.race([
          worker.exited.then(() => true),
          sleep(milliseconds, false, { signal: timer.signal }),
        ]);
      } finally {
        timer.abort();
      }
    }
    if (!await waitForExit(4_000)) {
      worker.child.kill('SIGKILL');
      assert.ok(await waitForExit(2_000), `Worker would not exit\n${worker.logs}`);
    }
  }

  async function stopWorkers(): Promise<void> {
    const results = await Promise.allSettled(workers.map(stopWorker));
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Failed to stop workers');
  }

  async function request<T>(path: string, expected: number, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('X-API-Key', process.env.API_KEY!);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, {
      ...options, headers, signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]),
    });
    const text = await response.text();
    assert.equal(response.status, expected,
      `${options.method ?? 'GET'} ${path}: ${text}\n${workerLogs()}`);
    return JSON.parse(text) as T;
  }

  function remember(email: PublicEmail): PublicEmail {
    emailIds.add(email.id);
    const known = generations.get(email.id) ?? new Set<number>();
    known.add(email.generation);
    generations.set(email.id, known);
    return email;
  }

  async function createEmail(subject: string, delayMs: number) {
    subjects.add(subject);
    const payload = {
      senderId,
      to: `recipient-${token}@example.test`,
      subject,
      text: `Integration delivery ${subject}`,
      scheduledAt: new Date(Date.now() + delayMs).toISOString(),
    };
    const key = `backend-${randomUUID()}`;
    const email = remember(await request<PublicEmail>('/v1/emails', 201, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload),
    }));
    assert.equal(email.status, 'scheduled');
    assert.equal(email.generation, 1);
    assert.equal(email.attempts, 0);
    return { email, payload, key };
  }

  async function sent(email: PublicEmail): Promise<PublicEmail> {
    const result = await until(`Email ${email.id} was not sent`,
      () => request<PublicEmail>(`/v1/emails/${email.id}`, 200),
      (row) => row.status === 'sent');
    assert.equal(result.attempts, 1);
    assert.equal(result.generation, email.generation);
    assert.ok(result.sentAt);
    // A sent row precedes SendGate.release(); wait before any abrupt Windows stop.
    await until(`Delivery job ${email.id}-${email.generation} did not complete`, async () =>
      (await emailQueue.getJob(emailJobId(email.id, email.generation)))?.getState(),
    (state) => state === 'completed');
    return result;
  }

  async function mailpitMessages(): Promise<MailpitMessage[]> {
    const result: MailpitMessage[] = [];
    // Paginate rather than assuming this run owns Mailpit's default page.
    for (let start = 0; ; start += 100) {
      const response = await fetch(`${mailpitUrl}/api/v1/messages?start=${start}&limit=100`, {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]),
      });
      assert.equal(response.status, 200, `Mailpit: ${await response.clone().text()}`);
      const page = await response.json() as { messages: MailpitMessage[] };
      assert.ok(Array.isArray(page.messages), 'Mailpit must return a messages array');
      result.push(...page.messages);
      if (page.messages.length < 100) return result;
    }
  }

  async function assertOneMessage(subject: string): Promise<void> {
    const messages = await until(`Mailpit did not receive ${subject}`, mailpitMessages,
      (rows) => rows.some((message) => message.Subject === subject));
    assert.equal(messages.filter((message) => message.Subject === subject).length, 1,
      `Expected exactly one SMTP delivery for ${subject}`);
  }

  t.after(async () => {
    const errors: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { errors.push(error); }
    };
    await cleanup(stopWorkers);
    if (server) await cleanup(() => new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
      server!.closeAllConnections();
    }));
    // Never remove active jobs or database rows while one of our workers still runs.
    if (workers.every((worker) => worker.stopped)) {
      for (const [id, known] of generations) {
        for (const generation of known) await cleanup(async () => {
          const job = await emailQueue.getJob(emailJobId(id, generation));
          if (job) await job.remove();
        });
      }
      await cleanup(async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM outbox WHERE email_id = ANY($1::uuid[])', [[...emailIds]]);
          await client.query('DELETE FROM emails WHERE id = ANY($1::uuid[])', [[...emailIds]]);
          if (senderId) await client.query('DELETE FROM senders WHERE id = $1', [senderId]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });
      for (const id of emailIds) await cleanup(async () => {
        try {
          await searchClient.delete({ index: config.ELASTICSEARCH_INDEX, id });
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
      });
    }
    // Mailpit messages are intentionally retained; no global Redis, mail, or index deletion.
    await cleanup(shutdown);
    if (errors.length) throw new AggregateError(errors, `Integration cleanup failed\n${workerLogs()}`);
  });

  try {
    await ensureSearchIndex();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/v1`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    const sender = await request<{ id: string }>('/v1/senders', 201, {
      method: 'POST', body: JSON.stringify({ name: `Backend ${token}`, email: `sender-${token}@example.test` }),
    });
    senderId = sender.id;

    await startWorker();
    const first = await createEmail(`restart${token}`, 6_000);
    const replay = await request<PublicEmail>('/v1/emails', 200, {
      method: 'POST', headers: { 'Idempotency-Key': first.key }, body: JSON.stringify(first.payload),
    });
    assert.equal(replay.id, first.email.id);
    await request('/v1/emails', 409, {
      method: 'POST', headers: { 'Idempotency-Key': first.key },
      body: JSON.stringify({ ...first.payload, subject: `changed${token}` }),
    });
    const firstJobId = emailJobId(first.email.id, first.email.generation);
    await until('Future email was not queued as delayed', async () =>
      (await emailQueue.getJob(firstJobId))?.getState(), (state) => state === 'delayed', 4_000, 100);
    assert.ok(Date.now() < Date.parse(first.payload.scheduledAt), 'Must stop before the email is due');
    await stopWorkers();
    await sleep(Math.max(0, Date.parse(first.payload.scheduledAt) - Date.now()) + 100,
      undefined, { signal: t.signal });
    const overdue = await request<PublicEmail>(`/v1/emails/${first.email.id}`, 200);
    assert.equal(overdue.status, 'scheduled');
    assert.equal(overdue.attempts, 0);
    await Promise.all([startWorker(), startWorker()]);
    await sent(first.email);

    // Replaying an already delivered queue job must not perform SMTP a second time.
    await (await emailQueue.getJob(firstJobId))!.remove();
    await emailQueue.add('send', { emailId: first.email.id, generation: 1 }, { jobId: firstJobId });
    await until('Duplicate queue job did not complete', async () =>
      (await emailQueue.getJob(firstJobId))?.getState(), (state) => state === 'completed');
    await sent(first.email);
    await assertOneMessage(first.payload.subject);
    await until('Search never reflected sent delivery', async () => {
      await searchClient.indices.refresh({ index: config.ELASTICSEARCH_INDEX });
      return request<{ items: PublicEmail[] }>(
        `/v1/emails/search?q=${encodeURIComponent(first.payload.subject)}`, 200);
    }, (result) => result.items.some((email) => email.id === first.email.id && email.status === 'sent'));

    await stopWorkers();
    const lost = await createEmail(`queueloss${token}`, 5_000);
    const lostJobId = emailJobId(lost.email.id, lost.email.generation);
    await until('Outbox did not dispatch queue-loss fixture', async () => {
      await dispatchOne();
      return (await emailQueue.getJob(lostJobId))?.getState();
    }, (state) => state === 'delayed', 3_000, 50);
    const pending = await pool.query('SELECT id FROM outbox WHERE email_id = $1 AND kind = $2',
      [lost.email.id, 'schedule']);
    assert.equal(pending.rowCount, 0, 'The original schedule event must already be consumed');
    await (await emailQueue.getJob(lostJobId))!.remove();
    assert.equal(await emailQueue.getJob(lostJobId), undefined);
    await reconcile();
    await until('Reconciliation did not restore the missing job', async () => {
      await dispatchOne();
      return (await emailQueue.getJob(lostJobId))?.getState();
    }, (state) => state === 'delayed' || state === 'waiting', 3_000, 50);
    await Promise.all([startWorker(), startWorker()]);
    await sent(lost.email);
    await assertOneMessage(lost.payload.subject);

    await stopWorkers();
    const expired = await createEmail(`uncertain${token}`, 60_000);
    const update = await pool.query(`
      UPDATE emails SET status = 'sending', attempts = 1,
        lease_until = now() - interval '1 second', version = version + 1,
        updated_at = now()
      WHERE id = $1 AND status = 'scheduled'
    `, [expired.email.id]);
    assert.equal(update.rowCount, 1);
    await reconcile();
    const uncertain = await request<PublicEmail>(`/v1/emails/${expired.email.id}`, 200);
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.generation, 1);
    assert.equal(uncertain.attempts, 1);
    assert.equal((await mailpitMessages()).filter((message) => message.Subject === expired.payload.subject).length, 0);
    await request(`/v1/emails/${expired.email.id}/retry`, 409, {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal((await request<PublicEmail>(`/v1/emails/${expired.email.id}`, 200)).status, 'uncertain');
    const retried = remember(await request<PublicEmail>(`/v1/emails/${expired.email.id}/retry`, 200, {
      method: 'POST', body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
    }));
    assert.equal(retried.generation, 2);
    assert.equal(retried.status, 'scheduled');
    assert.equal(retried.attempts, 0);
    await Promise.all([startWorker(), startWorker()]);
    await sent(retried);
    await assertOneMessage(expired.payload.subject);
    // Check all subjects again after later deliveries to catch delayed duplicates.
    for (const subject of subjects) await assertOneMessage(subject);
  } catch (error) {
    t.diagnostic(workerLogs());
    throw error;
  }
});
