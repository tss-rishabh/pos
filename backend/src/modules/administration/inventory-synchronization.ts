import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from './checkins.js';

/**
 * The `pos_rewrite_administration_outbox` table and its `worker:administration` delivery are
 * removed. Legacy calls `Helpers.sync_pos_product` inline once the change is committed
 * (`helpers/helpers.py:192-202`, `core/views.py:489,543,564,776`), so a caller must call its
 * `ProductSynchronizer` (`product-sync.ts`) after its transaction commits.
 *
 * These exports are kept so callers outside administration still compile. They validate the
 * event and record it on the transaction object; `takeInventorySynchronization(tx)` returns the
 * recorded events after commit. A caller that never takes them sends no product sync.
 */
const synchronizationInput = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/),
    storeId: identifier,
    productIds: z.array(identifier).min(1).max(1000),
    operatorId: identifier,
    reason: z.enum([
      'return',
      'exchange-return',
      'inventory-import',
      'legacy-rto',
      'legacy-delivery',
      'order-cancel',
    ]),
    requestId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InventorySynchronizationInput = z.infer<typeof synchronizationInput>;
const systemSynchronizationInput = synchronizationInput
  .omit({ operatorId: true })
  .extend({ reason: z.enum(['legacy-rto', 'legacy-delivery']) })
  .strict();
export type SystemInventorySynchronizationInput = z.infer<typeof systemSynchronizationInput>;

const pending = new WeakMap<object, InventorySynchronizationInput[]>();
function record(transaction: AdministrationTransaction, event: InventorySynchronizationInput) {
  const events = pending.get(transaction) ?? [];
  events.push(event);
  pending.set(transaction, events);
}

/** @deprecated Record-only; see the module comment. Call the product synchronizer after commit. */
export async function enqueueInventorySynchronization(
  transaction: AdministrationTransaction,
  event: InventorySynchronizationInput,
): Promise<void> {
  record(transaction, synchronizationInput.parse(event));
}
/** @deprecated Record-only; system actor0 as the source (`operatorId` "0"). */
export async function enqueueSystemInventorySynchronization(
  transaction: AdministrationTransaction,
  event: SystemInventorySynchronizationInput,
): Promise<void> {
  record(transaction, { ...systemSynchronizationInput.parse(event), operatorId: '0' });
}
/** Events recorded on `transaction`, once; call after the transaction has committed. */
export function takeInventorySynchronization(
  transaction: AdministrationTransaction,
): InventorySynchronizationInput[] {
  const events = pending.get(transaction) ?? [];
  pending.delete(transaction);
  return events;
}
