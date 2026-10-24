import { DelayedError, type Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { createSmtpTransport } from './smtp.js';
import { config, logger } from './config.js';
import { db } from './db/client.js';
import { emails, outbox, senders } from './db/schema.js';
import type { EmailJob } from './queue.js';
import type { SendGate } from './rate-limit.js';

export function classifySmtpError(error: unknown): 'retry' | 'failed' | 'uncertain' {
  const failure = error as { responseCode?: number; code?: string; command?: string } | null;
  if (failure?.responseCode && failure.responseCode >= 400 && failure.responseCode < 500) return 'retry';
  if (failure?.responseCode && failure.responseCode >= 500) return 'failed';
  if (['EPRESMTP', 'EDNS', 'EAUTH'].includes(failure?.code ?? '')) return 'retry';
  // Once DATA could have been accepted, a missing final response is ambiguous.
  return 'uncertain';
}

async function postpone(job: Job<EmailJob>, token: string | undefined, delay: number): Promise<never> {
  if (!token) throw new Error('Missing BullMQ lock token');
  await job.moveToDelayed(Date.now() + Math.max(50, delay), token);
  throw new DelayedError();
}

async function finish(emailId: string, generation: number, status: 'sent' | 'failed' | 'uncertain' | 'scheduled', reason: string | null, nextAttemptAt?: Date) {
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(emails).set({
      status, lastError: reason, leaseUntil: null, updatedAt: new Date(),
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
      sentAt: status === 'sent' ? new Date() : null,
      version: sql`${emails.version} + 1`,
    }).where(and(eq(emails.id, emailId), eq(emails.generation, generation), eq(emails.status, 'sending'))).returning();
    if (!updated) throw new Error('Delivery state changed before acknowledgement');
    await tx.insert(outbox).values({ emailId, kind: 'index', version: updated.version });
  });
}

export function createDeliveryProcessor(gate: SendGate) {
  return async (job: Job<EmailJob>, token?: string): Promise<void> => {
    const { emailId, generation } = job.data;
    const [current] = await db.select().from(emails).where(eq(emails.id, emailId));
    if (!current || current.generation !== generation || ['sent', 'failed', 'uncertain'].includes(current.status)) return;
    if (current.status === 'sending') {
      await postpone(job, token, Math.max(1000, (current.leaseUntil?.getTime() ?? Date.now()) - Date.now()));
    }
    const eligibleAt = Math.max(current.scheduledAt.getTime(), current.nextAttemptAt?.getTime() ?? 0);
    if (eligibleAt > Date.now()) await postpone(job, token, eligibleAt - Date.now());
    const [sender] = await db.select().from(senders).where(eq(senders.id, current.senderId));
    if (!sender) throw new Error('Sender missing');
    const slot = await gate.acquire(current.senderId);
    if (!slot.token) await postpone(job, token, slot.waitMs);

    try {
      const claimed = await db.transaction(async (tx) => {
        const [email] = await tx.update(emails).set({
          status: 'sending', attempts: sql`${emails.attempts} + 1`,
          leaseUntil: new Date(Date.now() + config.SEND_LEASE_MS),
          version: sql`${emails.version} + 1`, updatedAt: new Date(),
        }).where(and(eq(emails.id, emailId), eq(emails.generation, generation), eq(emails.status, 'scheduled'))).returning();
        if (email) await tx.insert(outbox).values({ emailId, kind: 'index', version: email.version });
        return email;
      });
      if (!claimed) return;

      const smtp = createSmtpTransport();
      const { transport } = smtp;
      let smtpError: unknown;
      let succeeded = false;
      try {
        const result = await transport.sendMail({
          from: { name: sender.name, address: sender.email },
          to: claimed.to, subject: claimed.subject, text: claimed.text,
          ...(claimed.html !== null ? { html: claimed.html } : {}),
          messageId: `<${claimed.id}.${generation}@${config.SMTP_FROM_DOMAIN}>`,
        });
        succeeded = result.accepted.length > 0;
        if (!succeeded) smtpError = { responseCode: 550 };
      } catch (error) {
        smtpError = error;
      } finally {
        smtp.close();
      }
      if (succeeded) {
        // If this commit fails, keep 'sending'. Recovery marks it uncertain, not resendable.
        await finish(emailId, generation, 'sent', null);
        logger.info({ emailId, generation }, 'Email accepted by SMTP');
        return;
      }
      const outcome = classifySmtpError(smtpError);
      const retry = outcome === 'retry' && claimed.attempts < 5;
      const status = retry ? 'scheduled' : outcome === 'retry' ? 'failed' : outcome;
      const retryDelay = Math.min(60000, 2000 * 2 ** (claimed.attempts - 1));
      await finish(emailId, generation, status, retry
        ? 'SMTP explicitly rejected or connection setup failed; safe retry pending'
        : status === 'uncertain' ? 'SMTP acknowledgement ambiguous; operator review required' : 'SMTP rejected delivery',
      retry ? new Date(Date.now() + retryDelay) : undefined);
      if (retry) await postpone(job, token, retryDelay);
      logger.warn({ emailId, status }, 'Email delivery did not complete');
    } finally {
      try { await gate.release(slot.token); } catch {
        // The lease expires. Do not mask SMTP acknowledgement with a Redis release error.
        logger.error({ emailId }, 'Send gate release failed; waiting for lease expiry');
      }
    }
  };
}
