import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, isNull } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { administrationOutbox } from './schema.js';
import { inventoryService } from './inventory.js';
import { createProductSyncAdapter } from './product-sync.js';
import type { AdministrationWorkerOptions } from './worker-options.js';
import { inventoryImportService } from './imports.js';
import { inventoryImports } from './import-schema.js';

export interface AdministrationWorkerEvent {
  module: 'administration';
  resource: 'inventory-synchronization' | 'inventory-synchronization-worker' | 'inventory-import';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  effectId?: string;
  storeId?: string;
  errorCode?: string;
  completedCount?: number;
  importId?: string;
  rowNumber?: number | null;
}
export type AdministrationWorkerLogger = (
  level: 'info' | 'warn',
  event: AdministrationWorkerEvent,
  message: string,
) => void;
const event = (
  resource: AdministrationWorkerEvent['resource'],
  action: string,
  requestId: string | null = null,
  userId: string | null = null,
): AdministrationWorkerEvent => ({
  module: 'administration',
  resource,
  eventId: `administration.${resource}.${action}`,
  eventInstanceId: randomUUID(),
  requestId,
  userId,
});

export function administrationWorker(
  config: Config,
  db: Databases,
  options: AdministrationWorkerOptions,
  log: AdministrationWorkerLogger,
  fetcher: typeof fetch = fetch,
) {
  const adapter = createProductSyncAdapter(config, options, fetcher);
  if (options.ADMINISTRATION_WORKER_ENABLED && !adapter)
    throw new AppError(
      503,
      'ADMINISTRATION_WORKER_CONFIGURATION_REQUIRED',
      'Product synchronization worker requires an approved replay-safe endpoint.',
    );
  let stopping = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined,
    batchAbort: AbortController | undefined,
    afterExhausted = '',
    afterBlockedImport = 0n,
    backoff = options.ADMINISTRATION_WORKER_INTERVAL_MS;
  const alerts = new Map<string, number>();
  let failures = 0,
    runId: string | null = null;
  const inventory = inventoryService(config, db, {
    syncProducts: adapter
      ? async (id, ids, context) => {
          alerts.delete(id);
          try {
            await adapter(id, ids, context, batchAbort?.signal);
            log(
              'info',
              {
                ...event(
                  'inventory-synchronization',
                  'acknowledged',
                  context.requestId || runId,
                  context.operatorId,
                ),
                effectId: id,
                storeId: context.storeId,
              },
              'Inventory synchronization acknowledged',
            );
          } catch (error) {
            failures++;
            log(
              'warn',
              {
                ...event(
                  'inventory-synchronization',
                  'delivery-failed',
                  context.requestId || runId,
                  context.operatorId,
                ),
                effectId: id,
                storeId: context.storeId,
                errorCode: error instanceof AppError ? error.code : 'PRODUCT_SYNC_UNAVAILABLE',
              },
              'Inventory synchronization will be retried',
            );
            throw error;
          }
        }
      : undefined,
  });
  const imports = inventoryImportService(config, db, { syncProducts: adapter });
  async function alertExhausted() {
    const rows = await db
      .get('writer')
      .select({ id: administrationOutbox.id, payload: administrationOutbox.payload })
      .from(administrationOutbox)
      .where(
        and(
          isNull(administrationOutbox.deliveredAt),
          gte(administrationOutbox.attempts, 10),
          gt(administrationOutbox.id, afterExhausted),
        ),
      )
      .orderBy(asc(administrationOutbox.id))
      .limit(options.ADMINISTRATION_WORKER_BATCH_SIZE);
    afterExhausted =
      rows.length === options.ADMINISTRATION_WORKER_BATCH_SIZE ? rows.at(-1)!.id : '';
    for (const row of rows) {
      if (alerts.has(row.id)) continue;
      alerts.set(row.id, Date.now());
      if (alerts.size > 1000) alerts.delete(alerts.keys().next().value!);
      log(
        'warn',
        {
          ...event(
            'inventory-synchronization',
            'retry-exhausted',
            row.payload.requestId || runId,
            row.payload.actorId,
          ),
          effectId: row.id,
          storeId: row.payload.storeId,
          errorCode: 'PRODUCT_SYNC_RETRY_EXHAUSTED',
        },
        'Inventory synchronization requires operator recovery',
      );
    }
  }
  async function alertBlockedImports() {
    const rows = await db
      .get('writer')
      .select({
        id: inventoryImports.id,
        sequence: inventoryImports.sequence,
        actorId: inventoryImports.actorId,
        requestId: inventoryImports.requestId,
      })
      .from(inventoryImports)
      .where(
        and(
          eq(inventoryImports.state, 'BLOCKED'),
          gt(inventoryImports.sequence, afterBlockedImport),
        ),
      )
      .orderBy(asc(inventoryImports.sequence))
      .limit(options.ADMINISTRATION_WORKER_BATCH_SIZE);
    afterBlockedImport =
      rows.length === options.ADMINISTRATION_WORKER_BATCH_SIZE ? rows.at(-1)!.sequence : 0n;
    for (const row of rows) {
      const key = `import:${row.id}`;
      if (alerts.has(key)) continue;
      alerts.set(key, Date.now());
      if (alerts.size > 1000) alerts.delete(alerts.keys().next().value!);
      log(
        'warn',
        {
          ...event('inventory-import', 'blocked', row.requestId || runId, row.actorId),
          importId: row.id,
          errorCode: 'INVENTORY_IMPORT_BLOCKED',
        },
        'Inventory import requires operator recovery',
      );
    }
  }
  const runOnce = () => {
    if (stopping || !options.ADMINISTRATION_WORKER_ENABLED || !adapter) return Promise.resolve();
    if (active) return active;
    runId = randomUUID();
    failures = 0;
    batchAbort = new AbortController();
    const deadline = setTimeout(
      () => batchAbort?.abort(),
      options.ADMINISTRATION_WORKER_BATCH_TIMEOUT_MS,
    );
    deadline.unref();
    active = (async () => {
      try {
        for (
          let index = 0;
          index < options.ADMINISTRATION_WORKER_BATCH_SIZE &&
          !stopping &&
          !batchAbort?.signal.aborted;
          index++
        ) {
          const result = await imports.dispatchNext();
          if (!result) break;
          if (result.status === 'blocked') {
            alerts.set(`import:${result.importId}`, Date.now());
            if (alerts.size > 1000) alerts.delete(alerts.keys().next().value!);
          }
          log(
            result.status === 'row-failed' || result.status === 'blocked' ? 'warn' : 'info',
            {
              ...event(
                'inventory-import',
                result.status,
                result.requestId || runId,
                result.actorId,
              ),
              importId: result.importId,
              rowNumber: result.rowNumber,
              ...(result.storeId ? { storeId: result.storeId } : {}),
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            },
            result.status === 'blocked'
              ? 'Inventory import requires operator recovery'
              : 'Inventory import row processed',
          );
        }
        const completed = await inventory.dispatchPending(options.ADMINISTRATION_WORKER_BATCH_SIZE);
        if (completed)
          log(
            'info',
            {
              ...event('inventory-synchronization-worker', 'batch-completed', runId),
              completedCount: completed,
            },
            'Inventory synchronization batch completed',
          );
        await alertExhausted();
        await alertBlockedImports();
        backoff = failures
          ? Math.min(60000, backoff * 2)
          : options.ADMINISTRATION_WORKER_INTERVAL_MS;
      } catch (error) {
        backoff = Math.min(60000, backoff * 2);
        log(
          'warn',
          {
            ...event('inventory-synchronization-worker', 'batch-failed', runId),
            errorCode: error instanceof AppError ? error.code : 'ADMINISTRATION_WORKER_UNAVAILABLE',
          },
          'Inventory synchronization worker could not complete this batch',
        );
      } finally {
        clearTimeout(deadline);
        batchAbort = undefined;
        active = undefined;
      }
    })();
    return active;
  };
  async function tick() {
    await runOnce();
    if (!stopping) timer = setTimeout(() => void tick(), backoff);
  }
  return {
    enabled: options.ADMINISTRATION_WORKER_ENABLED && !!adapter,
    runOnce,
    start() {
      if (timer || active || stopping) return;
      if (!options.ADMINISTRATION_WORKER_ENABLED) {
        log(
          'info',
          event('inventory-synchronization-worker', 'disabled'),
          'Inventory synchronization worker is disabled',
        );
        return;
      }
      log(
        'info',
        event('inventory-synchronization-worker', 'started'),
        'Inventory synchronization worker started',
      );
      void tick();
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      batchAbort?.abort();
      await active;
      log(
        'info',
        event('inventory-synchronization-worker', 'stopped'),
        'Inventory synchronization worker stopped',
      );
    },
  };
}

/** Operational recovery after the remote endpoint's replay safety has been verified. */
export async function retryInventorySynchronization(db: Databases, id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(id))
    throw new AppError(400, 'INVALID_SYNCHRONIZATION_ID', 'Choose a valid synchronization event.');
  await db.get('writer').transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        delivered: administrationOutbox.deliveredAt,
        attempts: administrationOutbox.attempts,
      })
      .from(administrationOutbox)
      .where(eq(administrationOutbox.id, id))
      .limit(1)
      .for('update');
    if (!row)
      throw new AppError(
        404,
        'SYNCHRONIZATION_NOT_FOUND',
        'Inventory synchronization was not found.',
      );
    if (row.delivered)
      throw new AppError(
        409,
        'SYNCHRONIZATION_COMPLETED',
        'Inventory synchronization is already complete.',
      );
    await transaction
      .update(administrationOutbox)
      .set({ attempts: 0 })
      .where(eq(administrationOutbox.id, id));
  });
}
