import rateLimit, { IncrementResponse, Options, Store } from 'express-rate-limit';
import { env } from '../../config/env';
import { ensureRedisReady, getRedisClient } from '../redis';

const isTest = env.NODE_ENV === 'test';

class HybridRedisRateLimitStore implements Store {
  public localKeys = true;
  public prefix: string;
  private windowMs = 60_000;
  private memoryHits = new Map<string, { totalHits: number; resetAtMs: number }>();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const namespaced = `${this.prefix}${key}`;
    if (await ensureRedisReady()) {
      try {
        const client = getRedisClient();
        const totalHits = await client.incr(namespaced);
        if (totalHits === 1) {
          await client.pexpire(namespaced, this.windowMs);
        }
        const ttl = await client.pttl(namespaced);
        const resetTime = new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs));
        return { totalHits, resetTime };
      } catch {
        // Fall through cleanly to local bounded store on transient Redis error
      }
    }

    const now = Date.now();
    const existing = this.memoryHits.get(namespaced);
    if (!existing || existing.resetAtMs <= now) {
      const next = { totalHits: 1, resetAtMs: now + this.windowMs };
      this.memoryHits.set(namespaced, next);
      return { totalHits: next.totalHits, resetTime: new Date(next.resetAtMs) };
    }
    existing.totalHits += 1;
    return { totalHits: existing.totalHits, resetTime: new Date(existing.resetAtMs) };
  }

  async decrement(key: string): Promise<void> {
    const namespaced = `${this.prefix}${key}`;
    if (await ensureRedisReady()) {
      try {
        await getRedisClient().decr(namespaced);
        return;
      } catch {
        // Fallback below
      }
    }
    const existing = this.memoryHits.get(namespaced);
    if (existing && existing.totalHits > 0) {
      existing.totalHits -= 1;
    }
  }

  async resetKey(key: string): Promise<void> {
    const namespaced = `${this.prefix}${key}`;
    this.memoryHits.delete(namespaced);
    if (await ensureRedisReady()) {
      try {
        await getRedisClient().unlink(namespaced);
      } catch {
        // Ignore Redis reset error
      }
    }
  }
}

export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isTest ? 5000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRedisRateLimitStore('rl:global:'),
  message: {
    success: false,
    message: 'Too many requests, please slow down',
    code: 'RATE_LIMIT_EXCEEDED',
    details: [],
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 500 : 25,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  store: new HybridRedisRateLimitStore('rl:auth:'),
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later',
    code: 'AUTH_RATE_LIMIT_EXCEEDED',
    details: [],
  },
});
