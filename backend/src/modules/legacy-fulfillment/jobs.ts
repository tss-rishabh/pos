import { z } from 'zod';
import type { JobArgs, JobHandlerRegistry } from '../../jobs/contract.js';
import { hyperlocalLifecycle } from './hyperlocal.js';
import { lifecycleRuntime, type LegacyFulfillmentDependencies } from './runtime.js';
import { lifecycleStock } from './stock.js';

const id = z.string().regex(/^[1-9]\d{0,18}$/);
const text = z.string().max(2000);
const transferArgs = z.object({ order_id: id }).strict();
const onlineArgs = z
  .object({
    order_id: id,
    store_id: z.string().regex(/^\d{1,19}$/),
    platform: z.enum(['CONVERT_ONLINE', 'RTO_CONVERT_ONLINE']),
    next_ids: text,
    reason: text,
    staff_user: text,
    reason_dropdown: text,
  })
  .strict();
const communicationArgs = z.object({ order_id: id }).strict();
const parse = <T extends z.ZodType>(schema: T, args: JobArgs) => schema.parse(args) as z.infer<T>;

/**
 * Handlers for the legacy hyperlocal Celery tasks owned by this module:
 * - `order.views.auto_hl_order_transfer` (O2, `order/views.py:3844`), queue `order_create`;
 * - `order.views.auto_hl_order_to_online` (O3, `:3937`), queue `order_create`;
 * - `core.tasks.new_order_create_communication` (C9, `core/tasks.py:170`), queue `core`.
 * At-most-once, no retry; each body re-checks the durable legacy guards.
 */
export function registerJobHandlers(
  registry: JobHandlerRegistry,
  deps: LegacyFulfillmentDependencies,
) {
  const runtime = lifecycleRuntime(deps),
    lifecycle = hyperlocalLifecycle(runtime, lifecycleStock(runtime));
  registry.register('order.views.auto_hl_order_transfer', async (args) => {
    const input = parse(transferArgs, args);
    await lifecycle.transfer(input.order_id, { isAuto: true });
  });
  registry.register('order.views.auto_hl_order_to_online', async (args) => {
    const input = parse(onlineArgs, args);
    await lifecycle.toOnline({
      orderId: input.order_id,
      storeId: input.store_id,
      platform: input.platform,
      nextIds: input.next_ids,
      reason: input.reason,
      staffUser: input.staff_user,
      reasonDropdown: input.reason_dropdown,
    });
  });
  registry.register('core.tasks.new_order_create_communication', async (args) => {
    const input = parse(communicationArgs, args);
    const response = await deps.gateway.newOrderCommunication(input.order_id);
    runtime.log({
      eventId: 'legacy-fulfillment.new-order-communication.sent',
      orderId: input.order_id,
      outcome: response.status === 200 ? 'sent' : 'not-sent',
      status: response.status,
    });
  });
}
