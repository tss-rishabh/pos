import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { redisUnavailable, type RedisCommands } from './redis.js';

/**
 * Ephemeral state for the W8 modules (schema freeze: no tables). Locks, idempotency
 * receipts, cooldowns and legacy keys such as `check_in_{uid}` live here.
 * Production Redis is `noeviction`; every key written here carries a TTL unless the legacy
 * key it mirrors has none.
 */
export interface SetOptions {
  NX?: boolean;
  XX?: boolean;
  EX?: number;
  PX?: number;
  KEEPTTL?: boolean;
}
export interface EphemeralStore {
  get(key: string): Promise<string | null>;
  /** Returns true when Redis replied OK (false when NX/XX prevented the write). */
  set(key: string, value: string, options?: SetOptions): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  /** Compare-and-delete in Lua: releases a lock only if this owner still holds it. */
  delIfEquals(key: string, value: string): Promise<boolean>;
  expire(key: string, seconds: number): Promise<boolean>;
  /** Remaining TTL in seconds (-1 without TTL, -2 when absent). */
  ttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  lPush(key: string, ...values: string[]): Promise<number>;
  lRem(key: string, count: number, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  /** SCAN MATCH; bounded to 100 000 keys. */
  scanKeys(pattern: string): Promise<string[]>;
}

export function setArguments(key: string, value: string, options: SetOptions = {}): string[] {
  const args = ['SET', key, value];
  if (options.NX) args.push('NX');
  if (options.XX) args.push('XX');
  if (options.EX !== undefined) args.push('EX', String(options.EX));
  if (options.PX !== undefined) args.push('PX', String(options.PX));
  if (options.KEEPTTL) args.push('KEEPTTL');
  return args;
}
const compareAndDelete = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const integer = (value: unknown) => {
  const parsed = z.number().int().safeParse(value);
  if (!parsed.success) throw redisUnavailable();
  return parsed.data;
};
const text = (value: unknown) => {
  const parsed = z.string().nullable().safeParse(value);
  if (!parsed.success) throw redisUnavailable();
  return parsed.data;
};
const texts = (value: unknown) => {
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success) throw redisUnavailable();
  return parsed.data;
};

export function redisEphemeralStore(redis: RedisCommands): EphemeralStore {
  return {
    get: async (key) => text(await redis.send(['GET', key])),
    set: async (key, value, options) =>
      text(await redis.send(setArguments(key, value, options))) === 'OK',
    del: async (...keys) => (keys.length ? integer(await redis.send(['DEL', ...keys])) : 0),
    delIfEquals: async (key, value) =>
      integer(await redis.evalScript(compareAndDelete, [key], [value])) === 1,
    expire: async (key, seconds) =>
      integer(await redis.send(['EXPIRE', key, String(seconds)])) === 1,
    ttl: async (key) => integer(await redis.send(['TTL', key])),
    incr: async (key) => integer(await redis.send(['INCR', key])),
    lPush: async (key, ...values) => integer(await redis.send(['LPUSH', key, ...values])),
    lRem: async (key, count, value) =>
      integer(await redis.send(['LREM', key, String(count), value])),
    lRange: async (key, start, stop) =>
      texts(await redis.send(['LRANGE', key, String(start), String(stop)])),
    async scanKeys(pattern) {
      const keys = new Set<string>();
      let cursor = '0';
      do {
        const parsed = z
          .tuple([z.string(), z.array(z.string())])
          .safeParse(await redis.send(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']));
        if (!parsed.success) throw redisUnavailable();
        cursor = parsed.data[0];
        for (const key of parsed.data[1]) keys.add(key);
        if (keys.size > 100_000) throw redisUnavailable();
      } while (cursor !== '0');
      return [...keys];
    },
  };
}

/** Store used when Redis is absent outside production (tests, local development). */
export function unavailableEphemeralStore(): EphemeralStore {
  const fail = async (): Promise<never> => {
    throw new AppError(503, 'REDIS_UNAVAILABLE', 'Configure the POS Redis (REDIS_URL).');
  };
  return {
    get: fail,
    set: fail,
    del: fail,
    delIfEquals: fail,
    expire: fail,
    ttl: fail,
    incr: fail,
    lPush: fail,
    lRem: fail,
    lRange: fail,
    scanKeys: fail,
  };
}

/** In-process implementation with the same reply semantics; for tests and local development. */
export function memoryEphemeralStore(now: () => number = Date.now): EphemeralStore {
  const values = new Map<string, { value: string | string[]; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  const list = (key: string) => {
    const entry = live(key);
    if (entry && !Array.isArray(entry.value))
      throw new AppError(500, 'REDIS_WRONGTYPE', 'Wrong Redis value type.');
    return entry;
  };
  const glob = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    );
  return {
    async get(key) {
      const entry = live(key);
      if (entry && Array.isArray(entry.value))
        throw new AppError(500, 'REDIS_WRONGTYPE', 'Wrong Redis value type.');
      return entry ? (entry.value as string) : null;
    },
    async set(key, value, options = {}) {
      const entry = live(key);
      if ((options.NX && entry) || (options.XX && !entry)) return false;
      const expiresAt =
        options.EX !== undefined
          ? now() + options.EX * 1000
          : options.PX !== undefined
            ? now() + options.PX
            : options.KEEPTTL && entry
              ? entry.expiresAt
              : null;
      values.set(key, { value, expiresAt });
      return true;
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) if (live(key) && values.delete(key)) removed++;
      return removed;
    },
    async delIfEquals(key, value) {
      const entry = live(key);
      if (!entry || entry.value !== value) return false;
      values.delete(key);
      return true;
    },
    async expire(key, seconds) {
      const entry = live(key);
      if (!entry) return false;
      entry.expiresAt = now() + seconds * 1000;
      return true;
    },
    async ttl(key) {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - now()) / 1000);
    },
    async incr(key) {
      const entry = live(key);
      const next = (entry ? Number(entry.value) : 0) + 1;
      values.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    async lPush(key, ...items) {
      const entry = list(key) || { value: [] as string[], expiresAt: null };
      const current = entry.value as string[];
      for (const item of items) current.unshift(item);
      values.set(key, entry);
      return current.length;
    },
    async lRem(key, count, value) {
      const entry = list(key);
      if (!entry) return 0;
      const current = entry.value as string[];
      let removed = 0;
      const limit = count === 0 ? Infinity : Math.abs(count);
      const order = count < 0 ? [...current.keys()].reverse() : [...current.keys()];
      const drop = new Set<number>();
      for (const index of order)
        if (removed < limit && current[index] === value) {
          drop.add(index);
          removed++;
        }
      entry.value = current.filter((_item, index) => !drop.has(index));
      if (!(entry.value as string[]).length) values.delete(key);
      return removed;
    },
    async lRange(key, start, stop) {
      const entry = list(key);
      if (!entry) return [];
      const current = entry.value as string[];
      const from = start < 0 ? Math.max(current.length + start, 0) : start;
      const to = stop < 0 ? current.length + stop : Math.min(stop, current.length - 1);
      return current.slice(from, to + 1);
    },
    async scanKeys(pattern) {
      const matcher = glob(pattern);
      return [...values.keys()].filter((key) => live(key) && matcher.test(key));
    },
  };
}

/**
 * Redis lease lock (legacy precedent `express_reject_lock:{store}`, order/tasks.py:152).
 * Acquire before the MySQL transaction and release after commit; returns null when held.
 */
export async function withEphemeralLock<T>(
  store: EphemeralStore,
  key: string,
  ttlMs: number,
  run: () => Promise<T>,
): Promise<{ value: T } | null> {
  const token = randomUUID();
  if (!(await store.set(key, token, { NX: true, PX: ttlMs }))) return null;
  try {
    return { value: await run() };
  } finally {
    await store.delIfEquals(key, token).catch(() => false);
  }
}
