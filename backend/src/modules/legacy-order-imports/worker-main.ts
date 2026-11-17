import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { configuredStockProjection } from '../../db/stock-projection/options.js';
import { configuredLegacyOrderImports } from './runtime.js';
import { legacyOrderImportService } from './service.js';
import { readLegacyOrderImportOptions } from './options.js';
import { legacyOrderImportWorker, type OrderImportWorkerLogger } from './worker.js';

class ImportLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const requestId = randomUUID(),
  logger = Fastify({
    logController: new ImportLogController(),
    logger: {
      base: null,
      serializers: {
        err: () => ({
          type: 'InternalError',
          message: 'Historical import worker unavailable.',
          stack: '',
        }),
      },
      mixin: () => ({
        module: 'administration',
        resource: 'historical-order-import-worker',
        eventId: 'administration.historical-order-import-worker.lifecycle',
        eventInstanceId: randomUUID(),
        requestId,
        userId: null,
      }),
    },
  });
const log: OrderImportWorkerLogger = (level, event, message) => logger.log[level](event, message);
let db: Databases | undefined, worker: ReturnType<typeof legacyOrderImportWorker> | undefined;
function lifecycle(
  action: 'disabled' | 'started' | 'stopped' | 'startup-failed' | 'shutdown-failed',
) {
  return {
    module: 'administration',
    resource: 'historical-order-import-worker',
    eventId: 'administration.historical-order-import-worker.' + action,
    eventInstanceId: randomUUID(),
    requestId,
    userId: null,
  };
}
try {
  if (process.argv.length !== 2)
    throw new AppError(
      400,
      'ORDER_IMPORT_WORKER_ARGUMENTS_INVALID',
      'This worker accepts no arguments.',
    );
  if (!readLegacyOrderImportOptions().LEGACY_ORDER_IMPORT_WORKER_ENABLED) {
    logger.log.info(lifecycle('disabled'), 'Historical order import processing is disabled.');
    await logger.close();
  } else {
    const config = readConfig();
    if (config.DEMO_MODE || !config.MYSQL_WRITER_URL)
      throw new AppError(
        503,
        'ORDER_IMPORT_WORKER_CONFIGURATION_REQUIRED',
        'Configure the import writer.',
      );
    db = createDatabases(config);
    const registration = configuredLegacyOrderImports(config, db, {
        stockProcedure: configuredStockProjection(config) ?? undefined,
        observe: (event) => logger.log.info(event, 'Historical financial import stage recorded.'),
      }),
      service = legacyOrderImportService(config, db, registration);
    if (!service.ready && !service.recoveryReady)
      throw new AppError(
        503,
        'ORDER_IMPORT_WORKER_CONFIGURATION_REQUIRED',
        'Configure the qualified import adapters.',
      );
    worker = legacyOrderImportWorker(service, log);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await worker?.stop();
      await db?.close();
      logger.log.info(lifecycle('stopped'), 'Historical order import processing stopped.');
      await logger.close();
    };
    const shutdown = () => {
      void stop().catch(() => {
        logger.log.error(
          lifecycle('shutdown-failed'),
          'Historical order import shutdown needs review.',
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    worker.start();
    logger.log.info(lifecycle('started'), 'Historical order import processing started.');
  }
} catch {
  logger.log.error(
    lifecycle('startup-failed'),
    'Historical order import processing could not start.',
  );
  await worker?.stop();
  await db?.close();
  await logger.close();
  process.exitCode = 1;
}
