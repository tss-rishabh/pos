import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { MultiCommand, MultiReply, RedisPort, RedisScript, SetOptions } from './port.js';

type Client = ReturnType<typeof createClient>;
const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const reply = z.union([z.string(), z.number(), z.null()]);

/** Exact SET argument order: SET key value [NX|XX] [EX s|PX ms|KEEPTTL]. */
export function setArguments(key: string, value: string, options: SetOptions = {}): string[] {
  const args = ['SET', key, value];
  if (options.NX) args.push('NX');
  if (options.XX) args.push('XX');
  if (options.EX !== undefined) args.push('EX', String(options.EX));
  if (options.PX !== undefined) args.push('PX', String(options.PX));
  if (options.KEEPTTL) args.push('KEEPTTL');
  return args;
}
export function multiArguments(command: MultiCommand): string[] {
  switch (command.command) {
    case 'SET':
      return setArguments(command.key, command.value, command.options);
    case 'INCR':
      return ['INCR', command.key];
    case 'DEL':
      return ['DEL', ...command.keys];
    case 'LREM':
      return ['LREM', command.key, String(command.count), command.value];
    case 'LPUSH':
      return ['LPUSH', command.key, command.value];
    case 'EXPIRE':
      return ['EXPIRE', command.key, String(command.seconds)];
  }
}
/**
 * Validates the connection URL. The authentication store is legacy `redis_instance`
 * database 0 (POSAdmin/redis.py), so only database 0 is accepted. Remote hosts need TLS.
 */
export function assertRedisUrl(
  connectionUrl: string,
  environment: 'development' | 'test' | 'production',
): void {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw invalid();
  }
  const local = loopback.includes(url.hostname);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    !['', '/', '/0'].includes(url.pathname) ||
    (!local && url.protocol !== 'rediss:') ||
    (environment === 'production' && !local && url.protocol !== 'rediss:')
  )
    throw invalid();
}
const invalid = () =>
  new AppError(
    503,
    'AUTH_STORE_CONFIGURATION_INVALID',
    'Configure the POS authentication Redis (database 0, TLS for remote hosts).',
  );
const unavailable = () =>
  new AppError(
    503,
    'AUTH_STORE_UNAVAILABLE',
    'Sign-in is temporarily unavailable. Try again in a moment.',
  );
/**
 * One lazily connected client. Connection and command errors are replaced by a fixed
 * AppError: Redis error text can carry connection credentials and must never be logged.
 */
export function connectRedisPort(
  connectionUrl: string,
  environment: 'development' | 'test' | 'production',
): RedisPort {
  assertRedisUrl(connectionUrl, environment);
  let client: Client | undefined, ready: Promise<Client> | undefined;
  const scripts = new Map<string, string>();
  function reset(connection: Client) {
    if (connection.isOpen) connection.destroy();
    if (client === connection) {
      client = undefined;
      ready = undefined;
    }
  }
  async function command<T>(run: (connection: Client) => Promise<T>): Promise<T> {
    if (!client) {
      client = createClient({
        url: connectionUrl,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 100,
        socket: { connectTimeout: 1500, reconnectStrategy: false },
      });
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
      return await run(connection);
    } catch (error) {
      if (error instanceof AppError) throw error;
      reset(connection);
      throw unavailable();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  const send = (args: readonly string[]) => command((c) => c.sendCommand([...args]));
  const integer = (value: unknown) => {
    const parsed = z.number().int().safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  };
  const text = (value: unknown) => {
    const parsed = z.string().nullable().safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  };
  return {
    get: async (key) => text(await send(['GET', key])),
    async mGet(keys) {
      if (!keys.length) return [];
      const parsed = z.array(z.string().nullable()).safeParse(await send(['MGET', ...keys]));
      if (!parsed.success) throw unavailable();
      return parsed.data;
    },
    set: async (key, value, options) =>
      text(await send(setArguments(key, value, options))) === 'OK',
    del: async (keys) => (keys.length ? integer(await send(['DEL', ...keys])) : 0),
    exists: async (key) => integer(await send(['EXISTS', key])) === 1,
    pTtl: async (key) => integer(await send(['PTTL', key])),
    async multi(commands) {
      if (!commands.length) return [];
      const replies = await command((c) => {
        const transaction = c.multi();
        for (const entry of commands) transaction.addCommand(multiArguments(entry));
        return transaction.exec();
      });
      const parsed = z.array(reply).safeParse(replies);
      if (!parsed.success || parsed.data.length !== commands.length) throw unavailable();
      return parsed.data satisfies MultiReply[];
    },
    async scanKeys(pattern) {
      const keys = new Set<string>();
      let cursor = '0';
      do {
        const parsed = z
          .tuple([z.string(), z.array(z.string())])
          .safeParse(await send(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']));
        if (!parsed.success) throw unavailable();
        cursor = parsed.data[0];
        for (const key of parsed.data[1]) keys.add(key);
        if (keys.size > 100_000) throw unavailable();
      } while (cursor !== '0');
      return [...keys];
    },
    lRem: async (key, count, value) => integer(await send(['LREM', key, String(count), value])),
    async lRange(key, start, stop) {
      const parsed = z
        .array(z.string())
        .safeParse(await send(['LRANGE', key, String(start), String(stop)]));
      if (!parsed.success) throw unavailable();
      return parsed.data;
    },
    async run<Result>(
      script: RedisScript<Result>,
      keys: readonly string[],
      args: readonly string[],
    ) {
      let sha = scripts.get(script.name);
      if (!sha) {
        sha = createHash('sha1').update(script.lua).digest('hex');
        scripts.set(script.name, sha);
      }
      const digest = sha;
      const raw = await command(async (c) => {
        const call = [String(keys.length), ...keys, ...args];
        try {
          return await c.sendCommand(['EVALSHA', digest, ...call]);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('NOSCRIPT'))
            return c.sendCommand(['EVAL', script.lua, ...call]);
          throw error;
        }
      });
      try {
        return script.parse(raw);
      } catch {
        throw unavailable();
      }
    },
    async close() {
      if (client) reset(client);
    },
  };
}
/** Used when REDIS_URL is not configured outside production: every call is a clear 503. */
export function unavailableRedisPort(): RedisPort {
  const fail = async (): Promise<never> => {
    throw new AppError(
      503,
      'AUTH_STORE_UNAVAILABLE',
      'Sign-in is unavailable: the POS authentication Redis (REDIS_URL) is not configured.',
    );
  };
  return {
    get: fail,
    mGet: fail,
    set: fail,
    del: fail,
    exists: fail,
    pTtl: fail,
    multi: fail,
    scanKeys: fail,
    lRem: fail,
    lRange: fail,
    run: fail,
    async close() {},
  };
}
