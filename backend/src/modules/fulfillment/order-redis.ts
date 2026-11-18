import { createClient } from 'redis';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';

/**
 * Narrow Redis surface shared by the order, fulfilment and invoice modules (W5).
 *
 * Every method maps one-to-one onto a Redis command so the in-process twin below has the
 * same semantics. Method names and option shapes match `RedisPort` from the auth Redis
 * port, so the primary agent can pass that port here once both are merged.
 *
 * Key conventions: legacy key names are reused verbatim where the flow is the legacy flow
 * (`express_reject_lock:{store}`, `check_in_{uid}`, `check_in_list_{store}`); rewrite-only
 * keys use the `pos:` prefix. Production Redis runs with `maxmemory-policy noeviction`.
 */
export interface OrderRedisSetOptions {
  EX?: number;
  PX?: number;
  NX?: true;
}
export interface OrderRedis {
  get(key: string): Promise<string | null>;
  /** True when Redis replied OK (false for an NX miss). */
  set(key: string, value: string, options?: OrderRedisSetOptions): Promise<boolean>;
  del(keys: readonly string[]): Promise<number>;
  /** Deletes the key only while it still holds `token` (lock release by token compare). */
  compareAndDelete(key: string, token: string): Promise<boolean>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  close(): Promise<void>;
}

const compareAndDeleteLua = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];

const unavailable = () =>
  new AppError(
    503,
    'ORDER_CACHE_UNAVAILABLE',
    'The order service cache is unavailable. Try again shortly.',
  );

/** Accepts only redis/rediss URLs; remote hosts and production need TLS. */
export function assertOrderRedisUrl(connectionUrl: string, environment: Config['NODE_ENV']): void {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw invalidConfiguration();
  }
  const local = loopback.includes(url.hostname);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    (!local && url.protocol !== 'rediss:') ||
    (environment === 'production' && !local && url.protocol !== 'rediss:')
  )
    throw invalidConfiguration();
}
const invalidConfiguration = () =>
  new AppError(
    503,
    'ORDER_CACHE_CONFIGURATION_INVALID',
    'Configure the POS Redis with TLS for remote hosts.',
  );

/**
 * One lazily connected node-redis client. Connection and command failures become a fixed
 * AppError: Redis error text can carry credentials and is never logged or returned.
 */
export function nodeOrderRedis(config: Pick<Config, 'REDIS_URL' | 'NODE_ENV'>): OrderRedis {
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
    if (!config.REDIS_URL) throw unavailable();
    if (!client) {
      assertOrderRedisUrl(config.REDIS_URL, config.NODE_ENV);
      client = createClient({
        url: config.REDIS_URL,
        disableOfflineQueue: true,
        socket: { connectTimeout: 5000, reconnectStrategy: false },
      });
      // Redis errors can contain connection credentials. Only fixed AppError codes escape.
      client.on('error', () => {});
      const connection = client;
      ready = connection.connect().then(() => connection);
    }
    const connection = client;
    try {
      await ready;
      return await run(connection);
    } catch {
      reset(connection);
      throw unavailable();
    }
  }
  return {
    async get(key) {
      const value = await command((c) => c.get(key));
      return typeof value === 'string' ? value : null;
    },
    async set(key, value, options = {}) {
      const result = await command((c) =>
        c.set(key, value, {
          ...(options.NX ? { NX: true as const } : {}),
          ...(options.EX !== undefined ? { EX: options.EX } : {}),
          ...(options.PX !== undefined ? { PX: options.PX } : {}),
        }),
      );
      return result === 'OK';
    },
    async del(keys) {
      if (!keys.length) return 0;
      return Number(await command((c) => c.del([...keys])));
    },
    async compareAndDelete(key, token) {
      const reply = await command((c) =>
        c.eval(compareAndDeleteLua, { keys: [key], arguments: [token] }),
      );
      return reply === 1;
    },
    async lRange(key, start, stop) {
      const values = await command((c) => c.lRange(key, start, stop));
      return values.filter((value): value is string => typeof value === 'string');
    },
    async close() {
      if (client) reset(client);
    },
  };
}

/** In-process twin for tests and local development without Redis. */
export function memoryOrderRedis(clock: () => number = Date.now): OrderRedis & {
  /** Test helper: raw keyspace view. */
  snapshot(): Map<string, string>;
  lPush(key: string, value: string): void;
} {
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  const lists = new Map<string, string[]>();
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, options = {}) {
      if (options.NX && live(key)) return false;
      const ttl = options.EX !== undefined ? options.EX * 1000 : options.PX;
      values.set(key, { value, expiresAt: ttl === undefined ? null : clock() + ttl });
      return true;
    },
    async del(keys) {
      let removed = 0;
      for (const key of keys) {
        if (live(key) && values.delete(key)) removed += 1;
        else if (lists.delete(key)) removed += 1;
      }
      return removed;
    },
    async compareAndDelete(key, token) {
      if (live(key)?.value !== token) return false;
      values.delete(key);
      return true;
    },
    async lRange(key, start, stop) {
      const list = lists.get(key) ?? [];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      return list.slice(start < 0 ? Math.max(0, list.length + start) : start, end);
    },
    async close() {},
    snapshot() {
      const view = new Map<string, string>();
      for (const key of [...values.keys()]) {
        const entry = live(key);
        if (entry) view.set(key, entry.value);
      }
      return view;
    },
    lPush(key, value) {
      lists.set(key, [value, ...(lists.get(key) ?? [])]);
    },
  };
}
