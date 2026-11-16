import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { assertCustomerOtpEnabled } from './authority.js';
import { createCustomerOtpDelivery } from './delivery.js';
import { readCustomerOtpOptions } from './options.js';
import { customerOtpOutbox } from './worker.js';
import { pruneCustomerOtpProofs } from './prune.js';

class PrivateOtpLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const runtime = Fastify({
  logger: {
    base: null,
    serializers: {
      err: () => ({ type: 'InternalError', message: 'Customer OTP worker failed', stack: '' }),
    },
    mixin: () => ({
      module: 'customer-otp',
      resource: 'customer-otp-worker',
      eventId: 'customer-otp.customer-otp-worker.lifecycle',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
    }),
  },
  logController: new PrivateOtpLogController(),
});
let db: Databases | undefined;
let timer: ReturnType<typeof setTimeout> | undefined,
  pending: Promise<void> | undefined,
  closing = false;
const controller = new AbortController();
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
  const options = readCustomerOtpOptions();
  if (process.argv.length > 2) throw new Error('Customer OTP worker does not accept arguments.');
  if (!options.CUSTOMER_OTP_WORKER_ENABLED) {
    runtime.log.info('Customer OTP worker is disabled');
    await runtime.close();
  } else {
    const config = readConfig();
    assertCustomerOtpEnabled(config, options);
    if (!config.MYSQL_WRITER_URL) throw new Error('Customer OTP writer is unavailable.');
    const sender = createCustomerOtpDelivery(config, options);
    if (!sender) throw new Error('Customer OTP delivery is unavailable.');
    db = createDatabases(config);
    const database = db,
      worker = customerOtpOutbox(config, database, options, sender, Date.now, (event) =>
        runtime.log.info(event, 'Customer OTP delivery completed'),
      );
    let lastPrune = 0;
    const tick = async () => {
      try {
        await worker.drain(controller.signal, 10);
        if (!controller.signal.aborted && Date.now() - lastPrune >= 60000) {
          await pruneCustomerOtpProofs(database);
          lastPrune = Date.now();
        }
      } catch {
        if (!controller.signal.aborted)
          runtime.log.warn(
            { eventId: 'customer-otp.customer-otp-worker.unavailable' },
            'Customer OTP worker needs supervision',
          );
      } finally {
        if (!closing)
          timer = setTimeout(() => {
            pending = tick();
          }, options.CUSTOMER_OTP_POLL_INTERVAL_MS);
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void close());
    pending = tick();
  }
} catch {
  runtime.log.warn(
    { eventId: 'customer-otp.customer-otp-worker.startup-failed' },
    'Customer OTP worker could not start',
  );
  process.exitCode = 1;
  await close();
}
