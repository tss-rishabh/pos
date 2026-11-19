import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { HyperlocalOrderLog, Store, UserStore } from '../../../db/legacy-schema.js';
import { positiveId } from '../contracts.js';
import type { OnlineDetailFact } from './contracts.js';

/** Hard-coded in legacy `ShowOnlineOrderDetailsView.get` (`order/views.py:611-617`). */
export const hyperlocalCancelReasons = [
  { id: 1, reason: 'Delivery Not possible' },
  { id: 2, reason: 'Stock not availble' },
  { id: 3, reason: 'Testing order' },
  { id: 4, reason: 'Courier partner unavailable' },
] as const;

export const onlineDetailContext = z
  .object({
    showMarkPaymentPopUp: z.boolean(),
    sddInvoice: z.boolean(),
    isTransferred: z.boolean(),
    isNextIds: z.boolean(),
    isMoreNextIds: z.boolean(),
    /** `request.user.id in target_user_list`; the list itself is not exposed. */
    isTargetUser: z.boolean(),
    eligibleStores: z
      .array(z.object({ id: positiveId, name: z.string().max(255).nullable() }).strict())
      .max(1000),
    hyperlocalAction: z.string().max(64).nullable(),
    hyperlocalPacked: z.boolean(),
    hasPendingExpressItems: z.boolean(),
    isExpressOrder: z.boolean(),
    isSuperAdmin: z.boolean(),
    hlCancelReasons: z
      .array(z.object({ id: z.number().int(), reason: z.string() }).strict())
      .length(4),
  })
  .strict();
export type OnlineDetailContext = z.infer<typeof onlineDetailContext>;

/**
 * The remaining `ShowOnlineOrderDetailsView.get` context (`order/views.py:518-645`) that the
 * order facts do not already carry. `expressStoreId` is the optional `?store_id=` scope.
 */
export async function readOnlineDetailContext(
  db: Databases,
  user: Principal,
  fact: OnlineDetailFact,
  expressStoreId: string | null,
): Promise<OnlineDetailContext> {
  const reader = db.get('primary');
  const [log] = await reader
    .select({ action: HyperlocalOrderLog.action, packed: HyperlocalOrderLog.is_pack })
    .from(HyperlocalOrderLog)
    .where(eq(HyperlocalOrderLog.order_id, BigInt(fact.orderId)))
    .orderBy(asc(HyperlocalOrderLog.id))
    .limit(1);
  const action = log?.action ?? null;
  // `order.location_type == "SW"` seeds next_ids with the location; a transfer replaces it.
  let nextIds: string[] =
    fact.delivery.locationType === 'SW' && fact.delivery.locationId !== null
      ? [fact.delivery.locationId]
      : [];
  const pending = fact.delivery.nextStoreIds;
  if (fact.delivery.transfer) nextIds = pending;
  const paid = fact.paymentStatus.id === '4';
  let showMarkPaymentPopUp = fact.split ? paid : paid && fact.status.id === '1';
  if (action && ['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'].includes(action))
    showMarkPaymentPopUp = false;
  if (fact.delivery.childOrderId) showMarkPaymentPopUp = false;
  // Helpers.get_stores_user(next_ids, include_super_user=True) (`helpers/helpers.py:827-833`).
  const assigned = nextIds.length
    ? await reader
        .select({ storeId: UserStore.store_id })
        .from(UserStore)
        .where(
          and(
            eq(UserStore.django_user_id, BigInt(user.id)),
            inArray(UserStore.store_id, nextIds.map(BigInt)),
          ),
        )
    : [];
  const isTargetUser = user.role === 1 || assigned.length > 0;
  const allowed =
    user.role === 1
      ? nextIds
      : nextIds.filter((id) => assigned.some((row) => String(row.storeId) === id));
  const eligible = allowed.length
    ? await reader
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(and(eq(Store.is_active, true), inArray(Store.id, allowed.map(BigInt))))
        .orderBy(asc(Store.id))
    : [];
  const express = fact.lines.flatMap((line) =>
    line.express.filter((item) => !expressStoreId || item.storeId === expressStoreId),
  );
  // Helpers.has_multiple_shipment (`helpers/helpers.py:2005-2017`): platforms 3/4 are SDD.
  const sdd = fact.lines.some((line) => ['3', '4'].includes(line.platform.id)),
    normal = fact.lines.some((line) => !['3', '4'].includes(line.platform.id));
  return onlineDetailContext.parse({
    showMarkPaymentPopUp,
    sddInvoice: fact.split && sdd && normal,
    isTransferred: fact.delivery.transfer,
    isNextIds: pending.length > 0,
    isMoreNextIds: pending.length > 1,
    isTargetUser,
    eligibleStores: eligible.map((row) => ({ id: String(row.id), name: row.name })),
    hyperlocalAction: action,
    hyperlocalPacked: Boolean(log?.packed),
    hasPendingExpressItems: express.some((item) => item.status === 'PENDING'),
    isExpressOrder: fact.lines.some((line) => line.platform.id === '5'),
    isSuperAdmin: user.role === 1,
    hlCancelReasons: hyperlocalCancelReasons.map((item) => ({ ...item })),
  });
}
