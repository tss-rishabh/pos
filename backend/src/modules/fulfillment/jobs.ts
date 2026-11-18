import { z } from 'zod';
import type { JobArgs, JobHandlerRegistry, JobProducer } from '../../jobs/contract.js';
import { AppError } from '../../domain/errors.js';
import { autoRejectTimedOutForStore, type ExpiryDependencies } from './expiry.js';
import { createOrderNotification, type OrderNotificationDependencies } from './notifications.js';
import type { FulfillmentLogger } from './effects.js';

export const AUTO_REJECT_JOB = 'order.tasks.auto_reject_timed_out_for_store' as const;
export const ADVANCE_ORDER_NOTIFICATION_JOB = 'order.views.advance_order_notification' as const;

const id = z.string().regex(/^[1-9]\d{0,19}$/);
const autoRejectArgs = z.object({ store_id: id }).strict();
/** Legacy positional args `(title, order_id, store_id, is_slack, is_new_order)` + kwargs. */
const notificationArgs = z
  .object({
    title: z.string().min(1).max(255),
    order_id: id,
    store_id: id,
    is_slack: z.boolean(),
    is_new_order: z.boolean(),
    send_to_common: z.boolean().default(true),
  })
  .strict();
export type AdvanceOrderNotificationArgs = z.input<typeof notificationArgs>;

/**
 * O1 producer, called by the three hyperlocal progress views exactly where legacy calls
 * `auto_reject_timed_out_for_store.delay(check_in_store_id)` (`order/views.py:4919,4952,5296`).
 * A missing or failing queue is logged and the page still renders.
 */
export async function enqueueAutoReject(
  jobs: JobProducer | undefined,
  storeId: string | null,
  log: FulfillmentLogger,
) {
  // Legacy enqueues for store 0 too; that run finds no rows, so nothing is lost by skipping it.
  if (!storeId) return;
  if (!jobs) {
    log('warn', {
      eventId: 'fulfillment.auto-reject.not-enqueued',
      resource: 'express-expiry',
      outcome: 'queue-unavailable',
      storeId,
    });
    return;
  }
  try {
    await jobs.enqueue(AUTO_REJECT_JOB, { store_id: storeId }, { queue: 'order' });
  } catch {
    log('error', {
      eventId: 'fulfillment.auto-reject.not-enqueued',
      resource: 'express-expiry',
      outcome: 'enqueue-failed',
      storeId,
    });
  }
}
/**
 * O5 producer. The express notify webhook enqueues one job per store on queue `order` with
 * `send_to_common=False` (`order/views.py:5276-5279`); the hyperlocal intake (legacy-fulfillment)
 * enqueues it on `order_create` with the advance-order countdown.
 */
export async function enqueueAdvanceOrderNotification(
  jobs: JobProducer | undefined,
  args: AdvanceOrderNotificationArgs,
  options: { queue: 'order' | 'order_create'; delaySeconds?: number },
) {
  if (!jobs)
    throw new AppError(503, 'JOB_QUEUE_UNAVAILABLE', 'The job queue is not available. Try again.');
  const parsed = notificationArgs.parse(args);
  return jobs.enqueue(ADVANCE_ORDER_NOTIFICATION_JOB, parsed satisfies JobArgs, options);
}

export interface FulfillmentJobDependencies {
  expiry: ExpiryDependencies;
  notifications: OrderNotificationDependencies;
}
/** Registers the handlers for O1 and O5. W8 calls this with the worker's registry. */
export function registerJobHandlers(
  registry: JobHandlerRegistry,
  deps: FulfillmentJobDependencies,
): void {
  registry.register(AUTO_REJECT_JOB, async (args) => {
    const { store_id } = autoRejectArgs.parse(args);
    await autoRejectTimedOutForStore(deps.expiry, store_id);
  });
  registry.register(ADVANCE_ORDER_NOTIFICATION_JOB, async (args) => {
    const input = notificationArgs.parse(args);
    await createOrderNotification(deps.notifications, {
      title: input.title,
      orderId: input.order_id,
      storeId: input.store_id,
      isSlack: input.is_slack,
      isNewOrder: input.is_new_order,
      sendToCommon: input.send_to_common,
    });
  });
}
