import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { createCustomerContactDelivery } from './delivery.js';
import { readCustomerContactOptions } from './options.js';
import { customerContactOutbox } from './worker.js';
import { pruneCustomerContactProofs } from './prune.js';

class PrivateWorkerLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const runtime = Fastify({
  logger: {
    base: null,
    serializers: {
      err: () => ({ type: 'InternalError', message: 'Contact worker operation failed', stack: '' }),
    },
    mixin: () => ({
      module: 'customer-contacts',
      resource: 'customer-contact-worker',
      eventId: 'customer-contacts.customer-contact-worker.lifecycle',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
    }),
  },
  logController: new PrivateWorkerLogController(),
});
let db: Databases | undefined;
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined,
  pending: Promise<void> | undefined,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (timer) clearTimeout(timer);
  controller.abort();
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    await pending;
    await db?.close();
    await runtime.close();
    clearTimeout(deadline);
  } catch {
    process.exitCode = 1;
  }
}
try {
  const options = readCustomerContactOptions();
  if (process.argv.length > 2) throw new Error('Contact worker does not accept arguments.');
  if (!options.CUSTOMER_CONTACTS_WORKER_ENABLED) {
    runtime.log.info('Customer contact worker is disabled');
    await runtime.close();
  } else {
    const config = readConfig();
    if (config.DEMO_MODE || !config.MYSQL_WRITER_URL || !options.CUSTOMER_CONTACTS_ENABLED)
      throw new Error('Contact worker requires its configured writer and feature contract.');
    const sender = createCustomerContactDelivery(config, options);
    if (!sender) throw new Error('Contact worker delivery is unavailable.');
    sender.assertEffectsReady();
    db = createDatabases(config);
    const database = db,
      worker = customerContactOutbox(config, database, options, sender, Date.now, (event) =>
        runtime.log.info(event, 'Customer contact delivery completed'),
      );
    let lastPrune = 0;
    const tick = async () => {
      try {
        await worker.drain(controller.signal, 10);
        if (!controller.signal.aborted && Date.now() - lastPrune >= 60000) {
          await pruneCustomerContactProofs(database);
          lastPrune = Date.now();
        }
      } catch {
        if (!controller.signal.aborted)
          runtime.log.warn(
            { eventId: 'customer-contacts.customer-contact-worker.unavailable' },
            'Customer contact worker needs supervision',
          );
      } finally {
        if (!closing)
          timer = setTimeout(() => {
            pending = tick();
          }, options.CUSTOMER_CONTACTS_WORKER_INTERVAL_MS);
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void close());
    pending = tick();
  }
} catch {
  runtime.log.warn(
    { eventId: 'customer-contacts.customer-contact-worker.startup-failed' },
    'Customer contact worker could not start',
  );
  process.exitCode = 1;
  await close();
}
