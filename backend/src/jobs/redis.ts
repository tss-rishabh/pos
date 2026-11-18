import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { AppError } from '../domain/errors.js';

/**
 * Minimal Redis transport shared by the job queue and the W8 modules' ephemeral state.
 * Every command goes through `send`, so the queue and state code depend on exact Redis
 * commands and Lua only (phase-c-legacy-jobs.md §4.1), never on a library abstraction.
 */
export interface RedisCommands {
  send(args: readonly string[], options?: { timeoutMs?: number }): Promise<unknown>;
  /** EVALSHA with an EVAL fallback on NOSCRIPT. */
  evalScript(lua: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
  close(): Promise<void>;
}

type Client = ReturnType<typeof createClient>;
const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** Same rules as the other Redis adapters: redis:// only on loopback, TLS elsewhere. */
export function assertRedisUrl(
  connectionUrl: string,
  environment: 'development' | 'test' | 'production',
): void {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw invalidRedis();
  }
  const local = loopback.includes(url.hostname);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    (!local && url.protocol !== 'rediss:') ||
    (environment === 'production' && !local && url.protocol !== 'rediss:')
  )
    throw invalidRedis();
}
const invalidRedis = () =>
  new AppError(503, 'REDIS_CONFIGURATION_INVALID', 'Configure the POS Redis with TLS.');
export const redisUnavailable = () =>
  new AppError(503, 'REDIS_UNAVAILABLE', 'The POS cache is temporarily unavailable. Try again.');

/**
 * One lazily connected client per call site. Connection and command errors are replaced by a
 * fixed AppError because Redis error text can carry connection credentials.
 * Blocking commands (BLMOVE) need their own `connectRedis` instance.
 */
export function connectRedis(
  connectionUrl: string,
  environment: 'development' | 'test' | 'production',
): RedisCommands {
  assertRedisUrl(connectionUrl, environment);
  let client: Client | undefined, ready: Promise<Client> | undefined;
  const digests = new Map<string, string>();
  function reset(connection: Client) {
    if (connection.isOpen) connection.destroy();
    if (client === connection) {
      client = undefined;
      ready = undefined;
    }
  }
  async function command<T>(run: (connection: Client) => Promise<T>, timeoutMs: number) {
    if (!client) {
      client = createClient({
        url: connectionUrl,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 200,
        socket: { connectTimeout: 2000, reconnectStrategy: false },
      });
      client.on('error', () => {});
      const connection = client;
      ready = connection.connect().then(() => connection);
    }
    const connection = client,
      signal = AbortSignal.timeout(timeoutMs),
      abort = () => reset(connection);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await ready;
      return await run(connection);
    } catch (error) {
      if (error instanceof AppError) throw error;
      reset(connection);
      throw redisUnavailable();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    send: (args, options) => command((c) => c.sendCommand([...args]), options?.timeoutMs ?? 3000),
    evalScript(lua, keys, args) {
      let digest = digests.get(lua);
      if (!digest) {
        digest = createHash('sha1').update(lua).digest('hex');
        digests.set(lua, digest);
      }
      const sha = digest,
        call = [String(keys.length), ...keys, ...args];
      return command(async (c) => {
        try {
          return await c.sendCommand(['EVALSHA', sha, ...call]);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('NOSCRIPT'))
            return c.sendCommand(['EVAL', lua, ...call]);
          throw error;
        }
      }, 3000);
    },
    async close() {
      const connection = client;
      client = undefined;
      ready = undefined;
      if (connection?.isOpen) await connection.close().catch(() => connection.destroy());
    },
  };
}
