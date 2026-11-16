import { and, asc, eq, sql } from 'drizzle-orm';
import {
  bigint,
  char,
  datetime,
  int,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { HasProduct, Order, OrderStore } from '../../db/legacy-schema.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { assertOrderRefundAllocations } from './refund-allocation.js';
import { assertActiveCheckoutCustomer } from './customer-access.js';
import { assertCheckoutCustomerConsent } from './customer-consent-proof.js';
import {
  assertCompletedGiftCardIssuance,
  assertPendingGiftCardIssuance,
} from './gift-card-issuance.js';

export const checkoutProjectionContract = 'pos-checkout-projection-v1';

// Identical to the reviewed Go adapter. MySQL hashes its native stored values;
// reserializing FLOAT, DOUBLE or BIGINT values in application code changes them.
export const checkoutHeaderHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('order_id',orders.id,'user_id',orders.user_id,'payment_method',orders.payment_method,'pay_amt',orders.pay_amt,'cashback_used',orders.cashback_used,'tss_money_used',orders.tss_money_used,'tss_points_used',orders.tss_points_used,'voucher_used',orders.voucher_used,'voucher_amt_used',orders.voucher_amt_used,'coupon_used',orders.coupon_used,'coupon_amt_used',orders.coupon_amt_used) AS CHAR CHARACTER SET utf8mb4),256))";
export const checkoutLineHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('has_product_id',has_products.id,'product_id',has_products.prod_id,'quantity',has_products.qty,'price',has_products.price) AS CHAR CHARACTER SET utf8mb4),256))";

/** Only the upstream transaction writes proofs, together with wallet/stock allocations. */
export const checkoutProjections = mysqlTable('pos_rewrite_checkout_projections', {
  orderId: bigint('order_id', { mode: 'bigint' }).primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
  counterId: bigint('counter_id', { mode: 'bigint' }).notNull(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  inputHash: char('input_hash', { length: 64 }).notNull(),
  lineCount: int('line_count').notNull(),
  contractVersion: varchar('contract_version', { length: 40 }).notNull(),
  confirmedAt: datetime('confirmed_at', { mode: 'string' }).notNull(),
});
export const checkoutProjectionLines = mysqlTable(
  'pos_rewrite_checkout_projection_lines',
  {
    orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
    lineId: bigint('has_product_id', { mode: 'bigint' }).notNull(),
    productId: bigint('product_id', { mode: 'bigint' }).notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    inputHash: char('input_hash', { length: 64 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.orderId, table.lineId] })],
);

export interface CheckoutProjectionConfiguration {
  checkoutProjectionContract?: string;
  checkoutProjectionKey?: string;
}
export function assertCheckoutProjectionReady(environment: CheckoutProjectionConfiguration) {
  if (
    environment.checkoutProjectionContract !== checkoutProjectionContract ||
    !environment.checkoutProjectionKey ||
    !/^[\x21-\x7e]{32,4096}$/.test(environment.checkoutProjectionKey)
  )
    throw new AppError(
      503,
      'CHECKOUT_PROJECTION_CONTRACT_UNVERIFIED',
      'The deployed stock and wallet confirmation contract must be verified before taking payment.',
    );
}
export interface CheckoutProjectionScope {
  orderId: string;
  storeId: string;
  counterId: string;
  customerId?: string;
}
type ProjectionReader = Pick<ReturnType<Databases['get']>, 'select'>;
function unconfirmed(): never {
  throw new AppError(
    503,
    'CHECKOUT_PROJECTION_UNCONFIRMED',
    'Stock and wallet completion is unconfirmed. Keep this order reference and reconcile before taking payment or handing over the sale.',
  );
}

/** Use inside the writer transaction holding the order lock, including paid replays. */
export async function assertCheckoutProjection(
  tx: ProjectionReader,
  scope: CheckoutProjectionScope,
): Promise<void> {
  const orderId = BigInt(scope.orderId),
    storeId = BigInt(scope.storeId),
    counterId = BigInt(scope.counterId);
  const [order] = await tx
    .select({
      customerId: Order.user,
      method: Order.payment_methods,
      paymentStatus: Order.payment_statuses,
      status: Order.order_statuses,
      payable: Order.pay_amt,
      cashback: Order.cashback_used,
      moneyUsed: Order.tss_money_used,
      pointsUsed: Order.tss_points_used,
      voucherAmountUsed: Order.voucher_amt_used,
      parentId: Order.parent_order_id,
      originalId: Order.original_order_id,
      hyperlocalParentId: Order.hl_parent_order_id,
      locationId: Order.location_id,
      inputHash: sql<string>`${sql.raw(checkoutHeaderHashSql)}`,
    })
    .from(Order)
    .where(eq(Order.id, orderId))
    .limit(1)
    .for('update');
  if (
    !order ||
    order.customerId < 1n ||
    (scope.customerId !== undefined && String(order.customerId) !== scope.customerId) ||
    (order.parentId ?? 0n) !== 0n ||
    (order.originalId ?? 0n) !== 0n ||
    (order.hyperlocalParentId ?? 0n) !== 0n ||
    (order.locationId ?? 0) !== 0 ||
    order.cashback !== 0 ||
    ![3n, 14n].includes(order.method ?? 0n) ||
    ![1n, 3n].includes(order.status ?? 0n) ||
    ![1n, 4n].includes(order.paymentStatus ?? 0n) ||
    !Number.isFinite(order.payable) ||
    order.payable < 0 ||
    (order.method === 3n &&
      (order.payable !== 0 || order.status !== 3n || order.paymentStatus !== 4n))
  )
    unconfirmed();
  await assertActiveCheckoutCustomer(tx, String(order.customerId));
  const mappings = await tx
    .select({ storeId: OrderStore.store, counterId: OrderStore.counter })
    .from(OrderStore)
    .where(eq(OrderStore.order, orderId))
    .limit(2)
    .for('update');
  if (
    mappings.length !== 1 ||
    mappings[0]!.storeId !== storeId ||
    mappings[0]!.counterId !== counterId
  )
    unconfirmed();
  const [proof] = await tx
    .select()
    .from(checkoutProjections)
    .where(eq(checkoutProjections.orderId, orderId))
    .limit(1)
    .for('update');
  if (
    !proof ||
    proof.storeId !== storeId ||
    proof.counterId !== counterId ||
    proof.userId !== order.customerId ||
    proof.contractVersion !== checkoutProjectionContract ||
    proof.inputHash !== order.inputHash ||
    !Number.isInteger(proof.lineCount) ||
    proof.lineCount < 1 ||
    proof.lineCount > 1000
  )
    unconfirmed();
  await assertCheckoutCustomerConsent(tx, {
    orderId: scope.orderId,
    storeId: scope.storeId,
    counterId: scope.counterId,
    customerId: String(order.customerId),
    inputHash: order.inputHash,
    moneyUsed: order.moneyUsed,
    pointsUsed: order.pointsUsed,
    voucherAmountUsed: order.voucherAmountUsed,
  });
  const lines = await tx
    .select({
      id: HasProduct.id,
      productId: HasProduct.product,
      quantity: HasProduct.qty,
      inputHash: sql<string>`${sql.raw(checkoutLineHashSql)}`,
      proofLineId: checkoutProjectionLines.lineId,
      proofProductId: checkoutProjectionLines.productId,
      proofQuantity: checkoutProjectionLines.quantity,
      proofInputHash: checkoutProjectionLines.inputHash,
    })
    .from(HasProduct)
    .leftJoin(
      checkoutProjectionLines,
      and(
        eq(checkoutProjectionLines.orderId, HasProduct.order),
        eq(checkoutProjectionLines.lineId, HasProduct.id),
      ),
    )
    .where(eq(HasProduct.order, orderId))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('update');
  const [count] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(checkoutProjectionLines)
    .where(eq(checkoutProjectionLines.orderId, orderId));
  if (
    lines.length !== proof.lineCount ||
    Number(count?.count) !== proof.lineCount ||
    lines.some(
      (line) =>
        line.id < 1n ||
        line.productId < 1n ||
        line.quantity < 1n ||
        line.quantity > 999n ||
        line.proofLineId !== line.id ||
        line.proofProductId !== line.productId ||
        line.proofQuantity !== line.quantity ||
        line.proofInputHash !== line.inputHash,
    )
  )
    unconfirmed();
  await assertOrderRefundAllocations(tx, scope);
  if (order.paymentStatus === 4n) await assertCompletedGiftCardIssuance(tx, scope.orderId);
  else await assertPendingGiftCardIssuance(tx, scope.orderId);
}
