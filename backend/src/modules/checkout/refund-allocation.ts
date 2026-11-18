import { AppError } from '../../domain/errors.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { HasProduct, Order, OrderStore } from '../../db/legacy-schema.js';
import { cashRefundAudit } from './refund-audit.js';
import type { CheckoutProjectionScope } from './projection.js';
import { assertActiveCheckoutCustomer } from './customer-access.js';

export const refundAllocationContract = 'pos-refund-per-hp-v1';
export const refundSourcePatchHash =
  'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11';
export interface RefundAllocationConfiguration {
  refundAllocationContract?: string;
  refundSourcePatchHash?: string;
}
export function assertRefundAllocationReady(configuration: RefundAllocationConfiguration) {
  if (
    configuration.refundAllocationContract !== refundAllocationContract ||
    configuration.refundSourcePatchHash !== refundSourcePatchHash
  )
    throw new AppError(
      503,
      'REFUND_ALLOCATION_CONTRACT_UNVERIFIED',
      'The approved per-line refund allocation contract must be verified before creating or charging this sale.',
    );
}
type RefundReader = Pick<ReturnType<Databases['get']>, 'select'>;
const unconfirmed = () =>
  new AppError(
    503,
    'REFUND_ALLOCATION_UNCONFIRMED',
    'Per-line refund evidence requires reconciliation before confirming or charging this order.',
  );

/** Native FLOAT equality catches the legacy per-product overwrite without reimplementing allocations. */
export async function assertOrderRefundAllocations(
  tx: RefundReader,
  scope: CheckoutProjectionScope,
) {
  const orderId = BigInt(scope.orderId);
  const mappings = await tx
    .select({ customerId: Order.user, storeId: OrderStore.store, counterId: OrderStore.counter })
    .from(OrderStore)
    .innerJoin(Order, eq(Order.id, OrderStore.order))
    .where(eq(OrderStore.order, orderId))
    .limit(2)
    .for('update');
  if (
    mappings.length !== 1 ||
    String(mappings[0]!.storeId) !== scope.storeId ||
    String(mappings[0]!.counterId) !== scope.counterId ||
    (scope.customerId !== undefined && String(mappings[0]!.customerId) !== scope.customerId)
  )
    throw unconfirmed();
  await assertActiveCheckoutCustomer(tx, String(mappings[0]!.customerId));
  const latest = tx
    .select({
      lineId: cashRefundAudit.lineId,
      auditId: sql<bigint>`MAX(${cashRefundAudit.id})`.as('audit_id'),
    })
    .from(cashRefundAudit)
    .where(eq(cashRefundAudit.orderId, orderId))
    .groupBy(cashRefundAudit.lineId)
    .as('latest_refund');
  const rows = await tx
    .select({
      id: HasProduct.id,
      coherent:
        sql<number>`(${cashRefundAudit.id} IS NOT NULL AND ${HasProduct.qty}>0 AND ${cashRefundAudit.refundable}>=0 AND (${HasProduct.amount_to_be_refunded} <=> ${cashRefundAudit.refundable}))`.mapWith(
          Number,
        ),
    })
    .from(HasProduct)
    .leftJoin(latest, eq(latest.lineId, HasProduct.id))
    .leftJoin(
      cashRefundAudit,
      and(
        eq(cashRefundAudit.id, latest.auditId),
        eq(cashRefundAudit.lineId, HasProduct.id),
        eq(cashRefundAudit.orderId, HasProduct.order),
        eq(cashRefundAudit.productId, HasProduct.product),
      ),
    )
    .where(eq(HasProduct.order, orderId))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('update');
  if (rows.length < 1 || rows.length > 1000 || rows.some((row) => row.coherent !== 1))
    throw unconfirmed();
}
