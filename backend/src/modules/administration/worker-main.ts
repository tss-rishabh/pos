import Fastify, { LogController } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import {
  administrationWorker,
  retryInventorySynchronization,
  type AdministrationWorkerLogger,
} from './worker.js';
import { readAdministrationWorkerOptions } from './worker-options.js';

class PrivateWorkerLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const runtime = Fastify({
  logger: {
    base: null,
    serializers: {
      err: () => ({ type: 'InternalError', message: 'Worker operation failed', stack: '' }),
    },
    mixin: () => ({
      module: 'administration',
      resource: 'inventory-synchronization-worker',
      eventId: 'administration.inventory-synchronization-worker.lifecycle',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
    }),
  },
  logController: new PrivateWorkerLogController(),
});
const log: AdministrationWorkerLogger = (level, event, message) =>
  runtime.log[level](event, message);
let databases: Databases | undefined;
try {
  const options = readAdministrationWorkerOptions();
  const args = process.argv.slice(2);
  if (
    args.length &&
    (!options.ADMINISTRATION_WORKER_ENABLED || args.length !== 2 || args[0] !== '--retry-event')
  )
    throw new AppError(
      400,
      'ADMINISTRATION_WORKER_ARGUMENTS_INVALID',
      'Configure the worker before requesting one synchronization recovery.',
    );
  if (!options.ADMINISTRATION_WORKER_ENABLED) {
    log(
      'info',
      {
        module: 'administration',
        resource: 'inventory-synchronization-worker',
        eventId: 'administration.inventory-synchronization-worker.disabled',
        eventInstanceId: randomUUID(),
        requestId: null,
        userId: null,
      },
      'Inventory synchronization worker is disabled',
    );
    await runtime.close();
  } else {
    const config = readConfig();
    if (!config.MYSQL_WRITER_URL)
      throw new AppError(
        503,
        'ADMINISTRATION_WORKER_WRITER_REQUIRED',
        'Configure the inventory synchronization writer.',
      );
    databases = createDatabases(config);
    const worker = administrationWorker(config, databases, options, log);
    if (args.length) {
      const id = args[1]!;
      await retryInventorySynchronization(databases, id);
      log(
        'info',
        {
          module: 'administration',
          resource: 'inventory-synchronization',
          eventId: 'administration.inventory-synchronization.requeued',
          eventInstanceId: randomUUID(),
          requestId: randomUUID(),
          userId: null,
          effectId: id,
        },
        'Inventory synchronization requeued for supervised delivery',
      );
      await databases.close();
      await runtime.close();
    } else {
      let closing = false;
      for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.on(signal, async () => {
          if (closing) return;
          closing = true;
          const deadline = setTimeout(() => process.exit(1), 10000);
          deadline.unref();
          await worker.stop();
          await databases?.close();
          await runtime.close();
          clearTimeout(deadline);
        });
      worker.start();
    }
  }
} catch (error) {
  log(
    'warn',
    {
      module: 'administration',
      resource: 'inventory-synchronization-worker',
      eventId: 'administration.inventory-synchronization-worker.startup-failed',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      errorCode:
        error instanceof AppError ? error.code : 'ADMINISTRATION_WORKER_CONFIGURATION_INVALID',
    },
    'Inventory synchronization worker could not start',
  );
  await databases?.close();
  await runtime.close();
  process.exitCode = 1;
}
