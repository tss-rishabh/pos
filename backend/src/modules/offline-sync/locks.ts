import { createClient } from 'redis';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';

/** Ephemeral offline-sync coordination in Redis (schema freeze: no tables).
 * - lock: short exclusive upload lock per provisional reference.
 * - progress: which checkout session carries the reference until the order
 *   is stamped with orders.order_ref_no (the durable idempotency key). */
export interface OfflineSyncCoordinator {
  lock(reference: string, owner: string, ttlMs: number): Promise<boolean>;
  unlock(reference: string, owner: string): Promise<void>;
  progress(reference: string): Promise<{ checkoutId: string; operatorId: string } | null>;
  saveProgress(
    reference: string,
    value: { checkoutId: string; operatorId: string },
    ttlSeconds: number,
  ): Promise<void>;
  clearProgress(reference: string): Promise<void>;
  close(): Promise<void>;
}

const unlockScript = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
const keys = {
  lock: (reference: string) => `pos_rewrite:offline_sync:lock:${reference}`,
  progress: (reference: string) => `pos_rewrite:offline_sync:progress:${reference}`,
};
const progressSchema = z.object({
  checkoutId: z.uuid(),
  operatorId: z.string().regex(/^[1-9]\d{0,19}$/),
});

export function redisOfflineSyncCoordinator(
  config: Config,
  connectionUrl: string,
): OfflineSyncCoordinator {
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
      'OFFLINE_SYNC_CONFIGURATION_INVALID',
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
        commandsQueueMaxLength: 20,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
      });
      // Redis errors can contain connection credentials. Only fixed AppError codes escape.
      client.on('error', () => {});
      const connection = client;
      ready = connection.connect().then(() => connection);
    }
    const connection = client,
      signal = AbortSignal.timeout(2000),
      abort = () => reset(connection);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await ready;
      return await run(connection.withCommandOptions({ timeout: 1500, abortSignal: signal }));
    } catch {
      reset(connection);
      throw new AppError(
        503,
        'OFFLINE_SYNC_IN_PROGRESS',
        'Offline sale sync is temporarily unavailable. It will retry automatically.',
      );
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    async lock(reference, owner, ttlMs) {
      const result = await command((c) =>
        c.set(keys.lock(reference), owner, { NX: true, PX: ttlMs }),
      );
      return result === 'OK';
    },
    async unlock(reference, owner) {
      await command((c) =>
        c.eval(unlockScript, { keys: [keys.lock(reference)], arguments: [owner] }),
      );
    },
    async progress(reference) {
      const value = await command((c) => c.get(keys.progress(reference)));
      if (typeof value !== 'string') return null;
      try {
        const parsed = progressSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async saveProgress(reference, value, ttlSeconds) {
      await command((c) =>
        c.set(keys.progress(reference), JSON.stringify(progressSchema.parse(value)), {
          EX: ttlSeconds,
        }),
      );
    },
    async clearProgress(reference) {
      await command((c) => c.del(keys.progress(reference)));
    },
    async close() {
      if (client) reset(client);
    },
  };
}
