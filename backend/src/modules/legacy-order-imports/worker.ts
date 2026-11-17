import { randomUUID } from 'node:crypto';
import type { LegacyOrderImportService } from './service.js';

export interface OrderImportWorkerEvent {
  module: 'administration';
  resource: 'historical-order-import' | 'historical-order-import-worker';
  eventId: string;
  eventInstanceId: string;
  requestId: string;
  userId: string | null;
  jobId?: string;
  operationId?: string;
  errorCode?: 'ORDER_IMPORT_WORKER_UNAVAILABLE';
}
export type OrderImportWorkerLogger = (
  level: 'info' | 'warn',
  event: OrderImportWorkerEvent,
  message: string,
) => void;
export function legacyOrderImportWorker(
  service: LegacyOrderImportService,
  log: OrderImportWorkerLogger,
) {
  const options = service.runtime;
  let timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined,
    started = false,
    stopped = false,
    delay = options.LEGACY_ORDER_IMPORT_WORKER_INTERVAL_MS;
  function event(
    resource: OrderImportWorkerEvent['resource'],
    action: string,
    requestId: string,
  ): OrderImportWorkerEvent {
    return {
      module: 'administration',
      resource,
      eventId: `administration.${resource}.${action}`,
      eventInstanceId: randomUUID(),
      requestId,
      userId: null,
    };
  }
  function runOnce() {
    if (active) return active;
    if (
      stopped ||
      !options.LEGACY_ORDER_IMPORT_WORKER_ENABLED ||
      (!service.ready && !service.recoveryReady)
    )
      return Promise.resolve();
    const requestId = randomUUID();
    active = (async () => {
      try {
        for (
          let index = 0;
          index < options.LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE && !stopped;
          index++
        ) {
          const result = await service.runOne();
          if (!result) break;
          log(
            result.state === 'IMPORTED' ? 'info' : 'warn',
            {
              ...event(
                'historical-order-import',
                result.state.toLowerCase(),
                result.requestId ?? requestId,
              ),
              userId: result.actorId,
              jobId: result.jobId,
              operationId: result.operationId,
            },
            result.state === 'IMPORTED'
              ? 'Historical order import confirmed'
              : 'Historical order import requires review',
          );
        }
        delay = options.LEGACY_ORDER_IMPORT_WORKER_INTERVAL_MS;
      } catch {
        delay = Math.min(60000, delay * 2);
        log(
          'warn',
          {
            ...event('historical-order-import-worker', 'batch-failed', requestId),
            errorCode: 'ORDER_IMPORT_WORKER_UNAVAILABLE',
          },
          'Historical order import batch could not complete',
        );
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, delay);
  }
  return {
    runOnce,
    start() {
      if (
        stopped ||
        started ||
        !options.LEGACY_ORDER_IMPORT_WORKER_ENABLED ||
        (!service.ready && !service.recoveryReady)
      )
        return;
      started = true;
      void runOnce().then(schedule);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
