import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  AmountToBeRefundedLog,
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  PaymentStatus,
  PosTransactionLog,
  ProductStore,
} from '../../../db/legacy-schema.js';
import { hasProductStatuses } from '../../../db/legacy-enums.js';
import { storedEnumValue } from '../../../db/legacy-columns.js';
import { retryTransaction } from '../../../db/retry.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { ProductSyncAdapter } from '../../administration/product-sync.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { pythonFloatString } from '../../operational-reports/number-format.js';
import type { PosStateStore } from '../state-store.js';
import type { CancelPosOrderClient } from './api-v2.js';
import {
  cancellationMessage,
  type CancellationContext,
  type CancellationResult,
} from './contracts.js';

export interface CancellationLogger {
  warn(fields: Record<string, string | null>, message: string): void;
}
export interface PendingCancellationServiceOptions {
  stateStore: PosStateStore;
  /** Undefined when no API-v2 base URL is configured: cancellation is refused before any work. */
  client?: CancelPosOrderClient;
  /** `tss.pos_stock_syncer` (legacy `Helpers.sync_pos_inventory`, helpers/helpers.py:213). */
  stockProcedure?: StockProcedure;
  /** API-v2 product sync (legacy `Helpers.sync_pos_product`, helpers/helpers.py:192). */
  syncProducts?: ProductSyncAdapter;
  logger?: CancellationLogger;
}

/**
 * Redis in-flight lock and replay guard for one order (table-disposition.md,
 * `pos_rewrite_pending_order_cancellations`): `pos:order_cancellation:{orderId}`, SET NX EX 86400,
 * JSON `{status:'inflight'|'cancelled', operatorId, token}`.
 */
export const CANCELLATION_LOCK_TTL_SECONDS = 86_400;
export const cancellationLockKey = (orderId: string) => `pos:order_cancellation:${orderId}`;

/** Python `str(dict)` of the legacy `cancel_transaction_logger` pay_dict (helpers/helpers.py:479-483). */
export function cancelRefundPayDict(points: number, money: number, voucher: number): string {
  return `{'tss point refunded': ${pythonFloatString(points)}, 'tss money refunded': ${pythonFloatString(money)}, 'gift voucher amount refunded': ${pythonFloatString(voucher)}}`;
}

/** A deadlock or lock timeout ends the MySQL transaction; only statement errors may be skipped. */
function transactionAborted(error: unknown): boolean {
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(code));
}

export function pendingCancellationRepository(
  db: Databases,
  config: Config,
  options: PendingCancellationServiceOptions,
) {
  const now = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const warn = (errorCode: string, message: string) => {
    const trace = currentRequestTrace();
    options.logger?.warn(
      {
        module: 'checkout',
        resource: 'pending-order-cancellation',
        eventId: 'checkout.pending-order-cancellation.' + errorCode.toLowerCase(),
        requestId: trace?.requestId ?? null,
        userId: trace?.userId ?? null,
        errorCode,
      },
      message,
    );
  };
  /**
   * The order, its legacy store (`order.order_store.first().store_id`, order/views.py:2909-2912)
   * and the cancel-button condition of order/templates/order/show.html:67-68.
   */
  async function inspect(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
  ) {
    requireStore(user, storeId);
    await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3, 4, 5], 'share');
    const [order] = await tx
      .select({
        customerId: Order.user,
        method: Order.payment_methods,
        payment: PaymentStatus.payment_status,
        status: OrderStatus.order_status,
      })
      .from(Order)
      .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
      .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    const [mapping] = await tx
      .select({ storeId: OrderStore.store })
      .from(OrderStore)
      .where(eq(OrderStore.order, BigInt(orderId)))
      .orderBy(asc(OrderStore.id))
      .limit(1);
    if (!order || !mapping || String(mapping.storeId) !== storeId)
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found in this store.');
    return {
      customerId: String(order.customerId),
      eligible:
        order.method === 14n && order.payment === 'Pending' && order.status === 'Order Placed',
    };
  }
  const read = <T>(work: (tx: AdministrationTransaction) => Promise<T>) =>
    retryTransaction(() => db.get('writer').transaction(work));

  /** Legacy order/views.py:2930-2960, applied as one transaction after API-v2 accepted. */
  async function applyLocalCancellation(user: Principal, storeId: string, orderId: string) {
    const synced: string[] = [];
    await read(async (tx) => {
      synced.length = 0;
      const id = BigInt(orderId),
        store = BigInt(storeId),
        operator = BigInt(user.id),
        date = now();
      await tx
        .update(Order)
        .set({ payment_statuses: 2n, order_statuses: 4n })
        .where(eq(Order.id, id));
      const [cancelled] = await tx
        .select({ name: OrderStatus.order_status })
        .from(OrderStatus)
        .where(eq(OrderStatus.id, 4n))
        .limit(1);
      // Legacy reads `.order_status` of the id-4 row; an absent row raises before any write.
      if (!cancelled)
        throw new AppError(
          503,
          'ORDER_STATUS_UNAVAILABLE',
          'The cancelled order status is unavailable.',
        );
      await tx
        .update(HasProduct)
        .set({ status: storedEnumValue(hasProductStatuses, cancelled.name) })
        .where(eq(HasProduct.order, id));
      await tx.insert(PosTransactionLog).values({
        order_id: id,
        store_id: store,
        order_status: 4n,
        payment_status: 2n,
        user_id: 0n,
        pos_user_id: operator,
        pay_dict: '{}',
        comment: 'Order Cancelled : No Transaction Made',
        created_at: date,
        updated_at: date,
      });
      const lines = await tx
        .select({ productId: HasProduct.product, quantity: HasProduct.qty })
        .from(HasProduct)
        .where(eq(HasProduct.order, id))
        .orderBy(asc(HasProduct.id));
      for (const line of lines) {
        const productId = String(line.productId);
        const [refund] = await tx
          .select({
            points: AmountToBeRefundedLog.tss_point_used,
            money: AmountToBeRefundedLog.tss_money_used,
            voucher: AmountToBeRefundedLog.gift_voucher_amount,
          })
          .from(AmountToBeRefundedLog)
          .where(
            and(
              eq(AmountToBeRefundedLog.order_id, id),
              eq(AmountToBeRefundedLog.prod_id, line.productId),
            ),
          )
          .orderBy(asc(AmountToBeRefundedLog.id))
          .limit(1);
        if (!refund)
          // Legacy raises AttributeError here, after API-v2 already cancelled; keep going instead.
          warn('ORDER_CANCEL_REFUND_LOG_MISSING', 'Cancelled order line has no refund audit row');
        else if (refund.points || refund.money || refund.voucher)
          await tx.insert(PosTransactionLog).values({
            order_id: id,
            store_id: store,
            order_status: 4n,
            payment_status: 2n,
            user_id: 0n,
            pos_user_id: operator,
            pay_dict: cancelRefundPayDict(refund.points, refund.money, refund.voucher),
            comment: `Order cancel refund for Product id: ${productId}`,
            created_at: date,
            updated_at: date,
          });
        const stocks = await tx
          .select({
            id: ProductStore.id,
            stock: ProductStore.stock,
            available: ProductStore.is_avail,
            deleted: ProductStore.is_del,
          })
          .from(ProductStore)
          .where(and(eq(ProductStore.store, store), eq(ProductStore.product, line.productId)))
          .orderBy(asc(ProductStore.id))
          .for('update');
        const current = stocks[0];
        if (!current) continue;
        const stock = current.stock + Number(line.quantity);
        // `sync_pos_inventory` calls the procedure once per matching row and swallows failures.
        for (let row = 0; row < stocks.length; row++)
          try {
            await options.stockProcedure!(tx, {
              storeId,
              productId,
              stock,
              operatorId: user.id,
              comment: `Product inventory added from admin panel on order cancel, [Order ID:${orderId}]`,
            });
          } catch (error) {
            if (transactionAborted(error)) throw error;
            warn('ORDER_CANCEL_STOCK_LOG_FAILED', 'Stock procedure failed during order cancel');
          }
        // `product_stock.save()` writes the loaded row back with the new stock.
        await tx
          .update(ProductStore)
          .set({ stock, is_avail: current.available, is_del: current.deleted })
          .where(eq(ProductStore.id, current.id));
        synced.push(productId);
      }
    });
    return synced;
  }

  return {
    async context(user: Principal, storeId: string, orderId: string): Promise<CancellationContext> {
      const order = await read((tx) => inspect(tx, user, storeId, orderId));
      return { orderId, storeId, eligible: order.eligible };
    },
    async create(user: Principal, storeId: string, orderId: string): Promise<CancellationResult> {
      if (!options.client)
        throw new AppError(
          503,
          'ORDER_CANCEL_UNAVAILABLE',
          'The order cancellation service is not configured.',
        );
      if (!options.stockProcedure)
        throw new AppError(
          503,
          'ORDER_CANCEL_STOCK_UNAVAILABLE',
          'Stock restoration is not configured, so orders cannot be cancelled.',
        );
      const order = await read((tx) => inspect(tx, user, storeId, orderId));
      if (!order.eligible)
        throw new AppError(
          409,
          'ORDER_NOT_CANCELLABLE',
          'Only a pending cash-on-counter order that is still placed can be cancelled.',
        );
      const key = cancellationLockKey(orderId),
        token = randomUUID(),
        inflight = JSON.stringify({ status: 'inflight', operatorId: user.id, token });
      if (!(await options.stateStore.set(key, inflight, CANCELLATION_LOCK_TTL_SECONDS, true)))
        throw new AppError(
          409,
          'ORDER_CANCEL_IN_PROGRESS',
          'This order is already being cancelled. Refresh the order to see its status.',
        );
      let outcome;
      try {
        outcome = await options.client.cancel({ userId: order.customerId, orderId });
      } catch (error) {
        // API-v2 refuses a repeat ("Already refunded" / line not PLACED), so a retry is safe.
        await options.stateStore.deleteIfEquals(key, inflight);
        warn('ORDER_CANCEL_OUTCOME_UNKNOWN', 'Order cancel outcome is unknown');
        throw error;
      }
      if (!outcome.accepted) {
        await options.stateStore.deleteIfEquals(key, inflight);
        throw new AppError(
          outcome.status >= 500 ? 502 : 409,
          'ORDER_CANCEL_REJECTED',
          'Something went wrong. The order service did not cancel this order.',
        );
      }
      let synced: string[];
      try {
        synced = await applyLocalCancellation(user, storeId, orderId);
      } catch {
        warn('ORDER_CANCEL_LOCAL_UPDATE_FAILED', 'Order cancelled upstream but not locally');
        throw new AppError(
          500,
          'ORDER_CANCEL_LOCAL_UPDATE_FAILED',
          'The order service cancelled this order, but the store records were not updated. Contact support before trying again.',
        );
      }
      await options.stateStore.set(
        key,
        JSON.stringify({ status: 'cancelled', operatorId: user.id, token }),
        CANCELLATION_LOCK_TTL_SECONDS,
      );
      for (const productId of synced)
        try {
          if (!options.syncProducts) {
            warn('ORDER_CANCEL_PRODUCT_SYNC_UNAVAILABLE', 'Product sync is not configured');
            break;
          }
          await options.syncProducts(randomUUID(), [productId], {
            operatorId: user.id,
            storeId,
            requestId: currentRequestTrace()?.requestId,
          });
        } catch {
          // Legacy logs "Product not synced" and still answers 200.
          warn('ORDER_CANCEL_PRODUCT_SYNC_FAILED', 'Product not synced after order cancel');
        }
      return { orderId, storeId, status: 'cancelled', message: cancellationMessage };
    },
  };
}
