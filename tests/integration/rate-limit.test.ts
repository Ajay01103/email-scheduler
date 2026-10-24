import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, type TestContext } from 'node:test';
import { Redis } from 'ioredis';
import { SendGate } from '../../src/rate-limit.js';

const options = { hourlyLimit: 2, intervalMs: 50, leaseMs: 2000 };

async function redisTime(redis: Redis): Promise<number> {
  const [seconds, microseconds] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
}

async function fixture(t: TestContext) {
  const prefix = `test:{send-gate-${randomUUID()}}`;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const clients = Array.from({ length: 2 }, () => new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  }));
  const [redis, peer] = clients as [Redis, Redis];
  // Connection failures should fail the opted-in test, not become unhandled events.
  for (const client of clients) client.on('error', () => {});
  t.after(async () => {
    try {
      const connected = clients.find((client) => client.status === 'ready');
      if (connected) {
        const keys = new Set<string>();
        let cursor = '0';
        do {
          const page = await connected.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
          cursor = page[0];
          for (const key of page[1]) keys.add(key);
        } while (cursor !== '0');
        // Never delete keys outside this test's unique namespace.
        if (keys.size) await connected.del(...keys);
      }
    } finally {
      for (const client of clients) client.disconnect();
    }
  });
  await Promise.all(clients.map((client) => client.connect()));
  return {
    redis,
    peer,
    prefix,
    gate: new SendGate(redis, options, prefix),
    peerGate: new SendGate(peer, options, prefix),
  };
}

async function acquireAfterGap(gate: SendGate, senderId: string) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const slot = await gate.acquire(senderId);
    if (slot.token) return slot;
    assert.ok(slot.waitMs > 0 && slot.waitMs <= options.intervalMs,
      `Expected only a minimum-gap wait, received ${slot.waitMs}ms`);
    await sleep(slot.waitMs + 5);
  }
  assert.fail('Send gate did not reopen after the minimum gap');
}

describe('SendGate with real Redis', {
  skip: process.env.RUN_INTEGRATION !== '1' ? 'Set RUN_INTEGRATION=1 to use Redis' : false,
  timeout: 15_000,
}, () => {
  it('shares a global lock across clients and senders', async (t) => {
    const { redis, peer, prefix, gate, peerGate } = await fixture(t);
    const owner = await gate.acquire('sender-a');
    assert.ok(owner.token);
    assert.equal(owner.waitMs, 0);
    assert.equal(await peer.get(`${prefix}:lock`), owner.token);

    const blocked = await peerGate.acquire('sender-b');
    assert.equal(blocked.token, '');
    assert.ok(blocked.waitMs > 0 && blocked.waitMs <= 1000);
    assert.equal(await redis.exists(`${prefix}:sender:sender-b`), 0);
    await peerGate.release(owner.token);
    assert.equal(await redis.exists(`${prefix}:lock`), 0);
    assert.ok((await acquireAfterGap(gate, 'sender-b')).token);
  });

  it('starts the global minimum gap at release and does not extend it on denial', async (t) => {
    const { redis, prefix, gate, peerGate } = await fixture(t);
    const owner = await gate.acquire('sender-a');
    assert.ok(owner.token);
    const beforeRelease = await redisTime(redis);
    await gate.release(owner.token);
    const afterRelease = await redisTime(redis);
    const nextAt = Number(await redis.get(`${prefix}:next`));
    assert.ok(nextAt >= beforeRelease + options.intervalMs);
    assert.ok(nextAt <= afterRelease + options.intervalMs);
    assert.equal(await redis.exists(`${prefix}:lock`), 0);

    const attempt = await peerGate.acquire('sender-b');
    if (attempt.token) {
      // A heavily loaded runner may have already spent the entire 50ms gap.
      assert.ok(await redisTime(redis) >= nextAt);
    } else {
      assert.ok(attempt.waitMs > 0 && attempt.waitMs <= options.intervalMs);
      assert.equal(Number(await redis.get(`${prefix}:next`)), nextAt);
      assert.equal(await redis.exists(`${prefix}:sender:sender-b`), 0);
      assert.ok((await acquireAfterGap(peerGate, 'sender-b')).token);
    }
  });

  it('enforces per-sender hourly quota, returns a reschedule delay, and resets next hour', async (t) => {
    const { redis, prefix, gate, peerGate } = await fixture(t);
    const senderKey = `${prefix}:sender:sender-a`;
    const first = await gate.acquire('sender-a');
    assert.ok(first.token);
    await gate.release(first.token);
    const second = await acquireAfterGap(peerGate, 'sender-a');
    await peerGate.release(second.token);
    await sleep(options.intervalMs + 10);

    const beforeDenied = await redisTime(redis);
    const denied = await gate.acquire('sender-a');
    const afterDenied = await redisTime(redis);
    assert.equal(denied.token, '');
    const hour = Number(await redis.hget(senderKey, 'hour'));
    const nextHour = (hour + 1) * 3_600_000;
    assert.ok(denied.waitMs >= nextHour - afterDenied);
    assert.ok(denied.waitMs <= nextHour - beforeDenied);
    assert.equal(await redis.hget(senderKey, 'count'), '2');
    assert.equal(await redis.exists(`${prefix}:lock`), 0);

    const otherSender = await peerGate.acquire('sender-b');
    assert.ok(otherSender.token, 'An exhausted sender must not consume another sender’s quota');
    await peerGate.release(otherSender.token);
    // Simulate the next quota window without sleeping for an hour.
    const currentHour = Math.floor(await redisTime(redis) / 3_600_000);
    await redis.hset(senderKey, 'hour', currentHour - 1);
    const reset = await acquireAfterGap(gate, 'sender-a');
    assert.ok(reset.token);
    assert.equal(await redis.hget(senderKey, 'count'), '1');
    assert.equal(Number(await redis.hget(senderKey, 'hour')), Math.floor(await redisTime(redis) / 3_600_000));
    assert.ok(await redis.pttl(senderKey) > 0);
  });

  it('allows exactly one of many parallel acquires and charges only the winner', async (t) => {
    const { redis, prefix, gate, peerGate } = await fixture(t);
    const attempts = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      (index % 2 ? gate : peerGate).acquire('sender-a')));
    const winners = attempts.filter((slot) => slot.token);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]!.waitMs, 0);
    for (const loser of attempts.filter((slot) => !slot.token)) {
      assert.ok(loser.waitMs > 0 && loser.waitMs <= 1000);
    }
    assert.equal(await redis.get(`${prefix}:lock`), winners[0]!.token);
    assert.equal(await redis.hget(`${prefix}:sender:sender-a`, 'count'), '1');
  });

  it('ignores an unknown release token without changing the owner or cooldown', async (t) => {
    const { redis, prefix, gate, peerGate } = await fixture(t);
    const owner = await gate.acquire('sender-a');
    assert.ok(owner.token);
    await peerGate.release(randomUUID());
    assert.equal(await redis.get(`${prefix}:lock`), owner.token);
    assert.equal(await redis.exists(`${prefix}:next`), 0);
    assert.equal((await peerGate.acquire('sender-b')).token, '');
  });

  it('does not let an expired owner release a replacement owner’s lock', async (t) => {
    const { redis, prefix, gate, peerGate } = await fixture(t);
    const stale = await gate.acquire('sender-a');
    assert.ok(stale.token);
    await redis.pexpire(`${prefix}:lock`, 1);
    await sleep(20);
    const owner = await peerGate.acquire('sender-b');
    assert.ok(owner.token);
    assert.notEqual(owner.token, stale.token);
    await gate.release(stale.token);
    assert.equal(await redis.get(`${prefix}:lock`), owner.token);
    assert.equal(await redis.exists(`${prefix}:next`), 0);
    assert.equal((await gate.acquire('sender-c')).token, '');
  });

  it('recovers when a client abandons its lease without releasing', async (t) => {
    const { redis, prefix, gate, peerGate } = await fixture(t);
    const abandoned = await gate.acquire('sender-a');
    assert.ok(abandoned.token);
    const ttl = await redis.pttl(`${prefix}:lock`);
    assert.ok(ttl > 0 && ttl <= options.leaseMs);
    assert.equal((await peerGate.acquire('sender-b')).token, '');
    await sleep(ttl + 25);
    const replacement = await peerGate.acquire('sender-b');
    assert.ok(replacement.token);
    assert.equal(replacement.waitMs, 0);
    assert.notEqual(replacement.token, abandoned.token);
    assert.equal(await redis.get(`${prefix}:lock`), replacement.token);
  });
});
