import 'dotenv/config';
import pino from 'pino';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const booleanEnv = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  ELASTICSEARCH_URL: z.url(),
  ELASTICSEARCH_INDEX: z.string().regex(/^[a-z][a-z0-9_-]*$/).default('emails'),
  API_KEY: z.string().min(32),
  DASHBOARD_USER: z.string().min(1).default('admin'),
  DASHBOARD_PASSWORD: z.string().min(16),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: positiveInt(1025),
  SMTP_SECURE: booleanEnv,
  SMTP_REQUIRE_TLS: booleanEnv,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_DOMAIN: z.string().regex(/^[a-zA-Z0-9.-]+$/).default('example.test'),
  WORKER_CONCURRENCY: positiveInt(8),
  MIN_SEND_INTERVAL_MS: positiveInt(1000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: positiveInt(200),
  OUTBOX_POLL_MS: positiveInt(1000),
  RECONCILE_INTERVAL_MS: positiveInt(30000),
  SEND_LEASE_MS: z.coerce.number().int().min(120000).default(120000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
}).superRefine((value, ctx) => {
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASS)) {
    ctx.addIssue({ code: 'custom', message: 'SMTP_USER and SMTP_PASS must be configured together' });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Do not print submitted values: they may include passwords and connection strings.
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
}
export const config = parsed.data;
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: ['password', 'authorization', 'apiKey', 'SMTP_PASS', 'DATABASE_URL', 'REDIS_URL'],
});
