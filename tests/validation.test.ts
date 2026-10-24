import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emailIdSchema,
  emailInputSchema,
  emailListQuerySchema,
  emailSearchQuerySchema,
  emailStatusSchema,
  idempotencyKeySchema,
  retryInputSchema,
  senderInputSchema,
} from '../src/validation.js';

const senderId = '6d50b63c-8718-4d89-a350-7fb535c37081';
const validSender = { name: 'Example Sender', email: 'sender@example.test' };
const validEmail = {
  senderId,
  to: 'recipient@example.test',
  subject: 'Scheduled message',
  text: 'Message body',
  scheduledAt: '2030-01-02T03:04:05Z',
};

describe('senderInputSchema', () => {
  it('trims the name and normalizes the email address', () => {
    assert.deepEqual(senderInputSchema.parse({ name: '  Example Sender  ', email: 'SENDER@EXAMPLE.TEST' }), validSender);
  });

  for (const name of ['Header\nInjected', 'Header\rInjected', 'Header\r\nInjected', 'Null\u0000Byte', '', '   ', 'a'.repeat(201)]) {
    it(`rejects invalid sender name ${JSON.stringify(name)}`, () => {
      assert.equal(senderInputSchema.safeParse({ ...validSender, name }).success, false);
    });
  }

  it('rejects invalid addresses and unknown properties', () => {
    assert.equal(senderInputSchema.safeParse({ ...validSender, email: 'not-an-email' }).success, false);
    assert.equal(senderInputSchema.safeParse({ ...validSender, admin: true }).success, false);
  });
});

describe('emailInputSchema', () => {
  it('converts explicit UTC and offset timestamps to the same Date', () => {
    const utc = emailInputSchema.parse(validEmail);
    const offset = emailInputSchema.parse({ ...validEmail, scheduledAt: '2030-01-02T05:04:05+02:00', html: '<p>Hello</p>' });
    assert.ok(utc.scheduledAt instanceof Date);
    assert.equal(utc.scheduledAt.toISOString(), validEmail.scheduledAt.replace('Z', '.000Z'));
    assert.deepEqual(offset.scheduledAt, utc.scheduledAt);
    assert.equal(offset.html, '<p>Hello</p>');
  });

  it('leaves timestamp freshness to the API so idempotent replays remain valid', () => {
    assert.equal(emailInputSchema.safeParse({ ...validEmail, scheduledAt: '2000-01-01T00:00:00Z' }).success, true);
  });

  for (const subject of ['Header\nBcc: victim@example.test', 'Header\rInjected', 'Header\r\nInjected', 'Null\u0000Byte', '', 'a'.repeat(999)]) {
    it(`rejects invalid subject ${JSON.stringify(subject)}`, () => {
      assert.equal(emailInputSchema.safeParse({ ...validEmail, subject }).success, false);
    });
  }

  for (const to of ['invalid', 'a@example.test\r\nBcc: victim@example.test', 'one@example.test,two@example.test', '']) {
    it(`rejects invalid recipient ${JSON.stringify(to)}`, () => {
      assert.equal(emailInputSchema.safeParse({ ...validEmail, to }).success, false);
    });
  }

  for (const scheduledAt of ['2030-01-02T03:04:05', '2030-01-02', '2030-02-30T03:04:05Z', 'not-a-date']) {
    it(`rejects invalid or timezone-less timestamp ${JSON.stringify(scheduledAt)}`, () => {
      assert.equal(emailInputSchema.safeParse({ ...validEmail, scheduledAt }).success, false);
    });
  }

  it('rejects unknown properties and invalid sender IDs', () => {
    assert.equal(emailInputSchema.safeParse({ ...validEmail, status: 'sent' }).success, false);
    assert.equal(emailInputSchema.safeParse({ ...validEmail, senderId: 'not-a-uuid' }).success, false);
  });

  it('accepts field size boundaries and rejects oversized bodies', () => {
    assert.equal(emailInputSchema.safeParse({ ...validEmail, subject: 'a'.repeat(998), text: 'a'.repeat(100_000), html: 'a'.repeat(100_000) }).success, true);
    assert.equal(emailInputSchema.safeParse({ ...validEmail, text: 'a'.repeat(100_001) }).success, false);
    assert.equal(emailInputSchema.safeParse({ ...validEmail, html: 'a'.repeat(100_001) }).success, false);
  });
});

describe('idempotencyKeySchema', () => {
  it('accepts every printable non-space ASCII character', () => {
    const key = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 0x21)).join('');
    assert.equal(idempotencyKeySchema.parse(key), key);
    assert.equal(idempotencyKeySchema.parse('a'.repeat(128)), 'a'.repeat(128));
  });

  for (const key of ['', 'a'.repeat(129), 'with space', 'tab\tkey', 'line\nkey', 'line\rkey', 'null\u0000key', 'delete\u007f', 'café', '🔑']) {
    it(`rejects invalid key ${JSON.stringify(key)}`, () => {
      assert.equal(idempotencyKeySchema.safeParse(key).success, false);
    });
  }
});

describe('query and retry schemas', () => {
  it('provides pagination defaults and coerces numeric query strings', () => {
    assert.deepEqual(emailListQuerySchema.parse({}), { offset: 0, limit: 20 });
    assert.deepEqual(emailListQuerySchema.parse({ offset: '10', limit: '100', senderId, status: 'uncertain' }), {
      offset: 10, limit: 100, senderId, status: 'uncertain',
    });
  });

  for (const query of [{ offset: -1 }, { offset: 1_000_001 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: 'bad' }, { status: 'unknown' }, { senderId: 'invalid' }, { unknown: true }]) {
    it(`rejects invalid list query ${JSON.stringify(query)}`, () => {
      assert.equal(emailListQuerySchema.safeParse(query).success, false);
    });
  }

  it('trims search text and enforces the search result window', () => {
    assert.deepEqual(emailSearchQuerySchema.parse({ q: '  hello  ', offset: '9990', limit: '10' }), { q: 'hello', offset: 9990, limit: 10 });
    for (const query of [{ offset: 9991, limit: 10 }, { q: '   ' }, { q: 'a'.repeat(501) }, { unknown: true }]) {
      assert.equal(emailSearchQuerySchema.safeParse(query).success, false, JSON.stringify(query));
    }
  });

  it('accepts only known statuses and UUID email IDs', () => {
    for (const status of ['scheduled', 'sending', 'sent', 'failed', 'uncertain']) {
      assert.equal(emailStatusSchema.parse(status), status);
    }
    assert.equal(emailStatusSchema.safeParse('delivered').success, false);
    assert.equal(emailIdSchema.parse(senderId), senderId);
    assert.equal(emailIdSchema.safeParse('invalid').success, false);
  });

  it('accepts only an optional boolean duplicate-risk acknowledgement', () => {
    assert.deepEqual(retryInputSchema.parse({}), {});
    for (const acknowledgeDuplicateRisk of [true, false]) {
      assert.deepEqual(retryInputSchema.parse({ acknowledgeDuplicateRisk }), { acknowledgeDuplicateRisk });
    }
    assert.equal(retryInputSchema.safeParse({ acknowledgeDuplicateRisk: 'true' }).success, false);
    assert.equal(retryInputSchema.safeParse({ force: true }).success, false);
  });
});
