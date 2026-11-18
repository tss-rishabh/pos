import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  HasProduct,
  PosExchangeLog,
  ReturnOrder,
  ProductInventoryLog,
  PosHoldStockLog,
} from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { proveRestorationGroup } from './legacy-restoration-group.js';

/** Every query has an overflow sentinel. An incomplete group never becomes an empty fact. */
export async function readRestorationGroup(
  tx: AdministrationTransaction,
  scope: { orderId: string; productId: string; storeId: string; targetLineId: string },
  secret: string,
  sourceHash: (log: typeof PosExchangeLog.$inferSelect) => string,
  activeLogId?: string,
) {
  if (
    BigInt(scope.orderId) > 2147483647n ||
    BigInt(scope.productId) > 2147483647n ||
    BigInt(scope.storeId) > 2147483647n
  )
    return null;
  const lines = await tx
    .select({
      id: HasProduct.id,
      quantity: HasProduct.qty,
      status: HasProduct.status,
      returnStatus: HasProduct.return_status,
    })
    .from(HasProduct)
    .where(
      and(
        eq(HasProduct.order, BigInt(scope.orderId)),
        eq(HasProduct.product, BigInt(scope.productId)),
      ),
    )
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('update');
  const exchanges = await tx
    .select()
    .from(PosExchangeLog)
    .where(
      and(
        eq(PosExchangeLog.order_id, Number(scope.orderId)),
        eq(PosExchangeLog.old_prod_id, Number(scope.productId)),
        eq(PosExchangeLog.store_id, Number(scope.storeId)),
      ),
    )
    .orderBy(asc(PosExchangeLog.id))
    .limit(1001)
    .for('update');
  const credits = await tx
    .select({
      id: ReturnOrder.id,
      lineId: ReturnOrder.has_product_id,
      productId: ReturnOrder.prod_id,
      quantity: ReturnOrder.qty,
      createdAt: ReturnOrder.created_at,
      creditNote: ReturnOrder.credit_note_no,
    })
    .from(ReturnOrder)
    .where(
      and(
        eq(ReturnOrder.order_id, BigInt(scope.orderId)),
        eq(ReturnOrder.prod_id, BigInt(scope.productId)),
        eq(ReturnOrder.store_id, Number(scope.storeId)),
        ne(ReturnOrder.credit_note_no, ''),
      ),
    )
    .orderBy(asc(ReturnOrder.id))
    .limit(1001)
    .for('update');
  const comments = [
    `Product inventory added from admin panel on order return, [Order ID:${scope.orderId}]`,
    `Product inventory added from admin panel on store order return, [Order ID:${scope.orderId}]`,
    `Product inventory added from admin panel on online order return, [Order ID:${scope.orderId}]`,
  ];
  const saleable = await tx
    .select({
      id: ProductInventoryLog.id,
      before: ProductInventoryLog.stock_before,
      after: ProductInventoryLog.stock_after,
      at: ProductInventoryLog.created_at,
    })
    .from(ProductInventoryLog)
    .where(
      and(
        eq(ProductInventoryLog.store_id, BigInt(scope.storeId)),
        eq(ProductInventoryLog.product_id, BigInt(scope.productId)),
        inArray(ProductInventoryLog.comment, comments),
      ),
    )
    .orderBy(asc(ProductInventoryLog.id))
    .limit(1001)
    .for('update');
  const held = await tx
    .select({
      id: PosHoldStockLog.id,
      before: PosHoldStockLog.stock_before,
      after: PosHoldStockLog.stock_after,
      at: PosHoldStockLog.created_at,
    })
    .from(PosHoldStockLog)
    .where(
      and(
        eq(PosHoldStockLog.store_id, BigInt(scope.storeId)),
        eq(PosHoldStockLog.product_id, BigInt(scope.productId)),
        eq(
          PosHoldStockLog.comment,
          `Hold Stock inventory added from admin panel on order return, [Order ID:${scope.orderId}]`,
        ),
      ),
    )
    .orderBy(asc(PosHoldStockLog.id))
    .limit(1001)
    .for('update');
  return proveRestorationGroup(
    {
      ...scope,
      lines: lines.map((line) => ({
        ...line,
        id: String(line.id),
        quantity: String(line.quantity),
      })),
      exchanges: exchanges.map((log) => ({
        id: String(log.id),
        lineId: String(log.has_prod_id),
        productId: String(log.old_prod_id),
        status: log.status,
        saleable: Boolean(log.saleable),
        createdAt: log.created_at,
        sourceHash: sourceHash(log),
      })),
      credits: credits.map((credit) => ({
        ...credit,
        id: String(credit.id),
        lineId: String(credit.lineId),
        productId: String(credit.productId),
        quantity: String(credit.quantity),
      })),
      saleable: saleable.map((event) => ({ ...event, id: String(event.id) })),
      held: held.map((event) => ({ ...event, id: String(event.id) })),
    },
    secret,
    activeLogId,
  );
}
