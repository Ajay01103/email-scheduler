import { z } from 'zod';

export const emailStatusSchema = z.enum([
  'scheduled', 'sending', 'sent', 'failed', 'uncertain',
]);

export const senderInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).regex(/^[^\r\n\u0000]+$/u),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
});

export const emailInputSchema = z.strictObject({
  senderId: z.uuid(),
  to: z.email().max(254),
  subject: z.string().min(1).max(998).regex(/^[^\r\n\u0000]+$/u),
  text: z.string().max(100_000),
  html: z.string().max(100_000).optional(),
  // Freshness is checked only after resolving an idempotent replay.
  scheduledAt: z.iso.datetime({ offset: true })
    .refine((value) => Number.isFinite(Date.parse(value)))
    .transform((value) => new Date(value)),
});

export const idempotencyKeySchema = z.string().min(1).max(128)
  .regex(/^[\x21-\x7e]+$/u);

export const emailIdSchema = z.uuid();

export const emailListQuerySchema = z.strictObject({
  status: emailStatusSchema.optional(),
  senderId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const emailSearchQuerySchema = emailListQuerySchema.extend({
  q: z.string().trim().min(1).max(500).optional(),
}).refine((value) => value.offset + value.limit <= 10_000);

export const retryInputSchema = z.strictObject({
  acknowledgeDuplicateRisk: z.boolean().optional(),
});

export type SenderInput = z.infer<typeof senderInputSchema>;
export type EmailInput = z.infer<typeof emailInputSchema>;
export type EmailListQuery = z.infer<typeof emailListQuerySchema>;
export type EmailSearchQuery = z.infer<typeof emailSearchQuerySchema>;
export type RetryInput = z.infer<typeof retryInputSchema>;
