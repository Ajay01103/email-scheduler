import { Client, errors, type estypes } from '@elastic/elasticsearch';
import { eq, gt } from 'drizzle-orm';
import { config, logger } from './config.js';
import { db } from './db/client.js';
import { emails, senders } from './db/schema.js';

export const searchClient = new Client({
  node: config.ELASTICSEARCH_URL,
  requestTimeout: 5_000,
  maxRetries: 2,
});

type EmailDocument = {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  status: typeof emails.$inferSelect.status;
  senderId: string;
  senderEmail: string;
  senderName: string;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type SearchEmailsInput = {
  q?: string;
  status?: typeof emails.$inferSelect.status;
  senderId?: string;
  offset: number;
  limit: number;
};

// Whitelist fields even when reading documents from an older index.
function publicDocument(document: EmailDocument): EmailDocument {
  return {
    id: document.id,
    to: document.to,
    subject: document.subject,
    text: document.text,
    html: document.html,
    status: document.status,
    senderId: document.senderId,
    senderEmail: document.senderEmail,
    senderName: document.senderName,
    scheduledAt: document.scheduledAt,
    sentAt: document.sentAt,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    version: document.version,
  };
}

export async function ensureSearchIndex(): Promise<void> {
  if (await searchClient.indices.exists({ index: config.ELASTICSEARCH_INDEX })) return;

  try {
    await searchClient.indices.create({
      index: config.ELASTICSEARCH_INDEX,
      mappings: {
        dynamic: 'strict',
        properties: {
          id: { type: 'keyword' },
          to: { type: 'text' },
          subject: { type: 'text' },
          text: { type: 'text' },
          html: { type: 'text' },
          status: { type: 'keyword' },
          senderId: { type: 'keyword' },
          senderEmail: { type: 'text' },
          senderName: { type: 'text' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' },
          version: { type: 'integer' },
        },
      },
    });
  } catch (error) {
    if (error instanceof errors.ResponseError
      && error.body?.error?.type === 'resource_already_exists_exception') return;
    throw error;
  }
  logger.info('Search index created');
}

export async function indexEmail(emailId: string): Promise<void> {
  const [row] = await db.select({
    id: emails.id,
    to: emails.to,
    subject: emails.subject,
    text: emails.text,
    html: emails.html,
    status: emails.status,
    senderId: emails.senderId,
    senderEmail: senders.email,
    senderName: senders.name,
    scheduledAt: emails.scheduledAt,
    sentAt: emails.sentAt,
    createdAt: emails.createdAt,
    updatedAt: emails.updatedAt,
    version: emails.version,
  }).from(emails).innerJoin(senders, eq(emails.senderId, senders.id))
    .where(eq(emails.id, emailId)).limit(1);
  if (!row) return;

  const document: EmailDocument = {
    ...row,
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const request = {
    index: config.ELASTICSEARCH_INDEX,
    id: emailId,
    document,
    version: row.version,
    version_type: 'external_gte' as const,
  };
  try {
    // Visibility follows the index refresh interval, not individual writes.
    await searchClient.index(request);
  } catch (error) {
    if (error instanceof errors.ResponseError && error.statusCode === 409) return;
    if (error instanceof errors.ResponseError && error.statusCode === 404) {
      await ensureSearchIndex();
      await searchClient.index(request);
      return;
    }
    throw error;
  }
}

export async function searchEmails({ q, status, senderId, offset, limit }: SearchEmailsInput) {
  const filter: estypes.QueryDslQueryContainer[] = [];
  if (status) filter.push({ term: { status } });
  if (senderId) filter.push({ term: { senderId } });

  const response = await searchClient.search<EmailDocument>({
    index: config.ELASTICSEARCH_INDEX,
    from: offset,
    size: limit,
    track_total_hits: true,
    query: {
      bool: {
        must: q ? [{
          multi_match: {
            query: q,
            fields: ['subject', 'text', 'html', 'to', 'senderEmail', 'senderName'],
          },
        }] : [{ match_all: {} }],
        filter,
      },
    },
    sort: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  const total = response.hits.total;
  return {
    items: response.hits.hits.flatMap((hit) => hit._source ? [publicDocument(hit._source)] : []),
    total: typeof total === 'number' ? total : total?.value ?? 0,
    offset,
    limit,
  };
}

export async function reindexAllEmails(): Promise<void> {
  await ensureSearchIndex();
  let cursor: string | undefined;
  let indexed = 0;
  for (;;) {
    const batch = await db.select({ id: emails.id }).from(emails)
      .where(cursor === undefined ? undefined : gt(emails.id, cursor))
      .orderBy(emails.id).limit(200);
    if (batch.length === 0) break;
    for (const row of batch) {
      await indexEmail(row.id);
      cursor = row.id;
      indexed += 1;
    }
  }
  logger.info({ indexed }, 'Email reindex completed');
}
