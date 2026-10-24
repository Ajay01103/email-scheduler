
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const senders = pgTable('senders', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const emails = pgTable('emails', {
  id: uuid('id').defaultRandom().primaryKey(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  senderId: uuid('sender_id').notNull().references(() => senders.id),
  to: text('to').notNull(),
  subject: text('subject').notNull(),
  text: text('text').notNull(),
  html: text('html'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  status: text('status', {
    enum: ['scheduled', 'sending', 'sent', 'failed', 'uncertain'],
  }).default('scheduled').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  generation: integer('generation').default(1).notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  lastError: text('last_error'),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('emails_created_at_id_idx').on(table.createdAt, table.id),
  index('emails_status_scheduled_at_idx').on(table.status, table.scheduledAt),
  index('emails_sender_id_idx').on(table.senderId),
]);

export const outbox = pgTable('outbox', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  emailId: uuid('email_id').notNull().references(() => emails.id),
  kind: text('kind', { enum: ['schedule', 'index'] }).notNull(),
  version: integer('version').notNull(),
  availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('outbox_email_kind_version_unique').on(table.emailId, table.kind, table.version),
  index('outbox_available_at_idx').on(table.availableAt),
]);
