import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// delivery imports configuration and a lazy PostgreSQL pool, but no queue client.
// Initialize the environment before dynamically importing either module.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/email_scheduler_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.ELASTICSEARCH_URL ??= 'http://localhost:9200';
process.env.API_KEY ??= 'test-only-api-key-not-for-production';
process.env.DASHBOARD_PASSWORD ??= 'test-only-dashboard-password';

let classifySmtpError: typeof import('../src/delivery.js').classifySmtpError;
let pool: typeof import('../src/db/client.js').pool | undefined;

before(async () => {
  ({ pool } = await import('../src/db/client.js'));
  ({ classifySmtpError } = await import('../src/delivery.js'));
});
after(async () => {
  await pool?.end();
});

describe('classifySmtpError', () => {
  for (const responseCode of [400, 421, 450, 451, 499]) {
    it(`retries explicit transient SMTP response ${responseCode}`, () => {
      assert.equal(classifySmtpError({ responseCode }), 'retry');
    });
  }

  for (const responseCode of [500, 535, 550, 554]) {
    it(`fails explicit permanent SMTP response ${responseCode}`, () => {
      assert.equal(classifySmtpError({ responseCode }), 'failed');
    });
  }

  for (const code of ['EPRESMTP', 'EDNS', 'EAUTH']) {
    it(`retries safe connection-setup failure ${code}`, () => {
      assert.equal(classifySmtpError({ code }), 'retry');
    });
  }

  it('prioritizes explicit SMTP responses over connection error codes', () => {
    assert.equal(classifySmtpError({ responseCode: 550, code: 'ECONNECTION' }), 'failed');
    assert.equal(classifySmtpError({ responseCode: 450, code: 'ESOCKET' }), 'retry');
  });

  for (const code of ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNECTION']) {
    it(`does not automatically retry ambiguous ${code} after DATA`, () => {
      assert.equal(classifySmtpError({ code, command: 'DATA' }), 'uncertain');
    });
  }

  it('does not mistake Nodemailer CONN disconnects for pre-submission failures', () => {
    assert.equal(classifySmtpError({ code: 'ECONNECTION', command: 'CONN' }), 'uncertain');
  });

  it('treats absent, unknown, and non-error SMTP responses as uncertain', () => {
    for (const error of [undefined, null, {}, new Error('lost final acknowledgement'), 'unknown', { responseCode: 250 }, { responseCode: 399 }]) {
      assert.equal(classifySmtpError(error), 'uncertain');
    }
  });
});
