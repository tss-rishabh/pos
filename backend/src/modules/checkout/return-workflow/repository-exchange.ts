import { and, asc, desc, eq, like, or } from 'drizzle-orm';
import {
  Comments,
  HasProduct,
  Order,
  OrderAddon,
  OrderStore,
  OrderStatus,
  PosExchangeLog,
  PosTransactionLog,
  Store,
} from '../../../db/legacy-schema.js';
import { hasProductStatuses } from '../../../db/legacy-enums.js';
import { storedEnumValue } from '../../../db/legacy-columns.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { financialYear } from '../finalizer.js';
import { pythonFloatRepr } from '../../../domain/python-compat.js';
import type { ReturnRepositoryCore } from './repository-core.js';

/**
 * The exchange lifecycle: restore, the replacement order claim and its outcome, and
 * exchange completion.
 */
export function exchangeLifecycleOperations(core: ReturnRepositoryCore) {
  const {
    db,
    state,
    timestamp,
    stamp,
    assertExchangeOffered,
    load,
    owned,
    restore,
    exchangeSelection,
    phaseOneProof,
  } = core;
  return {
    async restoreExchange(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'exchange' || !operation.exchange)
        throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
      if (operation.phase === 'old-item-restored') return operation;
      if (operation.phase !== 'inbound-accepted')
        throw new AppError(
          409,
          'EXCHANGE_PHASE_CHANGED',
          'This exchange is not ready for stock restoration.',
        );
      const next = await db.get('writer').transaction(async (tx) => {
        const { line } = await owned(tx, user, operation);
        await phaseOneProof(tx, operation, line.status);
        await restore(tx, user, operation);
        return stamp({ ...operation, phase: 'old-item-restored' });
      });
      return state.saveOperation(next);
    },
    /** Retry bookkeeping (order/views.py:1116-1122) and the live stock re-check. */
    async claimReplacement(
      user: Principal,
      storeId: string,
      id: string,
      retrySalespersonId?: string,
    ) {
      const operation = await load(user, storeId, id);
      if (
        operation.kind !== 'exchange' ||
        !operation.exchange ||
        !['old-item-restored', 'replacement-rejected'].includes(operation.phase)
      )
        throw new AppError(
          409,
          'EXCHANGE_REVIEW_REQUIRED',
          'This item is no longer awaiting an exchange. Please refresh the page.',
        );
      const exchange = operation.exchange,
        retry = operation.phase === 'replacement-rejected';
      const next = await db.get('writer').transaction(async (tx) => {
        const scope = await owned(tx, user, operation);
        // S35: the retry button of a failed exchange (order/views.py:1016-1035).
        if (retry)
          await assertExchangeOffered(tx, user.id, operation.orderId, scope.line.product, true);
        await phaseOneProof(tx, operation, scope.line.status);
        const [log] = await tx
          .select()
          .from(PosExchangeLog)
          .where(eq(PosExchangeLog.id, BigInt(exchange.logId)))
          .limit(1)
          .for('update');
        if (!log || log.retry_count >= 32767)
          throw new AppError(
            409,
            'EXCHANGE_LEDGER_UNAVAILABLE',
            'The exchange tracking record is unavailable.',
          );
        if (log.status === 'SUCCESS')
          throw new AppError(
            409,
            'EXCHANGE_ALREADY_COMPLETED',
            'This item has already been exchanged.',
          );
        if (retry && String(log.store_id) !== storeId) {
          const [origin] = await tx
            .select({ name: Store.store_name })
            .from(Store)
            .where(eq(Store.id, BigInt(log.store_id)))
            .limit(1);
          throw new AppError(
            409,
            'EXCHANGE_WRONG_STORE',
            `This exchange was started at ${origin?.name || `store ${log.store_id}`}. Please retry it from there.`,
          );
        }
        const selected = await exchangeSelection(
          tx,
          scope,
          {
            replacementProductId: exchange.newProductId,
            salespersonId: retrySalespersonId || exchange.salespersonId,
          },
          retry,
          exchange.newSize,
        );
        await tx
          .update(PosExchangeLog)
          .set({
            status: 'PENDING',
            staff_user_id: Number(user.id),
            retry_count: log.retry_count + (retry ? 1 : 0),
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, log.id));
        return stamp({
          ...operation,
          exchange: { ...exchange, salespersonId: selected.salespersonId },
          phase: 'replacement-dispatching',
          uncertainStage: null,
          errorCode: null,
          message: null,
        });
      });
      return state.saveOperation(next);
    },
    async replacementConfirmed(user: Principal, storeId: string, id: string, childOrderId: string) {
      const operation = await load(user, storeId, id);
      if (
        operation.kind !== 'exchange' ||
        !operation.exchange ||
        operation.phase !== 'replacement-dispatching'
      )
        throw new AppError(
          409,
          'EXCHANGE_PHASE_CHANGED',
          'This exchange phase changed. Review its current status.',
        );
      const exchange = operation.exchange;
      await db
        .get('writer')
        .update(PosExchangeLog)
        .set({
          new_order_id: BigInt(childOrderId) <= 2147483647n ? Number(childOrderId) : null,
          status: 'SUCCESS',
          updated_at: timestamp(),
        })
        .where(eq(PosExchangeLog.id, BigInt(exchange.logId)));
      return state.saveOperation(
        stamp({
          ...operation,
          phase: 'replacement-confirmed',
          exchange: { ...exchange, childOrderId },
        }),
      );
    },
    /** FAILED_NEEDS_MANUAL_FIX + last_error (order/views.py:1286-1290). */
    async replacementFailure(user: Principal, storeId: string, id: string, message: string) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'exchange' || !operation.exchange)
        throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
      if (operation.phase !== 'replacement-dispatching') return { operation, retryCount: null };
      const [log] = await db
        .get('writer')
        .select({ retryCount: PosExchangeLog.retry_count })
        .from(PosExchangeLog)
        .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)))
        .limit(1);
      await db
        .get('writer')
        .update(PosExchangeLog)
        .set({
          status: 'FAILED_NEEDS_MANUAL_FIX',
          last_error: message,
          updated_at: timestamp(),
        })
        .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
      return {
        operation: await state.saveOperation(
          stamp({
            ...operation,
            phase: 'replacement-rejected',
            uncertainStage: null,
            errorCode: 'EXCHANGE_REPLACEMENT_FAILED',
            message,
          }),
        ),
        retryCount: log?.retryCount ?? 0,
      };
    },
    /** order/views.py:1188-1278: invoice, delivered status, comments, logs, addon. */
    async completeExchange(
      user: Principal,
      storeId: string,
      id: string,
      onInvoiceError: (error: unknown) => void,
    ) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'exchange' || !operation.exchange)
        throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
      if (operation.phase === 'completed')
        return { operation, alreadyFinished: true, replacementLineId: null };
      const exchange = operation.exchange,
        childId = exchange.childOrderId;
      if (operation.phase !== 'replacement-confirmed' || !childId)
        throw new AppError(
          409,
          'EXCHANGE_CHILD_UNCONFIRMED',
          'The replacement order must be confirmed first.',
        );
      if (BigInt(childId) > 2147483647n)
        throw new AppError(
          409,
          'EXCHANGE_IDENTIFIER_UNSUPPORTED',
          'This replacement order exceeds the supported legacy ledger identifiers.',
        );
      const result = await db.get('writer').transaction(async (tx) => {
        const { line, order, store } = await owned(tx, user, operation);
        const [child] = await tx
          .select({
            id: Order.id,
            parentId: Order.parent_order_id,
            status: Order.order_statuses,
            wallet: Order.tss_money_used,
            updatedAt: Order.updated_at,
          })
          .from(Order)
          .where(eq(Order.id, BigInt(childId)))
          .limit(1)
          .for('update');
        // Secure option: never mark an order that is not this line's replacement child.
        if (!child || child.parentId !== BigInt(operation.orderId))
          throw new AppError(
            409,
            'EXCHANGE_CHILD_SCOPE_MISMATCH',
            'The replacement order does not match this exchange.',
          );
        // Invoice number as soon as the child exists (views.py:1192-1203); errors are only logged.
        try {
          await tx.transaction(async (savepoint) => {
            const stores = await savepoint
              .select({ id: OrderStore.id, invoice: OrderStore.order_invoice })
              .from(OrderStore)
              .where(eq(OrderStore.order, child.id))
              .orderBy(asc(OrderStore.id))
              .limit(1)
              .for('update');
            if (stores[0] && !stores[0].invoice) {
              const code = store.locationCode ?? 'None',
                fy = financialYear(
                  child.updatedAt && !child.updatedAt.startsWith('0000')
                    ? child.updatedAt
                    : timestamp(),
                );
              const [last] = await savepoint
                .select({ invoice: OrderStore.order_invoice })
                .from(OrderStore)
                .where(
                  and(
                    eq(OrderStore.store, BigInt(storeId)),
                    or(
                      // Django `startswith` escapes `\ % _`: the store code matches literally.
                      like(
                        OrderStore.order_invoice,
                        `${code.replace(/[\\%_]/g, '\\$&')}/${fy}/INV/%`,
                      ),
                      like(OrderStore.order_invoice, `${code.replace(/[\\%_]/g, '\\$&')}${fy}INV%`),
                    ),
                  ),
                )
                .orderBy(desc(OrderStore.order_invoice))
                .limit(1)
                .for('update');
              const sequence = last?.invoice
                ? Number(/(\d+)$/.exec(last.invoice)?.[1] || 0) + 1
                : 1;
              await savepoint
                .update(OrderStore)
                .set({ order_invoice: `${code}${fy}INV${String(sequence).padStart(5, '0')}` })
                .where(eq(OrderStore.order, child.id));
            }
          });
        } catch (error) {
          onInvoiceError(error);
        }
        const alreadyFinished = child.status === 3n;
        const [status] = await tx
          .select({ name: OrderStatus.order_status })
          .from(OrderStatus)
          .where(eq(OrderStatus.id, 3n))
          .limit(1);
        if (!status)
          throw new AppError(
            503,
            'ORDER_STATUS_UNAVAILABLE',
            'Delivered order status is unavailable.',
          );
        await tx
          .update(Order)
          .set({ payment_statuses: 4n, order_statuses: 3n })
          .where(eq(Order.id, child.id));
        const [replacement] = await tx
          .select({ id: HasProduct.id })
          .from(HasProduct)
          .where(eq(HasProduct.order, child.id))
          .orderBy(asc(HasProduct.id))
          .limit(1);
        const date = timestamp();
        if (!alreadyFinished)
          await tx.insert(Comments).values({
            order_id: child.id,
            status_id: 3n,
            comment: `Store Order: ${status.name} status changed by pos admin (exchange).`,
            notify: 0,
            user_id: BigInt(user.id),
            package_details: '',
            has_product_id: replacement?.id ?? 0n,
            prod_id: BigInt(exchange.newProductId),
            created_at: date,
            updated_at: date,
          });
        await tx
          .update(HasProduct)
          .set({ status: storedEnumValue(hasProductStatuses, status.name) })
          .where(eq(HasProduct.order, child.id));
        await tx
          .update(HasProduct)
          .set({ status: 'EXCHANGE_COMPLETED' })
          .where(and(eq(HasProduct.id, line.id), eq(HasProduct.order, BigInt(operation.orderId))));
        if (!alreadyFinished) {
          const wallet = pythonFloatRepr(child.wallet);
          await tx.insert(PosTransactionLog).values([
            {
              order_id: BigInt(operation.orderId),
              store_id: BigInt(storeId),
              order_status: order.status ?? 0n,
              payment_status: order.paymentStatus ?? 0n,
              user_id: 0n,
              pos_user_id: BigInt(user.id),
              pay_dict: `{'tss money used': ${wallet}, 'total amount on counter': 0, 'has_product id': ${operation.lineId}, 'sku id': ${operation.productId}}`,
              comment: `Exchanged : TSS Money Used ${wallet} (New order ${childId} created)`,
              created_at: date,
              updated_at: date,
            },
            {
              order_id: child.id,
              store_id: BigInt(storeId),
              order_status: 3n,
              payment_status: 4n,
              user_id: 0n,
              pos_user_id: BigInt(user.id),
              pay_dict: `{'tss money used': ${wallet}, 'total amount on counter': 0}`,
              comment: `Order Delivered : TSS Money Used ${wallet} (Exchange from order ${operation.orderId})`,
              created_at: date,
              updated_at: date,
            },
          ]);
        }
        const [parentAddon] = await tx
            .select({ checked: OrderAddon.is_nps_notification_checked })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, BigInt(operation.orderId)))
            .orderBy(asc(OrderAddon.id))
            .limit(1),
          [childAddon] = await tx
            .select({ id: OrderAddon.id })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, child.id))
            .limit(1)
            .for('update'),
          addon = {
            shipped_location: 'MW1' as const,
            is_nps_mail_sent: 0,
            is_nps_notification_checked: parentAddon ? parentAddon.checked : 0,
          };
        if (childAddon)
          await tx.update(OrderAddon).set(addon).where(eq(OrderAddon.id, childAddon.id));
        else
          await tx.insert(OrderAddon).values({
            ...addon,
            order_id: child.id,
            hl_charges_refunded: 0,
            order_success_timestamp: date,
            order_transferred_timestamp: null,
            created_at: date,
            updated_at: date,
          });
        await tx
          .update(PosExchangeLog)
          .set({
            status: 'SUCCESS',
            new_order_id: Number(childId),
            last_error: null,
            updated_at: date,
          })
          .where(eq(PosExchangeLog.id, BigInt(exchange.logId)));
        return {
          next: stamp({
            ...operation,
            phase: 'completed',
            errorCode: null,
            uncertainStage: null,
            message: 'Exchange completed successfully.',
          }),
          alreadyFinished,
          replacementLineId: replacement ? String(replacement.id) : null,
        };
      });
      return {
        operation: await state.saveOperation(result.next),
        alreadyFinished: result.alreadyFinished,
        replacementLineId: result.replacementLineId,
      };
    },
  };
}
