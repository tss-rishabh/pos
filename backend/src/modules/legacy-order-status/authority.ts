import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import {
  Order,
  OrderStore,
  OrderStatus,
  Store,
  HasProduct,
  ExpressLineItem,
  PosUser,
} from '../../db/legacy-schema.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import type { Databases } from '../../db/pools.js';
import {
  scopeSnapshot,
  immutableScopeHash,
  statusReconciliation,
  type StatusSnapshot,
} from './domain.js';
import { requireHandoverBarrier, type AssertHandoverAvailable } from './handover.js';
import { wholeOrderStatusLogs } from './schema.js';
const unavailable = () =>
  new AppError(
    404,
    'WHOLE_ORDER_STATUS_NOT_FOUND',
    'A whole store order was not found in this current scope.',
  );
const scalar = z.union([z.string(), z.number().int().safe()]).transform(String);
export function legacyWholeRequestCovers(
  request: string | null,
  snapshot: StatusSnapshot,
  stage: string,
) {
  if (!request || Buffer.byteLength(request, 'utf8') > 262144) return false;
  let value: unknown;
  try {
    value = JSON.parse(request) as unknown;
  } catch {
    return false;
  }
  const shape = z
    .object({
      externalOrderno: scalar,
      status: z.string().optional(),
      items: z
        .array(z.object({ extLineno: scalar, sku: scalar, qty: scalar }).passthrough())
        .max(10000)
        .optional(),
    })
    .passthrough();
  const parsed = shape.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.externalOrderno !== snapshot.orderId ||
    parsed.data.status !== stage ||
    !parsed.data.items ||
    parsed.data.items.length !== snapshot.lines.length
  )
    return false;
  const items = new Map(parsed.data.items.map((row) => [row.extLineno, row]));
  return (
    items.size === snapshot.lines.length &&
    snapshot.lines.every((line) => {
      const item = items.get(line.id);
      return item?.sku === line.productId && item.qty === line.quantity;
    })
  );
}
export function wholeOrderStatusAuthority(
  config: Config,
  db: Databases,
  barrier?: AssertHandoverAvailable,
) {
  const checkIns = checkInService(db, config);
  return async function capture(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    mutate: boolean,
  ) {
    await assertCurrentStoreAccess(tx, user.id, storeId);
    const [actor] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!actor?.is_active || actor.role !== user.role || actor.user_type !== user.userType)
      throw new AppError(
        403,
        'WHOLE_ORDER_STATUS_SCOPE_CHANGED',
        'Your current order permissions changed.',
      );
    const [store] = await tx
      .select({ id: Store.id, active: Store.is_active, code: Store.location_code })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1)
      .for(mutate ? 'update' : 'share');
    if (!store?.code) throw statusReconciliation();
    const [order] = await tx
      .select({
        id: Order.id,
        customerId: Order.user,
        reference: Order.order_ref_no,
        statusId: Order.order_statuses,
        paymentId: Order.payment_statuses,
        locationId: Order.location_id,
        split: Order.is_split_order,
        statusLabel: OrderStatus.order_status,
      })
      .from(Order)
      .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1)
      .for(mutate ? 'update' : 'share');
    if (!order) throw unavailable();
    if (mutate) await requireHandoverBarrier(barrier)(tx, [orderId]);
    const rows = await tx
      .select()
      .from(OrderStore)
      .where(eq(OrderStore.order, order.id))
      .orderBy(OrderStore.id)
      .limit(1001)
      .for('share');
    if (!rows.some((row) => String(row.store) === storeId)) throw unavailable();
    // A store association or admin role does not authorize another store/warehouse/Express subset.
    if (
      rows.length > 1000 ||
      rows.some((row) => String(row.store) !== storeId) ||
      order.locationId !== null ||
      order.split === 1
    )
      throw statusReconciliation();
    const first = rows[0]!;
    if (first.counter <= 0n) throw statusReconciliation();
    if (mutate) await checkIns.assertCheckIn(user.id, storeId, String(first.counter), tx);
    const express = await tx
      .select({ id: ExpressLineItem.id })
      .from(ExpressLineItem)
      .where(eq(ExpressLineItem.order, order.id))
      .limit(1)
      .for('share');
    if (express.length) throw statusReconciliation();
    const lines = await tx
      .select({
        id: HasProduct.id,
        productId: HasProduct.product,
        subProductId: HasProduct.sub_prod_id,
        quantity: HasProduct.qty,
      })
      .from(HasProduct)
      .where(eq(HasProduct.order, order.id))
      .orderBy(HasProduct.id)
      .limit(10001)
      .for('share');
    const parsed = scopeSnapshot.safeParse({
      orderId: String(order.id),
      customerId: String(order.customerId),
      storeId,
      counterId: String(first.counter),
      reference: order.reference,
      locationCode: store.code,
      storeRowIds: rows.map((row) => String(row.id)),
      lines: lines.map((row) => ({
        id: String(row.id),
        productId: String(row.productId),
        subProductId: String(row.subProductId),
        quantity: String(row.quantity),
      })),
    });
    if (!parsed.success) throw statusReconciliation();
    const snapshot = parsed.data,
      eligible =
        store.active &&
        order.paymentId === 4n &&
        order.statusId !== null &&
        !['0', '1', '4'].includes(String(order.statusId)) &&
        order.statusLabel !== null &&
        !['Order Placed', 'Cancelled'].includes(order.statusLabel);
    if (mutate && !eligible)
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_NOT_READY',
        'This order is not currently ready for a whole-order status request.',
      );
    const logs = await tx
      .select({
        id: wholeOrderStatusLogs.id,
        platform: wholeOrderStatusLogs.platform,
        status: wholeOrderStatusLogs.status,
        updatedAt: wholeOrderStatusLogs.updatedAt,
        request: sql<
          string | null
        >`CASE WHEN OCTET_LENGTH(${wholeOrderStatusLogs.request})<=262144 THEN ${wholeOrderStatusLogs.request} ELSE NULL END`,
      })
      .from(wholeOrderStatusLogs)
      .where(eq(wholeOrderStatusLogs.orderId, order.id))
      .orderBy(wholeOrderStatusLogs.id)
      .limit(1001)
      .for('share');
    if (logs.length > 1000) throw statusReconciliation();
    return {
      snapshot,
      scopeHash: immutableScopeHash(snapshot),
      authVersion: await currentAuthenticationVersion(tx, actor),
      eligible,
      logs: logs.map((row) => ({ ...row, id: String(row.id) })),
    };
  };
}
