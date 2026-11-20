import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';

/**
 * Ephemeral checkout, return and payment state (schema freeze: no tables).
 *
 * Every key written through this port starts with `pos:` unless the flow reuses a legacy
 * key verbatim (for example `{store}_{tab}` salesperson keys). Production Redis runs with
 * `noeviction`, so every key carries a TTL.
 */
export interface PosStateStore {
  get(key: string): Promise<string | null>;
  /** MGET: one value (or null) per key, in key order. */
  getMany(keys: readonly string[]): Promise<(string | null)[]>;
  /** SET with EX. `onlyIfAbsent` is `SET NX`. Returns false when NX did not write. */
  set(key: string, value: string, ttlSeconds: number, onlyIfAbsent?: boolean): Promise<boolean>;
  /** Atomically replaces the value only when the current value equals `expected` (null = absent). */
  compareAndSet(
    key: string,
    expected: string | null,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  /** Deletes the key only when it still holds `expected` (lock release). */
  deleteIfEquals(key: string, expected: string): Promise<boolean>;
  /** INCR with an expiry set on first increment. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  close(): Promise<void>;
}

const casScript = `
local current=redis.call('GET',KEYS[1])
if ARGV[1]=='0' then if current then return 0 end elseif current~=ARGV[2] then return 0 end
redis.call('SET',KEYS[1],ARGV[3],'EX',ARGV[4])
return 1`;
const unlockScript = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
const incrementScript = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;

function unavailable(): AppError {
  return new AppError(
    503,
    'CHECKOUT_STATE_UNAVAILABLE',
    'Checkout is temporarily unavailable. Try again in a moment.',
  );
}

export function redisStateStore(config: Config, connectionUrl: string): PosStateStore {
  const url = new URL(connectionUrl),
    local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    (!local && url.protocol !== 'rediss:') ||
    (config.NODE_ENV === 'production' && url.protocol !== 'rediss:')
  )
    throw new AppError(
      503,
      'CHECKOUT_STATE_CONFIGURATION_INVALID',
      'Configure the POS cache with TLS.',
    );
  let client: ReturnType<typeof createClient> | undefined,
    ready: Promise<ReturnType<typeof createClient>> | undefined;
  function reset(connection: ReturnType<typeof createClient>) {
    if (connection.isOpen) connection.destroy();
    if (client === connection) {
      client = undefined;
      ready = undefined;
    }
  }
  async function command<T>(
    run: (connection: ReturnType<typeof createClient>) => Promise<T>,
  ): Promise<T> {
    if (!client) {
      client = createClient({
        url: connectionUrl,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 200,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
      });
      // Redis errors can contain connection credentials. Only fixed AppError codes escape.
      client.on('error', () => {});
      const connection = client;
      ready = connection.connect().then(() => connection);
    }
    const connection = client,
      signal = AbortSignal.timeout(3000),
      abort = () => reset(connection);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await ready;
      return await run(connection.withCommandOptions({ timeout: 2500, abortSignal: signal }));
    } catch {
      reset(connection);
      throw unavailable();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    async get(key) {
      const value = await command((c) => c.get(key));
      return typeof value === 'string' ? value : null;
    },
    async getMany(keys) {
      if (!keys.length) return [];
      const values = await command((c) => c.mGet([...keys]));
      return keys.map((_, index) => {
        const value = values[index];
        return typeof value === 'string' ? value : null;
      });
    },
    async set(key, value, ttlSeconds, onlyIfAbsent = false) {
      const result = await command((c) =>
        c.set(key, value, onlyIfAbsent ? { EX: ttlSeconds, NX: true } : { EX: ttlSeconds }),
      );
      return result === 'OK';
    },
    async compareAndSet(key, expected, value, ttlSeconds) {
      const result = await command((c) =>
        c.eval(casScript, {
          keys: [key],
          arguments: [expected === null ? '0' : '1', expected ?? '', value, String(ttlSeconds)],
        }),
      );
      return Number(result) === 1;
    },
    async del(...keys) {
      if (keys.length) await command((c) => c.del(keys));
    },
    async deleteIfEquals(key, expected) {
      const result = await command((c) =>
        c.eval(unlockScript, { keys: [key], arguments: [expected] }),
      );
      return Number(result) === 1;
    },
    async increment(key, ttlSeconds) {
      const result = await command((c) =>
        c.eval(incrementScript, { keys: [key], arguments: [String(ttlSeconds)] }),
      );
      return Number(result);
    },
    async close() {
      if (client) reset(client);
    },
  };
}

/** Single-process store for tests and local development without Redis. */
export function memoryStateStore(now: () => number = Date.now): PosStateStore & {
  entries(): Map<string, { value: string; expiresAt: number }>;
} {
  const data = new Map<string, { value: string; expiresAt: number }>();
  function live(key: string) {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      data.delete(key);
      return null;
    }
    return entry;
  }
  return {
    entries: () => data,
    async get(key) {
      return live(key)?.value ?? null;
    },
    async getMany(keys) {
      return keys.map((key) => live(key)?.value ?? null);
    },
    async set(key, value, ttlSeconds, onlyIfAbsent = false) {
      if (onlyIfAbsent && live(key)) return false;
      data.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    async compareAndSet(key, expected, value, ttlSeconds) {
      const current = live(key)?.value ?? null;
      if (current !== expected) return false;
      data.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    async del(...keys) {
      for (const key of keys) data.delete(key);
    },
    async deleteIfEquals(key, expected) {
      if (live(key)?.value !== expected) return false;
      data.delete(key);
      return true;
    },
    async increment(key, ttlSeconds) {
      const current = live(key);
      const next = (current ? Number(current.value) : 0) + 1;
      data.set(key, {
        value: String(next),
        expiresAt: current ? current.expiresAt : now() + ttlSeconds * 1000,
      });
      return next;
    },
    async close() {},
  };
}

/** Reads a JSON value. An unreadable value is an error, never treated as absent. */
export async function readJson<T>(
  store: PosStateStore,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  return parseStoredJson(await store.get(key), schema);
}

/** `readJson` for several keys in one MGET round trip; results follow key order. */
export async function readJsonMany<T>(
  store: PosStateStore,
  keys: readonly string[],
  schema: z.ZodType<T>,
): Promise<(T | null)[]> {
  return (await store.getMany(keys)).map((raw) => parseStoredJson(raw, schema));
}

function parseStoredJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(
      500,
      'CHECKOUT_STATE_UNREADABLE',
      'Saved checkout state could not be read. Contact support before retrying.',
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new AppError(
      500,
      'CHECKOUT_STATE_UNREADABLE',
      'Saved checkout state could not be read. Contact support before retrying.',
    );
  return result.data;
}

/**
 * Exclusive section, the Redis counterpart of a MySQL `FOR UPDATE` row lock.
 * `SET NX PX` with a random token checked on release (legacy precedent: order/tasks.py:152).
 */
export async function withStateLock<T>(
  store: PosStateStore,
  key: string,
  run: () => Promise<T>,
  options: { ttlSeconds?: number; waitMs?: number; busy?: () => AppError } = {},
): Promise<T> {
  const token = randomUUID(),
    ttl = options.ttlSeconds ?? 120,
    deadline = Date.now() + (options.waitMs ?? 3000);
  for (;;) {
    if (await store.set(key, token, ttl, true)) break;
    if (Date.now() >= deadline)
      throw (
        options.busy?.() ??
        new AppError(409, 'CHECKOUT_BUSY', 'Another action on this sale is still running.')
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    return await run();
  } finally {
    await store.deleteIfEquals(key, token).catch(() => undefined);
  }
}

/** Idempotency receipt `pos:idem:{scope}:{actorId}:{key}` (table-disposition.md conventions). */
export const idempotencyKey = (scope: string, actorId: string, key: string) =>
  `pos:idem:${scope}:${actorId}:${key}`;

const configuredStores = new Map<string, PosStateStore>();
/**
 * The process-wide store for `config.REDIS_URL` (one lazily connected client per URL). Without
 * REDIS_URL outside production, one shared in-memory store, so every module sees the same sales.
 */
export function configuredStateStore(config: Config): PosStateStore {
  const key = config.REDIS_URL ?? 'memory:';
  const existing = configuredStores.get(key);
  if (existing) return existing;
  if (!config.REDIS_URL && config.NODE_ENV === 'production')
    throw new Error('Production requires REDIS_URL for checkout state.');
  const created = config.REDIS_URL ? redisStateStore(config, config.REDIS_URL) : memoryStateStore();
  configuredStores.set(key, created);
  return created;
}

/**
 * The store the application configured first (app.ts creates it at startup), for call sites
 * outside W4 that cannot pass one yet (offline-sync constructs `paymentService` with two
 * arguments). Falls back to the shared in-memory store outside production.
 */
export function sharedStateStore(): PosStateStore {
  const first = configuredStores.values().next();
  if (!first.done) return first.value;
  if (process.env.NODE_ENV === 'production')
    throw new Error('Production requires the configured checkout state store.');
  const created = memoryStateStore();
  configuredStores.set('memory:', created);
  return created;
}
