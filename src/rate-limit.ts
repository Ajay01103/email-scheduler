import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Both scripts use Redis time so application clock skew cannot bypass limits.
// A shared hash tag keeps all keys in one slot if Redis Cluster is introduced.
export const ACQUIRE_SEND_SLOT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lockTtl = redis.call('PTTL', KEYS[1])
if lockTtl > 0 then return {0, math.min(lockTtl, 1000)} end
local nextAt = tonumber(redis.call('GET', KEYS[2]) or '0')
if nextAt > now then return {0, nextAt - now} end
local hour = math.floor(now / 3600000)
local storedHour = tonumber(redis.call('HGET', KEYS[3], 'hour') or '-1')
local count = tonumber(redis.call('HGET', KEYS[3], 'count') or '0')
if storedHour ~= hour then count = 0 end
if count >= tonumber(ARGV[2]) then return {0, (hour + 1) * 3600000 - now} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
redis.call('HSET', KEYS[3], 'hour', hour, 'count', count + 1)
redis.call('PEXPIRE', KEYS[3], 7200000)
return {1, 0}
`;

export const RELEASE_SEND_SLOT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('SET', KEYS[2], now + tonumber(ARGV[2]), 'PX', tonumber(ARGV[2]) + 7200000)
redis.call('DEL', KEYS[1])
return 1
`;

export interface RateLimitOptions { hourlyLimit: number; intervalMs: number; leaseMs: number }
export class SendGate {
  private readonly lock: string;
  private readonly next: string;
  constructor(private readonly redis: Redis, private readonly options: RateLimitOptions, private readonly prefix = 'email:{send-gate}') {
    this.lock = `${prefix}:lock`;
    this.next = `${prefix}:next`;
  }
  async acquire(senderId: string): Promise<{ token: string; waitMs: number }> {
    const token = randomUUID();
    const result = await this.redis.eval(ACQUIRE_SEND_SLOT, 3,
      this.lock, this.next, `${this.prefix}:sender:${senderId}`, token,
      this.options.hourlyLimit, this.options.leaseMs) as [number, number];
    return { token: result[0] === 1 ? token : '', waitMs: result[1] };
  }
  async release(token: string): Promise<void> {
    await this.redis.eval(RELEASE_SEND_SLOT, 2, this.lock, this.next, token, this.options.intervalMs);
  }
}
