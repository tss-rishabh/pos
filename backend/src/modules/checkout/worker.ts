import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { paymentDeliveryEnvironment, paymentOutboxDispatcher } from './payments/outbox.js';
import { returnDeliveryEnvironment, returnOutboxDispatcher } from './return-workflow/outbox.js';
import type { DeliveryObserver } from './delivery.js';
import { discountDeliveryEnvironment, discountOutboxDispatcher } from './discounts/delivery.js';
import { phoneOtpDelivery } from '../../auth/delivery.js';
import { registrationEnvironment } from './customers/service.js';
import { customerRegistrationOutboxDispatcher } from './customers/outbox.js';
import { localOrderMessageDelivery } from './order-messages/service.js';
import { checkoutEnvironment } from './gateway.js';
import { publicScreeningOptions } from './screening-writer/options.js';
import { configuredPublicScreeningCoordinator } from './screening-writer/runtime.js';
import { publicScreeningPublicationWorker } from './screening-writer/publication.js';

const runId = crypto.randomUUID(),
  controller = new AbortController();
let stopping = false,
  db: Databases | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopping = true;
    controller.abort();
  });
const event = (resource: string, action: string, fields: Record<string, string | number | null>) =>
  JSON.stringify({
    eventId: `checkout.${resource}.${action}`,
    eventInstanceId: crypto.randomUUID(),
    module: 'checkout',
    resource,
    requestId: runId,
    userId: null,
    ...fields,
  }) + '\n';
try {
  const config = readConfig(),
    period = z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(5000)
      .parse(process.env.FINANCIAL_OUTBOX_POLL_MS);
  db = createDatabases(config);
  const observe: DeliveryObserver = (result) => {
    process.stdout.write(
      event(result.resource, result.outcome, {
        deliveryId: result.id,
        requestId: result.requestId || runId,
        userId: result.operatorId,
      }),
    );
  };
  const dispatchPayment = paymentOutboxDispatcher(
      db,
      config,
      paymentDeliveryEnvironment(),
      fetch,
      observe,
      localOrderMessageDelivery(config),
    ),
    dispatchReturn = returnOutboxDispatcher(
      db,
      config,
      returnDeliveryEnvironment(),
      fetch,
      observe,
    ),
    dispatchDiscount = discountOutboxDispatcher(db, discountDeliveryEnvironment(), fetch, observe),
    dispatchRegistration = customerRegistrationOutboxDispatcher(
      db,
      registrationEnvironment(),
      phoneOtpDelivery(),
      observe,
    ),
    dispatchScreening = publicScreeningPublicationWorker(
      configuredPublicScreeningCoordinator(
        config,
        db,
        checkoutEnvironment(),
        publicScreeningOptions(),
      ),
    );
  do {
    try {
      const [payments, returns, discounts, registrations, screening] = await Promise.all([
        dispatchPayment(),
        dispatchReturn(),
        dispatchDiscount(),
        dispatchRegistration(),
        dispatchScreening.drain(controller.signal),
      ]);
      if (Object.values(payments).some((value) => value > 0))
        process.stdout.write(event('payment-delivery', 'dispatch', payments));
      if (Object.values(returns).some((value) => value > 0))
        process.stdout.write(event('return-delivery', 'dispatch', returns));
      if (Object.values(discounts).some((value) => value > 0))
        process.stdout.write(event('discount-delivery', 'dispatch', discounts));
      if (Object.values(registrations).some((value) => value > 0))
        process.stdout.write(event('customer-registration-delivery', 'dispatch', registrations));
      if (Object.values(screening).some((value) => value > 0))
        process.stdout.write(event('screening-publication', 'dispatch', screening));
    } catch {
      process.stderr.write(
        event('financial-delivery', 'failed', { errorCode: 'FINANCIAL_OUTBOX_DISPATCH_FAILED' }),
      );
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (process.argv.includes('--once') || stopping) break;
    try {
      await setTimeout(period, undefined, { signal: controller.signal });
    } catch {
      stopping = true;
    }
  } while (!stopping);
} catch {
  process.stderr.write(
    event('financial-delivery', 'startup-failed', {
      errorCode: 'FINANCIAL_OUTBOX_CONFIGURATION_UNAVAILABLE',
    }),
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
