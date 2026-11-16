import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, lt, or } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { ExpressLineItem } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { localTimestamp } from './domain.js';
import type { fulfillmentOutbox } from './outbox.js';
import type { fulfillmentMaintenance, MaintenancePhase } from './maintenance.js';
import type { notificationDelivery } from './notifications.js';
import type { FulfillmentOptions } from './options.js';

interface WorkerEvent {
  module: 'fulfillment' | 'notifications';
  resource: string;
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  effectId?: string;
  errorCode?: string;
  completedCount?: number;
}
export type WorkerLogger = (level: 'info' | 'warn', event: WorkerEvent, message: string) => void;
export function fulfillmentWorker(
  config: Config,
  db: Databases,
  outbox: ReturnType<typeof fulfillmentOutbox>,
  maintenance: ReturnType<typeof fulfillmentMaintenance>,
  notifications: ReturnType<typeof notificationDelivery>,
  options: FulfillmentOptions,
  log: WorkerLogger,
) {
  let timer: ReturnType<typeof setInterval> | undefined,
    active: Promise<void> | undefined,
    stopping = false,
    lastMaintenance = 0,
    afterStore = 0,
    maintenancePass = false;
  let selectedStore: { id: string; cursor: Partial<Record<MaintenancePhase, string>> } | undefined;
  const event = (
    resource: string,
    action: string,
    requestId: string | null = null,
    userId: string | null = null,
  ): WorkerEvent => ({
    module: 'fulfillment',
    resource,
    eventId: `fulfillment.${resource}.${action}`,
    eventInstanceId: randomUUID(),
    requestId,
    userId,
  });
  async function maintenanceBatch(requestId: string) {
    if (!selectedStore) {
      const now = localTimestamp(Temporal.Now.instant(), config.BUSINESS_TIMEZONE);
      const [store] = await db
        .get('writer')
        .selectDistinct({ id: ExpressLineItem.store_id })
        .from(ExpressLineItem)
        .where(
          and(
            gt(ExpressLineItem.store_id, afterStore),
            or(
              and(
                eq(ExpressLineItem.status, 'PENDING'),
                lt(ExpressLineItem.pending_expires_at, now),
              ),
              and(
                eq(ExpressLineItem.status, 'ACCEPTED'),
                lt(ExpressLineItem.accepted_expires_at, now),
              ),
              eq(ExpressLineItem.status, 'TIMED_OUT'),
            ),
          ),
        )
        .orderBy(asc(ExpressLineItem.store_id))
        .limit(1);
      if (!store) {
        afterStore = 0;
        maintenancePass = false;
        lastMaintenance = Date.now();
        return;
      }
      selectedStore = { id: String(store.id), cursor: {} };
    }
    const result = await maintenance.runStore(
      selectedStore.id,
      options.FULFILLMENT_WORKER_BATCH_SIZE,
      selectedStore.cursor,
      requestId,
    );
    if (result.hasMore) selectedStore.cursor = result.nextCursor;
    else {
      afterStore = Number(selectedStore.id);
      selectedStore = undefined;
    }
    if (result.packed || result.rejected || result.timedOut)
      log(
        'info',
        {
          ...event('expiry-worker', 'processed', requestId),
          completedCount: result.packed + result.rejected + result.timedOut,
        },
        'Expired fulfillment lines processed',
      );
  }
  const runOnce = () => {
    if (stopping || active) return active || Promise.resolve();
    const runId = randomUUID();
    active = (async () => {
      try {
        if (
          maintenancePass ||
          Date.now() - lastMaintenance >= options.FULFILLMENT_MAINTENANCE_INTERVAL_MS
        ) {
          if (!maintenancePass) {
            await outbox.expireClaims();
            maintenancePass = true;
          }
          for (
            let index = 0;
            index < Math.min(10, options.FULFILLMENT_WORKER_BATCH_SIZE) &&
            maintenancePass &&
            !stopping;
            index++
          ) {
            try {
              await maintenanceBatch(runId);
            } catch (error) {
              log(
                'warn',
                {
                  ...event('expiry-worker', 'failed', runId),
                  errorCode: error instanceof AppError ? error.code : 'WORKER_UNAVAILABLE',
                },
                'Expiry worker could not process this store batch',
              );
              if (selectedStore) {
                afterStore = Number(selectedStore.id);
                selectedStore = undefined;
              } else {
                maintenancePass = false;
                lastMaintenance = Date.now();
              }
            }
          }
        }
        const deadline = Date.now() + 20000;
        for (
          let index = 0;
          index < options.FULFILLMENT_WORKER_BATCH_SIZE && !stopping && Date.now() < deadline;
          index += options.FULFILLMENT_WORKER_CONCURRENCY
        ) {
          const outcomes = await Promise.allSettled(
            Array.from(
              {
                length: Math.min(
                  options.FULFILLMENT_WORKER_CONCURRENCY,
                  options.FULFILLMENT_WORKER_BATCH_SIZE - index,
                ),
              },
              () => outbox.dispatchNext(),
            ),
          );
          const effects = outcomes.flatMap((outcome) =>
            outcome.status === 'fulfilled' ? [outcome.value] : [],
          );
          const rejected = outcomes.some((outcome) => outcome.status === 'rejected');
          if (!rejected && effects.every((effect) => effect === null)) break;
          for (const effect of effects)
            if (effect)
              log(
                effect.status === 'COMPLETED' ? 'info' : 'warn',
                {
                  ...event(
                    effect.kind,
                    `delivery-${effect.status.toLowerCase()}`,
                    effect.requestId || null,
                    effect.userId || null,
                  ),
                  effectId: effect.effectId,
                  ...(effect.status === 'COMPLETED'
                    ? {}
                    : {
                        errorCode:
                          effect.status === 'BLOCKED'
                            ? 'DEPENDENCY_UNAVAILABLE'
                            : 'DELIVERY_OUTCOME_UNKNOWN',
                      }),
                },
                effect.status === 'COMPLETED'
                  ? 'Fulfillment effect delivered'
                  : 'Fulfillment effect requires reconciliation',
              );
          if (rejected)
            throw new AppError(
              503,
              'WORKER_UNAVAILABLE',
              'A fulfillment worker claim could not complete.',
            );
        }
        const published = await notifications.publishPending(options.FULFILLMENT_WORKER_BATCH_SIZE);
        if (published.completed)
          log(
            'info',
            {
              ...event('notification-worker', 'published', runId),
              module: 'notifications',
              eventId: 'notifications.notification-worker.published',
              completedCount: published.completed,
            },
            'Pending notifications published',
          );
      } catch (error) {
        log(
          'warn',
          {
            ...event('delivery-worker', 'failed', runId),
            errorCode: error instanceof AppError ? error.code : 'WORKER_UNAVAILABLE',
          },
          'Fulfillment worker could not complete this batch',
        );
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  return {
    runOnce,
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => {
        void runOnce();
      }, options.FULFILLMENT_WORKER_INTERVAL_MS);
      timer.unref();
      void runOnce();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      await active;
    },
  };
}
