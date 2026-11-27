import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

let redisClient: Redis | null = null;
let redisHealthy = false;
let lastFailureAt = 0;

const CACHE_PREFIX = 'marketsphere:';
const RECONNECT_COOLDOWN_MS = 30_000;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 400,
      enableOfflineQueue: false,
      retryStrategy(times) {
        if (times > 1) {
          return null;
        }
        return 150;
      },
    });

    redisClient.on('ready', () => {
      redisHealthy = true;
      lastFailureAt = 0;
      logger.info('Redis connection ready');
    });

    redisClient.on('error', (err) => {
      redisHealthy = false;
      lastFailureAt = Date.now();
      logger.warn({ err: err.message }, 'Redis connection error');
    });

    redisClient.on('close', () => {
      redisHealthy = false;
    });
  }
  return redisClient;
}

export async function pingRedis(force = true): Promise<boolean> {
  if (!force && !redisHealthy && Date.now() - lastFailureAt < RECONNECT_COOLDOWN_MS) {
    return false;
  }
  try {
    const client = getRedisClient();
    if (client.status === 'wait' || client.status === 'end' || client.status === 'close') {
      await client.connect();
    }
    const pong = await client.ping();
    redisHealthy = pong === 'PONG';
    if (redisHealthy) lastFailureAt = 0;
    return redisHealthy;
  } catch {
    redisHealthy = false;
    lastFailureAt = Date.now();
    return false;
  }
}

export function isRedisHealthy(): boolean {
  return redisHealthy;
}

export async function ensureRedisReady(): Promise<boolean> {
  if (redisHealthy) return true;
  if (lastFailureAt > 0 && Date.now() - lastFailureAt < RECONNECT_COOLDOWN_MS) {
    return false;
  }
  return pingRedis(false);
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (!(await ensureRedisReady())) return null;
  try {
    const raw = await getRedisClient().get(`${CACHE_PREFIX}${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds = 60): Promise<boolean> {
  if (!(await ensureRedisReady())) return false;
  try {
    await getRedisClient().set(`${CACHE_PREFIX}${key}`, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

export async function cacheDeletePrefix(prefix: string): Promise<number> {
  if (!(await ensureRedisReady())) return 0;
  try {
    const client = getRedisClient();
    const pattern = `${CACHE_PREFIX}${prefix}*`;
    let deleted = 0;
    const keys: string[] = [];
    await new Promise<void>((resolve) => {
      const stream = client.scanStream({ match: pattern, count: 100 });
      stream.on('data', (batch: string[]) => {
        for (const k of batch) keys.push(k);
      });
      stream.on('end', () => resolve());
      stream.on('error', () => resolve());
    });
    if (keys.length > 0) {
      deleted = await client.unlink(...keys);
    }
    return deleted;
  } catch {
    return 0;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      if (redisClient.status === 'ready') {
        await redisClient.quit();
      } else {
        redisClient.disconnect();
      }
    } catch {
      redisClient.disconnect();
    }
    redisClient = null;
    redisHealthy = false;
  }
}
