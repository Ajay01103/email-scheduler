import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deliveryMetrics, summarize } from '../scripts/stress/metrics.js';

const emptySummary = { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
const origin = Date.parse('2026-01-01T00:00:00.000Z');
const at = (milliseconds: number) => new Date(origin + milliseconds);

function row(status: string, scheduledMs: number, sentMs: number | null, attempts = 1) {
  return {
    scheduledAt: at(scheduledMs),
    sentAt: sentMs === null ? null : at(sentMs),
    status,
    attempts,
  };
}

describe('summarize', () => {
  it('returns all zeros for an empty sample', () => {
    assert.deepEqual(summarize([]), emptySummary);
  });

  it('returns the single value for every statistic', () => {
    assert.deepEqual(summarize([7]), {
      count: 1, min: 7, max: 7, mean: 7, p50: 7, p95: 7, p99: 7,
    });
  });

  it('sorts numerically without mutating the input and uses nearest rank', () => {
    const values = [100, -2, 10, 2];
    assert.deepEqual(summarize(values), {
      count: 4, min: -2, max: 100, mean: 27.5, p50: 2, p95: 100, p99: 100,
    });
    assert.deepEqual(values, [100, -2, 10, 2]);
  });

  for (const count of [20, 21, 100, 101]) {
    it(`uses ceil(p * n) - 1 at percentile boundaries for ${count} values`, () => {
      const values = Array.from({ length: count }, (_, index) => count - index);
      const summary = summarize(values);
      assert.equal(summary.p50, Math.ceil(0.5 * count));
      assert.equal(summary.p95, Math.ceil(0.95 * count));
      assert.equal(summary.p99, Math.ceil(0.99 * count));
    });
  }
});

describe('deliveryMetrics', () => {
  it('returns zero counts, lag, span, and throughput for no rows', () => {
    assert.deepEqual(deliveryMetrics([]), {
      sent: 0,
      failed: 0,
      uncertain: 0,
      scheduled: 0,
      sending: 0,
      totalAttempts: 0,
      earlyDeliveries: 0,
      lagMs: emptySummary,
      drainSeconds: 0,
      throughputPerSecond: 0,
      throughputPerMinute: 0,
    });
  });

  it('counts statuses and all attempts, but measures only sent rows', () => {
    const rows = [
      row('sent', 1000, 999, 2),
      { ...row('sent', 1000, 1000), scheduledAt: at(1000).toISOString(), sentAt: at(1000).toISOString() },
      row('sent', 1000, 1500, 3),
      row('failed', 1000, 0, 4),
      row('uncertain', 1000, 100000, 5),
      row('scheduled', 1000, null, 0),
      row('sending', 1000, null, 2),
    ];
    const before = structuredClone(rows);

    assert.deepEqual(deliveryMetrics(rows), {
      sent: 3,
      failed: 1,
      uncertain: 1,
      scheduled: 1,
      sending: 1,
      totalAttempts: 17,
      earlyDeliveries: 1,
      lagMs: { count: 3, min: 0, max: 500, mean: 500 / 3, p50: 0, p95: 500, p99: 500 },
      drainSeconds: 0.501,
      throughputPerSecond: 2 / 0.501,
      throughputPerMinute: (2 / 0.501) * 60,
    });
    assert.deepEqual(rows, before);
  });

  it('uses the first-to-last completion span and count minus one, not row order or schedule time', () => {
    const metrics = deliveryMetrics([
      row('sent', -60000, 6000),
      row('sent', -60000, 1000),
      row('sent', -60000, 3000),
    ]);
    assert.equal(metrics.drainSeconds, 5);
    assert.equal(metrics.throughputPerSecond, 2 / 5);
    assert.equal(metrics.throughputPerMinute, 24);
  });

  it('has zero throughput for a single completion even with positive lag', () => {
    const metrics = deliveryMetrics([row('sent', 0, 5000)]);
    assert.equal(metrics.lagMs.mean, 5000);
    assert.equal(metrics.drainSeconds, 0);
    assert.equal(metrics.throughputPerSecond, 0);
    assert.equal(metrics.throughputPerMinute, 0);
  });

  it('has zero throughput when multiple completions share a timestamp', () => {
    const metrics = deliveryMetrics([row('sent', 0, 5000), row('sent', 1000, 5000)]);
    assert.equal(metrics.sent, 2);
    assert.equal(metrics.drainSeconds, 0);
    assert.equal(metrics.throughputPerSecond, 0);
    assert.equal(metrics.throughputPerMinute, 0);
  });

  it('does not turn null sent timestamps into epoch deliveries', () => {
    const metrics = deliveryMetrics([row('sent', 0, null), row('scheduled', 0, null, 0)]);
    assert.equal(metrics.sent, 1);
    assert.equal(metrics.scheduled, 1);
    assert.equal(metrics.earlyDeliveries, 0);
    assert.deepEqual(metrics.lagMs, emptySummary);
    assert.equal(metrics.drainSeconds, 0);
    assert.equal(metrics.throughputPerSecond, 0);
    assert.equal(metrics.throughputPerMinute, 0);
  });
});
