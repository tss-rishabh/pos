import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { giftCardBatchService } from './service.js';
import { readGiftCardBatchOptions } from './options.js';
import { giftCardBatchWorker, type GiftCardBatchWorkerLogger } from './worker.js';

class PrivateWorkerLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const workerRunId = randomUUID();
const runtime = Fastify({
  logger: {
    base: null,
    serializers: {
      err: () => ({ type: 'InternalError', message: 'Worker operation failed', stack: '' }),
    },
    mixin: () => ({
      module: 'gift-card-batches',
      resource: 'generation-worker',
      eventId: 'gift-card-batches.generation-worker.lifecycle',
      eventInstanceId: randomUUID(),
      requestId: workerRunId,
      userId: null,
    }),
  },
  logController: new PrivateWorkerLogController(),
});
const log: GiftCardBatchWorkerLogger = (level, event, message) =>
  runtime.log[level]({ ...event, requestId: event.requestId ?? workerRunId }, message);
let db: Databases | undefined, service: ReturnType<typeof giftCardBatchService> | undefined;
async function closeResources(stop?: () => Promise<void>) {
  let failed = false;
  const cleanup = [stop, () => service?.close(), () => db?.close(), () => runtime.close()];
  for (const close of cleanup)
    try {
      await close?.();
    } catch {
      failed = true;
    }
  if (failed)
    log(
      'warn',
      {
        module: 'gift-card-batches',
        resource: 'generation-worker',
        eventId: 'gift-card-batches.generation-worker.shutdown-failed',
        eventInstanceId: randomUUID(),
        requestId: workerRunId,
        userId: null,
        errorCode: 'GIFT_CARD_BATCH_SHUTDOWN_FAILED',
      },
      'Gift card worker cleanup needs supervision',
    );
  return !failed;
}
try {
  const options = readGiftCardBatchOptions();
  if (process.argv.length > 2)
    throw new AppError(
      400,
      'GIFT_CARD_BATCH_WORKER_ARGUMENTS_INVALID',
      'This worker does not accept command arguments.',
    );
  if (!options.GIFT_CARD_BATCH_WORKER_ENABLED) {
    runtime.log.info('Gift card generation worker is disabled');
    await runtime.close();
  } else {
    const config = readConfig();
    if (!config.MYSQL_WRITER_URL || config.DEMO_MODE)
      throw new AppError(
        503,
        'GIFT_CARD_BATCH_WORKER_WRITER_REQUIRED',
        'Configure a gift card worker writer.',
      );
    db = createDatabases(config);
    service = giftCardBatchService(config, db, options);
    const worker = giftCardBatchWorker(service, log);
    if (!worker.available)
      throw new AppError(
        503,
        'GIFT_CARD_BATCH_WORKER_UNAVAILABLE',
        'Configure gift card generation, private storage and delivery.',
      );
    let closing = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.on(signal, async () => {
        if (closing) return;
        closing = true;
        const deadline = setTimeout(() => process.exit(1), 10000);
        deadline.unref();
        if (await closeResources(() => worker.stop())) clearTimeout(deadline);
        else process.exitCode = 1;
      });
    worker.start();
  }
} catch (error) {
  log(
    'warn',
    {
      module: 'gift-card-batches',
      resource: 'generation-worker',
      eventId: 'gift-card-batches.generation-worker.startup-failed',
      eventInstanceId: randomUUID(),
      requestId: workerRunId,
      userId: null,
      errorCode:
        error instanceof AppError ? error.code : 'GIFT_CARD_BATCH_WORKER_CONFIGURATION_INVALID',
    },
    'Gift card generation worker could not start',
  );
  await closeResources();
  process.exitCode = 1;
}
