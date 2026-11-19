import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { JobHandlerRegistry, JobProducer } from '../../jobs/contract.js';
import { identifier } from '../../domain/validation.js';
import { z } from 'zod';
import { orderLineIds, statusApiFromOptions } from './service.js';
import { readWholeOrderStatusOptions, type WholeOrderStatusOptions } from './options.js';
import type { CallStatusApi } from './transport.js';

export const PUSH_VINC_ORDER_FOR_ALL = 'core.tasks.push_vinc_order_for_all' as const;
const args = z.object({ order_id: identifier }).strict();

/**
 * C12 producer (`order/libs/calculations.py:164-167`): `push_vinc_order_for_all.delay(order_id)`
 * on queue `core`. Call only after the return transaction has committed.
 */
export function enqueuePushVincOrderForAll(jobs: JobProducer, orderId: string) {
  return jobs.enqueue(
    PUSH_VINC_ORDER_FOR_ALL,
    { order_id: identifier.parse(orderId) },
    { queue: 'core' },
  );
}

/**
 * C12 handler (`core/tasks.py:225-229`): every `has_products.id` of the order, then one
 * `Helpers.call_status_api(order_id, hp_ids, status='PACK')` to `/store-order/status`.
 * At most once, no retry; failures are only logged, as legacy.
 */
export function registerJobHandlers(
  registry: JobHandlerRegistry,
  deps: {
    config: Config;
    db: Databases;
    options?: WholeOrderStatusOptions;
    callStatusApi?: CallStatusApi;
  },
) {
  const callStatusApi =
    deps.callStatusApi ??
    statusApiFromOptions(deps.config, deps.options ?? readWholeOrderStatusOptions());
  registry.register(PUSH_VINC_ORDER_FOR_ALL, async (raw) => {
    const { order_id } = args.parse(raw);
    await callStatusApi(order_id, await orderLineIds(deps.db, order_id), 'PACK', false);
  });
}
