import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { config, logger } from './config.js';
import { db } from './db/client.js';
import { emails, outbox } from './db/schema.js';
import { emailJobId, emailQueue } from './queue.js';
import { indexEmail } from './search.js';

export async function dispatchOne(): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(outbox)
      .where(lte(outbox.availableAt, new Date()))
      .orderBy(outbox.availableAt, outbox.id).limit(1).for('update', { skipLocked: true });
    if (!event) return false;
    try {
      if (event.kind === 'index') {
        await indexEmail(event.emailId);
      } else {
        const [email] = await tx.select().from(emails).where(eq(emails.id, event.emailId));
        if (email?.status === 'scheduled') {
          const jobId = emailJobId(email.id, email.generation);
          const existing = await emailQueue.getJob(jobId);
          if (existing) {
            const state = await existing.getState();
            // Terminal queue records cannot strand a still-pending database email.
            if (state === 'failed' || state === 'completed') await existing.remove();
          }
          await emailQueue.add('send', { emailId: email.id, generation: email.generation }, {
            jobId, delay: Math.max(0, Math.max(email.scheduledAt.getTime(), email.nextAttemptAt?.getTime() ?? 0) - Date.now()),
          });
        }
      }
      await tx.delete(outbox).where(eq(outbox.id, event.id));
    } catch {
      // Keep the durable event and let other events make progress during outages.
      await tx.update(outbox).set({ availableAt: new Date(Date.now() + 5000) })
        .where(eq(outbox.id, event.id));
      logger.warn({ emailId: event.emailId, kind: event.kind }, 'Outbox delivery deferred');
    }
    return true;
  });
}

export async function reconcile(): Promise<void> {
  // SMTP may have accepted a message before a worker crashed. Never resend blindly.
  await db.transaction(async (tx) => {
    const expired = await tx.update(emails).set({
      status: 'uncertain', leaseUntil: null, updatedAt: new Date(),
      version: sql`${emails.version} + 1`, lastError: 'Delivery lease expired; verify SMTP acceptance before retry',
    }).where(and(eq(emails.status, 'sending'), lte(emails.leaseUntil, new Date()))).returning();
    if (expired.length) await tx.insert(outbox).values(expired.map((email) => ({
      emailId: email.id, kind: 'index' as const, version: email.version,
    }))).onConflictDoNothing();
  });

  let cursor: string | undefined;
  for (;;) {
    const batch = await db.select({ id: emails.id, version: emails.version }).from(emails)
      .where(and(eq(emails.status, 'scheduled'), cursor ? gt(emails.id, cursor) : undefined))
      .orderBy(emails.id).limit(200);
    if (!batch.length) break;
    // Repeating these events is harmless: deterministic BullMQ IDs deduplicate enqueue.
    await db.insert(outbox).values(batch.map((email) => ({
      emailId: email.id, kind: 'schedule' as const, version: email.version,
    }))).onConflictDoNothing();
    cursor = batch[batch.length - 1]!.id;
  }
}

export async function runOutbox(signal: AbortSignal): Promise<void> {
  let nextReconcile = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() >= nextReconcile) {
        await reconcile();
        nextReconcile = Date.now() + config.RECONCILE_INTERVAL_MS;
      }
      let handled = 0;
      while (!signal.aborted && handled < 100 && await dispatchOne()) handled += 1;
      if (handled === 100) continue;
    } catch {
      logger.error('Outbox loop failed; durable events will be retried');
    }
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, config.OUTBOX_POLL_MS);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
}
