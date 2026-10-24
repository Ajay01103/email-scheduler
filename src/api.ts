import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { and, desc, eq, sql } from 'drizzle-orm';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { config, logger } from './config.js';
import { endpointAddress, errorDetails } from './dependency-errors.js';
import { db, pool } from './db/client.js';
import { emails, outbox, senders } from './db/schema.js';
import { emailQueue, queueRedis } from './queue.js';
import { searchClient, searchEmails } from './search.js';
import {
  emailIdSchema,
  emailInputSchema,
  emailListQuerySchema,
  emailSearchQuerySchema,
  idempotencyKeySchema,
  retryInputSchema,
  senderInputSchema,
  type EmailInput,
} from './validation.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

function requestHash(input: EmailInput): string {
  // Explicit field order and normalized timestamps make hashing independent of JSON key order.
  return createHash('sha256').update(JSON.stringify({
    senderId: input.senderId.toLowerCase(),
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html ?? null,
    scheduledAt: input.scheduledAt.toISOString(),
  })).digest('hex');
}

function publicEmail(row: typeof emails.$inferSelect) {
  const { idempotencyKey: _key, requestHash: _hash, lastError: _error,
    leaseUntil: _lease, ...result } = row;
  return result;
}

function databaseErrorCode(error: unknown): string | undefined {
  // Drizzle wraps driver errors in a query error.
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth += 1) {
    if ('code' in error && typeof error.code === 'string') return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Operation timed out')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let stopping = false;
let server: Server | undefined;
let shutdownPromise: Promise<void> | undefined;
let startupPromise: Promise<Server> | undefined;

async function checkDependencies(): Promise<void> {
  const checked = async (dependency: string, endpoint: string, operation: Promise<unknown>) => {
    try { await bounded(operation, 5000); } catch (error) {
      logger.error({ dependency, endpoint: endpointAddress(endpoint), ...errorDetails(error) }, 'Dependency check failed');
      throw error;
    }
  };
  await bounded(Promise.all([
    checked('postgres', config.DATABASE_URL, db.execute(sql`select 1`)),
    checked('redis', config.REDIS_URL, (async () => {
      // Offline buffering is disabled: commands must wait for the initial handshake.
      await emailQueue.waitUntilReady();
      if (await queueRedis.ping() !== 'PONG') throw new Error('Redis is unavailable');
    })()),
    checked('elasticsearch', config.ELASTICSEARCH_URL, searchClient.ping().then((reply) => {
      if (reply === false) throw new Error('Search is unavailable');
    })),
  ]), 5_000);
}

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on('finish', () => {
    // Never log bodies, query strings, credentials, or raw downstream errors.
    logger.info({
      method: req.method,
      route: req.route?.path ?? 'unmatched',
      statusCode: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }, 'HTTP request');
  });
  next();
});

app.get('/health/live', (_req, res) => {
  res.status(stopping ? 503 : 200).json({ status: stopping ? 'stopping' : 'ok' });
});
app.get('/health/ready', async (_req, res) => {
  if (stopping) {
    res.status(503).json({ status: 'not ready' });
    return;
  }
  try {
    await checkDependencies();
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

const apiAuth: RequestHandler = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!sameSecret(req.get('X-API-Key') ?? '', config.API_KEY)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

app.use('/v1', rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}), apiAuth, express.json({ limit: '1mb' }));
app.use('/v1', (_req, _res, next) => {
  if (stopping) throw new HttpError(503, 'Service is shutting down');
  next();
});

app.post('/v1/senders', async (req, res) => {
  const input = senderInputSchema.parse(req.body);
  const [sender] = await db.insert(senders).values(input)
    .onConflictDoNothing({ target: senders.email }).returning();
  if (!sender) throw new HttpError(409, 'Sender email already exists');
  res.status(201).json(sender);
});

app.get('/v1/senders', async (_req, res) => {
  const rows = await db.select().from(senders).orderBy(senders.createdAt, senders.id);
  res.json({ items: rows });
});

app.post('/v1/emails', async (req, res) => {
  const key = idempotencyKeySchema.parse(req.get('Idempotency-Key'));
  const input = emailInputSchema.parse(req.body);
  const hash = requestHash(input);
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(emails)
      .where(eq(emails.idempotencyKey, key)).limit(1);
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new HttpError(409, 'Idempotency key was used with a different payload');
      }
      return { row: existing, created: false };
    }

    const [inserted] = await tx.insert(emails).values({
      ...input,
      idempotencyKey: key,
      requestHash: hash,
    }).onConflictDoNothing({ target: emails.idempotencyKey }).returning();

    if (!inserted) {
      // A concurrent request may have committed after the initial lookup.
      const [existing] = await tx.select().from(emails)
        .where(eq(emails.idempotencyKey, key)).limit(1);
      if (!existing) throw new HttpError(503, 'Please retry the request');
      if (existing.requestHash !== hash) {
        throw new HttpError(409, 'Idempotency key was used with a different payload');
      }
      return { row: existing, created: false };
    }

    // Throwing rolls back the insert. Replays above remain valid after the scheduled time.
    if (input.scheduledAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'scheduledAt must be in the future');
    }
    await tx.insert(outbox).values([
      { emailId: inserted.id, kind: 'schedule', version: inserted.version },
      { emailId: inserted.id, kind: 'index', version: inserted.version },
    ]);
    return { row: inserted, created: true };
  });
  res.status(result.created ? 201 : 200)
    .location(`/v1/emails/${result.row.id}`).json(publicEmail(result.row));
});

app.get('/v1/emails', async (req, res) => {
  const query = emailListQuerySchema.parse(req.query);
  const rows = await db.select().from(emails).where(and(
    query.status ? eq(emails.status, query.status) : undefined,
    query.senderId ? eq(emails.senderId, query.senderId) : undefined,
  )).orderBy(desc(emails.createdAt), desc(emails.id))
    .offset(query.offset).limit(query.limit);
  res.json({ items: rows.map(publicEmail), offset: query.offset, limit: query.limit });
});

// Register before /:id so "search" is never interpreted as a UUID.
app.get('/v1/emails/search', async (req, res) => {
  const query = emailSearchQuerySchema.parse(req.query);
  res.json(await searchEmails(query));
});

app.get('/v1/emails/:id', async (req, res) => {
  const id = emailIdSchema.parse(req.params.id);
  const [row] = await db.select().from(emails).where(eq(emails.id, id)).limit(1);
  if (!row) throw new HttpError(404, 'Email not found');
  res.json(publicEmail(row));
});

app.post('/v1/emails/:id/retry', async (req, res) => {
  const id = emailIdSchema.parse(req.params.id);
  const input = retryInputSchema.parse(req.body ?? {});
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(emails)
      .where(eq(emails.id, id)).for('update');
    if (!current) throw new HttpError(404, 'Email not found');
    if (current.status !== 'failed' && current.status !== 'uncertain') {
      throw new HttpError(409, 'Only failed or uncertain emails can be retried');
    }
    if (current.status === 'uncertain' && input.acknowledgeDuplicateRisk !== true) {
      throw new HttpError(409, 'Retrying an uncertain email requires acknowledgeDuplicateRisk: true');
    }
    const now = new Date();
    const [updated] = await tx.update(emails).set({
      status: 'scheduled',
      scheduledAt: now,
      nextAttemptAt: null,
      version: sql`${emails.version} + 1`,
      generation: sql`${emails.generation} + 1`,
      attempts: 0,
      leaseUntil: null,
      sentAt: null,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(emails.id, id),
      eq(emails.status, current.status),
      eq(emails.version, current.version),
    )).returning();
    if (!updated) throw new HttpError(409, 'Email changed; please retry the request');
    await tx.insert(outbox).values([
      { emailId: id, kind: 'schedule', version: updated.version },
      { emailId: id, kind: 'index', version: updated.version },
    ]);
    return updated;
  });
  res.json(publicEmail(row));
});

const dashboard = new ExpressAdapter();
dashboard.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(emailQueue, { readOnlyMode: true })],
  serverAdapter: dashboard,
});
app.use('/admin/queues', rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}), (req, res, next) => {
  const authorization = req.get('Authorization') ?? '';
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)?.[1];
  const credentials = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const separator = credentials.indexOf(':');
  const username = separator >= 0 ? credentials.slice(0, separator) : '';
  const password = separator >= 0 ? credentials.slice(separator + 1) : '';
  // Evaluate both comparisons even when the username is wrong.
  const validUsername = sameSecret(username, config.DASHBOARD_USER);
  const validPassword = sameSecret(password, config.DASHBOARD_PASSWORD);
  if (!encoded || separator < 0 || !validUsername || !validPassword) {
    res.set('WWW-Authenticate', 'Basic realm="Queue dashboard", charset="UTF-8"')
      .status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  next();
}, dashboard.getRouter());

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error && typeof error === 'object' && 'type' in error) {
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large' });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
  }
  const code = databaseErrorCode(error);
  if (code === '23503') {
    res.status(400).json({ error: 'Invalid sender reference' });
    return;
  }
  if (code === '23505') {
    res.status(409).json({ error: 'Resource already exists' });
    return;
  }
  logger.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'API request failed');
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

export function startServer(): Promise<Server> {
  if (stopping) return Promise.reject(new Error('Server is shutting down'));
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    await checkDependencies();
    if (stopping) throw new Error('Server is shutting down');
    return await new Promise<Server>((resolveStarted, reject) => {
      const listeningServer = app.listen(config.PORT);
      server = listeningServer;
      listeningServer.headersTimeout = 15_000;
      listeningServer.requestTimeout = 30_000;
      listeningServer.keepAliveTimeout = 5_000;
      listeningServer.once('error', reject);
      listeningServer.once('listening', () => {
        listeningServer.removeListener('error', reject);
        listeningServer.on('error', () => logger.error('HTTP server error'));
        logger.info({ port: config.PORT }, 'API listening');
        resolveStarted(listeningServer);
      });
    });
  })();
  return startupPromise;
}

export function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    try {
      await bounded((async () => {
        if (server?.listening) {
          await new Promise<void>((resolveClosed, reject) => {
            server!.close((error) => error ? reject(error) : resolveClosed());
            server!.closeIdleConnections();
          });
        }
        // Close clients only after active HTTP requests have finished.
        const results = await Promise.allSettled([
          emailQueue.close(),
          pool.end(),
          searchClient.close(),
        ]);
        try {
          await queueRedis.quit();
        } finally {
          queueRedis.disconnect();
        }
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('A dependency failed to close');
        }
      })(), 10_000);
    } finally {
      server?.closeAllConnections();
      queueRedis.disconnect();
    }
  })();
  return shutdownPromise;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = () => {
    void shutdown().then(() => process.exit(0), () => {
      logger.error('Graceful shutdown failed or exceeded its deadline');
      process.exit(1);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  void startServer().catch(async (error) => {
    logger.error(errorDetails(error), 'API startup failed');
    try {
      await shutdown();
    } finally {
      process.exit(1);
    }
  });
}
