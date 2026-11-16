import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { createSettingsDelivery } from './settings-adapters.js';
import { readSettingsWorkerOptions } from './settings-options.js';
import { settingsOutbox } from './settings-outbox.js';
import type { SettingsEffectDelivery } from './settings-domain.js';
import { settingsWorker, type SettingsWorkerLogger } from './settings-worker.js';

class SettingsLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const runtime = Fastify({
  logger: {
    base: null,
    serializers: {
      err: () => ({ type: 'InternalError', message: 'Settings delivery failed', stack: '' }),
    },
    mixin: () => ({
      module: 'administration',
      resource: 'settings-delivery-worker',
      eventId: 'administration.settings-delivery-worker.lifecycle',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
    }),
  },
  logController: new SettingsLogController(),
});
const log: SettingsWorkerLogger = (level, event, message) => runtime.log[level](event, message);
let db: Databases | undefined, delivery: SettingsEffectDelivery | undefined;
try {
  const options = readSettingsWorkerOptions(),
    args = process.argv.slice(2);
  if (
    args.length &&
    (!options.SETTINGS_WORKER_ENABLED || args.length !== 2 || args[0] !== '--retry-effect')
  )
    throw new AppError(
      400,
      'SETTINGS_WORKER_ARGUMENTS_INVALID',
      'Choose one configured settings delivery recovery.',
    );
  if (!options.SETTINGS_WORKER_ENABLED) {
    log(
      'info',
      {
        module: 'administration',
        resource: 'settings-delivery-worker',
        eventId: 'administration.settings-delivery-worker.disabled',
        eventInstanceId: randomUUID(),
        requestId: null,
        userId: null,
      },
      'Settings delivery is disabled',
    );
    await runtime.close();
  } else {
    const config = readConfig();
    if (!config.MYSQL_WRITER_URL || (!options.COMMON_REDIS_URL && !options.SLACK_URL))
      throw new AppError(
        503,
        'SETTINGS_WORKER_CONFIGURATION_REQUIRED',
        'Configure the settings writer and delivery adapters.',
      );
    db = createDatabases(config);
    delivery = createSettingsDelivery(config, db, options);
    if (args.length) {
      await settingsOutbox(db, delivery).retry(args[1]!);
      log(
        'info',
        {
          module: 'administration',
          resource: 'settings-delivery',
          eventId: 'administration.settings-delivery.requeued',
          eventInstanceId: randomUUID(),
          requestId: randomUUID(),
          userId: null,
          effectId: args[1]!,
        },
        'Settings delivery requeued',
      );
      await db.close();
      await delivery.close?.();
      await runtime.close();
    } else {
      const worker = settingsWorker(db, delivery, options, log);
      let closing = false;
      for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.on(signal, async () => {
          if (closing) return;
          closing = true;
          const deadline = setTimeout(() => process.exit(1), 10000);
          deadline.unref();
          await worker.stop();
          await db?.close();
          await delivery?.close?.();
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
      resource: 'settings-delivery-worker',
      eventId: 'administration.settings-delivery-worker.startup-failed',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      errorCode: error instanceof AppError ? error.code : 'SETTINGS_WORKER_CONFIGURATION_INVALID',
    },
    'Settings delivery could not start',
  );
  await db?.close();
  await delivery?.close?.();
  await runtime.close();
  process.exitCode = 1;
}
