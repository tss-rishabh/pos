import { readConfig } from '../../src/config.js';
import { createDatabases,type Databases } from '../../src/db/pools.js';
import {
  paymentDeliveryEnvironment,
  paymentOutboxDispatcher,
} from '../../src/modules/checkout/payments/outbox.js';

const runId = crypto.randomUUID();let db:Databases|undefined;
try {
  const config=readConfig(),environment=paymentDeliveryEnvironment();db=createDatabases(config);
  const counts = await paymentOutboxDispatcher(db, config, environment)();
  process.stdout.write(
    JSON.stringify({
      eventId: 'checkout.payment-delivery.dispatch',
      eventInstanceId: crypto.randomUUID(),
      module: 'checkout',
      resource: 'payment-delivery',
      requestId: runId,
      userId: null,
      ...counts,
    }) + '\n',
  );
} catch {
  process.stderr.write(
    JSON.stringify({
      eventId: 'checkout.payment-delivery.failed',
      eventInstanceId: crypto.randomUUID(),
      module: 'checkout',
      resource: 'payment-delivery',
      requestId: runId,
      userId: null,
      errorCode: 'PAYMENT_DELIVERY_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
