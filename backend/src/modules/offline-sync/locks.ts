import { createClient } from 'redis';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';

/** Ephemeral offline-sync state in Redis (schema freeze: no tables).
 * - `pos:offline_sale:<ref>`: idempotency record. `in-flight` is written before
 *   the checkout service is called; `done` with the order and invoice after the
 *   order is created. Kept 30 days. An `in-flight` record without an order is
 *   an unknown outcome and is never resubmitted automatically.
 * - `pos:offline_sale_lock:<ref>`: short exclusive upload lock.
 * - `pos:offline_device_sales:<deviceId>`: hash of the device's recent offline sales
 *   (provisional reference -> billed time, device sequence and first successful sync time),
 *   used to enforce OFFLINE_BILLING_MAX_ORDERS per offline episode on the server. Kept 3 days.
 *
 * These keys must survive a Redis restart and must never be evicted: run Redis with AOF
 * persistence and `maxmemory-policy noeviction` (or a `volatile-*` policy). */
export const SALE_RECORD_TTL_SECONDS = 30 * 24 * 3600;
export const DEVICE_SALES_TTL_SECONDS = 3 * 24 * 3600;
export const deviceSaleSchema = z
  .object({
    billedAt: z.number().int().positive(),
    sequence: z.number().int().positive(),
    syncedAt: z.number().int().positive().nullable(),
  })
  .strict();
export type DeviceSale = z.infer<typeof deviceSaleSchema>;
const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
export const saleRecordSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('in-flight'),
      operatorId: identifier,
      checkoutId: z.uuid().nullable(),
      submitting: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal('done'),
      orderId: identifier,
      invoiceNo: z.string().max(255).nullable(),
    })
    .strict(),
]);
export type SaleRecord = z.infer<typeof saleRecordSchema>;

export interface OfflineSyncCoordinator {
  lock(reference: string, owner: string, ttlMs: number): Promise<boolean>;
  unlock(reference: string, owner: string): Promise<void>;
  record(reference: string): Promise<SaleRecord | null>;
  saveRecord(reference: string, value: SaleRecord): Promise<void>;
  clearRecord(reference: string): Promise<void>;
  /** The device's recent offline sales by provisional reference (unreadable entries dropped). */
  deviceSales(deviceId: string): Promise<Map<string, DeviceSale>>;
  /** Upsert one device sale and delete the given stale references. */
  saveDeviceSale(
    deviceId: string,
    reference: string,
    value: DeviceSale,
    stale: readonly string[],
  ): Promise<void>;
  close(): Promise<void>;
}

const unlockScript = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
export const saleKeys = {
  record: (reference: string) => `pos:offline_sale:${reference}`,
  lock: (reference: string) => `pos:offline_sale_lock:${reference}`,
  device: (deviceId: string) => `pos:offline_device_sales:${deviceId}`,
};

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
        c.set(saleKeys.lock(reference), owner, { NX: true, PX: ttlMs }),
      );
      return result === 'OK';
    },
    async unlock(reference, owner) {
      await command((c) =>
        c.eval(unlockScript, { keys: [saleKeys.lock(reference)], arguments: [owner] }),
      );
    },
    async record(reference) {
      const value = await command((c) => c.get(saleKeys.record(reference)));
      if (typeof value !== 'string') return null;
      try {
        const parsed = saleRecordSchema.safeParse(JSON.parse(value));
        // An unreadable record is treated as an unknown outcome, never as absent.
        return parsed.success
          ? parsed.data
          : { state: 'in-flight', operatorId: '1', checkoutId: null, submitting: true };
      } catch {
        return { state: 'in-flight', operatorId: '1', checkoutId: null, submitting: true };
      }
    },
    async saveRecord(reference, value) {
      await command((c) =>
        c.set(saleKeys.record(reference), JSON.stringify(saleRecordSchema.parse(value)), {
          EX: SALE_RECORD_TTL_SECONDS,
        }),
      );
    },
    async clearRecord(reference) {
      await command((c) => c.del(saleKeys.record(reference)));
    },
    async deviceSales(deviceId) {
      const values = await command((c) => c.hGetAll(saleKeys.device(deviceId)));
      const sales = new Map<string, DeviceSale>();
      for (const [reference, value] of Object.entries(values)) {
        try {
          const parsed = deviceSaleSchema.safeParse(JSON.parse(value));
          if (parsed.success) sales.set(reference, parsed.data);
        } catch {
          // An unreadable entry is ignored; it only ever counts toward the cap.
        }
      }
      return sales;
    },
    async saveDeviceSale(deviceId, reference, value, stale) {
      const key = saleKeys.device(deviceId);
      await command(async (c) => {
        const multi = c
          .multi()
          .hSet(key, reference, JSON.stringify(deviceSaleSchema.parse(value)))
          .expire(key, DEVICE_SALES_TTL_SECONDS);
        if (stale.length) multi.hDel(key, [...stale]);
        await multi.exec();
      });
    },
    async close() {
      if (client) reset(client);
    },
  };
}
