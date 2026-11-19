import { eq } from 'drizzle-orm';
import { PosUser, Store, Order } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ReturnOperation } from '../checkout/return-workflow/contracts.js';

/**
 * Compatibility exports for the return workflow (W4). The durable "return repair obligation"
 * (rewrite-only table `pos_rewrite_return_repair_obligations`) is gone: legacy
 * `order/libs/calculations.py:164-167` only enqueues `push_vinc_order_for_all.delay(order_id)`
 * when the Vinculum return fails and an `order_stores` row exists. The return workflow must
 * call `enqueuePushVincOrderForAll(jobs, orderId)` (./jobs.ts) AFTER its transaction commits.
 */
export async function lockRejectedReturnScope(
  tx: AdministrationTransaction,
  operatorId: string,
  storeId: string,
  orderId: string,
) {
  await tx
    .select({ id: PosUser.id })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(operatorId)))
    .limit(1)
    .for('share');
  await tx
    .select({ id: Store.id })
    .from(Store)
    .where(eq(Store.id, BigInt(storeId)))
    .limit(1)
    .for('update');
  await tx
    .select({ id: Order.id })
    .from(Order)
    .where(eq(Order.id, BigInt(orderId)))
    .limit(1)
    .for('update');
}
/**
 * @deprecated No durable obligation is recorded any more (schema freeze). Kept so the return
 * workflow compiles until W4 switches to `enqueuePushVincOrderForAll` after commit.
 */
export async function recordRejectedReturnRepair(
  _tx: AdministrationTransaction,
  _user: Principal,
  _operation: ReturnOperation,
  _dispatcherEnabled = false,
  _requestId?: string,
): Promise<null> {
  return null;
}
