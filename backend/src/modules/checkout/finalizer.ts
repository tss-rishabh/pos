import { assertImportOrderMutationAvailable } from '../legacy-order-imports/financial-adapter-proof.js';
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  GiftVoucher,
  HasProduct,
  Order,
  OrderStore,
  OrderAddon,
  PosPaytmTransaction,
  PosTerminalTransaction,
  Store,
} from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { CheckoutState, PrepaidSettlement } from './contracts.js';
import { paymentOutbox } from './payments/schema.js';
import { currentRequestTrace } from '../../observability/context.js';
import { assertCheckoutProjection } from './projection.js';
import { assertCompletedGiftCardIssuance } from './gift-card-issuance.js';

/** Same fiscal-year and invoice representation as Helpers.get_financial_year. */
export function financialYear(date: string): string {
  const value = Temporal.PlainDate.from(date.slice(0, 10));
  const start = value.month >= 4 ? value.year : value.year - 1;
  return String(start).slice(-2) + String(start + 1).slice(-2);
}
/** Source Helpers.get_transaction_id preserves hyphen handling for Paytm. */
export function transactionIdentifier(
  orderId: string,
  reference: string,
  inactivePineCount: number,
  inactivePaytmCount: number,
  activePaytm: boolean,
): string {
  reference = activePaytm ? reference.replaceAll('-', '') : reference;
  const count =
    (inactivePineCount ? inactivePineCount + 1 : 0) +
    (inactivePaytmCount ? inactivePaytmCount + 1 : 0);
  if (count) {
    const suffix = activePaytm ? String(count) : `-${count}`,
      normalized = activePaytm ? reference.replaceAll('-', '') : reference;
    return `${normalized || orderId}${suffix}`;
  }
  const result = reference || orderId;
  return result.replaceAll('-', '').length >= 8 ? result : orderId;
}
export function orderFinalizer(
  db: Databases,
  config: Config,
  orderKind: 'ordinary' | 'exchange' = 'ordinary',
) {
  return async (
    state: Pick<
      CheckoutState,
      | 'storeId'
      | 'counterId'
      | 'customerId'
      | 'operatorCustomerId'
      | 'lineSalespersons'
      | 'salespersonId'
    > &
      Partial<Pick<CheckoutState, 'orderNotifications' | 'operatorId'>>,
    orderId: string,
  ) =>
    db.get('writer').transaction(async (tx) => {
      const [store] = await tx
        .select({ code: Store.location_code })
        .from(Store)
        .where(eq(Store.id, BigInt(state.storeId)))
        .for('update');
      // Read only a parent hint, then acquire both Orders in ID order. Taking
      // the child lock first would invert the return writer's parent locks.
      // The current locked parent is checked again before any mutation.
      const [parentHint] =
        orderKind === 'exchange'
          ? await tx
              .select({ id: Order.id, parentId: Order.parent_order_id })
              .from(Order)
              .where(eq(Order.id, BigInt(orderId)))
              .limit(1)
          : [];
      const expectedParent = orderKind === 'exchange' ? (parentHint?.parentId ?? 0n) : 0n,
        lockIds = [BigInt(orderId), ...(expectedParent > 0n ? [expectedParent] : [])].sort(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        );
      await tx
        .select({ id: Order.id })
        .from(Order)
        .where(inArray(Order.id, lockIds))
        .orderBy(asc(Order.id))
        .for('update');
      const [record] = await tx
        .select({
          id: OrderStore.id,
          parentId: Order.parent_order_id,
          invoice: OrderStore.order_invoice,
          reference: Order.order_ref_no,
          date: Order.updated_at,
          paymentStatus: Order.payment_statuses,
          orderStatus: Order.order_statuses,
          userId: Order.user,
        })
        .from(OrderStore)
        .innerJoin(Order, eq(Order.id, OrderStore.order))
        .where(
          and(
            eq(OrderStore.order, BigInt(orderId)),
            eq(OrderStore.store, BigInt(state.storeId)),
            eq(OrderStore.counter, BigInt(state.counterId)),
          ),
        )
        .for('update');
      if (!record || !store)
        throw new AppError(
          409,
          'CREATED_ORDER_SCOPE_MISMATCH',
          'The created order could not be confirmed in this store and counter.',
        );
      if (orderKind === 'exchange' && record.parentId !== expectedParent)
        throw new AppError(
          409,
          'EXCHANGE_PARENT_CHANGED',
          'The replacement parent changed before finalization.',
        );
      await assertImportOrderMutationAvailable(tx, orderId);
      if (orderKind === 'exchange' && expectedParent > 0n)
        await assertImportOrderMutationAvailable(tx, String(expectedParent));
      const customerId = state.customerId || state.operatorCustomerId;
      if (String(record.userId) !== customerId)
        throw new AppError(
          409,
          'CREATED_ORDER_CUSTOMER_MISMATCH',
          'The created order has a different customer. Review it before taking payment.',
        );
      // Exchange completion has its separately bound inventory proof in the
      // return repository. Ordinary orders require the full wallet/stock proof.
      if (orderKind === 'ordinary')
        await assertCheckoutProjection(tx, {
          orderId,
          storeId: state.storeId,
          counterId: state.counterId,
          customerId,
        });
      else if (record.paymentStatus === 4n && record.orderStatus === 3n)
        await assertCompletedGiftCardIssuance(tx, orderId);
      let invoice = record.invoice || null;
      if (!invoice) {
        const fy = financialYear(
          record.date ||
            Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString(),
        );
        const [last] = await tx
          .select({ invoice: OrderStore.order_invoice })
          .from(OrderStore)
          .where(
            and(
              eq(OrderStore.store, BigInt(state.storeId)),
              or(
                like(OrderStore.order_invoice, `${store.code}/${fy}/INV/%`),
                like(OrderStore.order_invoice, `${store.code}${fy}INV%`),
              ),
            ),
          )
          .orderBy(desc(OrderStore.order_invoice))
          .limit(1)
          .for('update');
        const sequence = last?.invoice ? Number(/(\d+)$/.exec(last.invoice)?.[1] || 0) + 1 : 1;
        invoice = `${store.code}${fy}INV${String(sequence).padStart(5, '0')}`;
        await tx
          .update(OrderStore)
          .set({ order_invoice: invoice })
          .where(eq(OrderStore.id, record.id));
      }
      await tx
        .update(GiftVoucher)
        .set({ status: record.paymentStatus === 4n && record.orderStatus === 3n ? 1 : 0 })
        .where(sql`${GiftVoucher.order_id} = ${orderId}`);
      const lines = await tx
        .select({ id: HasProduct.id, productId: HasProduct.product })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(orderId)));
      for (const line of lines) {
        const assigned = state.lineSalespersons[String(line.productId)] || state.salespersonId;
        if (assigned)
          await tx
            .update(HasProduct)
            .set({ salesperson_id: Number(assigned) })
            .where(eq(HasProduct.id, line.id));
      }
      const [pine] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(PosTerminalTransaction)
        .where(
          and(
            eq(PosTerminalTransaction.order_id, BigInt(orderId)),
            eq(PosTerminalTransaction.platform, 'txn_created'),
            eq(PosTerminalTransaction.is_active, false),
          ),
        );
      const [paytm] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(PosPaytmTransaction)
        .where(
          and(
            eq(PosPaytmTransaction.order_id, BigInt(orderId)),
            eq(PosPaytmTransaction.platform, 'txn_created'),
            eq(PosPaytmTransaction.is_active, false),
          ),
        );
      const [active] = await tx
        .select({ id: PosPaytmTransaction.id })
        .from(PosPaytmTransaction)
        .where(
          and(
            eq(PosPaytmTransaction.order_id, BigInt(orderId)),
            eq(PosPaytmTransaction.platform, 'txn_created'),
            eq(PosPaytmTransaction.is_active, true),
          ),
        )
        .limit(1);
      if (state.orderNotifications?.sendSms) {
        const timestamp = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
          .toPlainDateTime()
          .toString({ smallestUnit: 'second' })
          .replace('T', ' ');
        if (state.orderNotifications.npsFeedback) {
          const [addon] = await tx
            .select({ id: OrderAddon.id })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, BigInt(orderId)))
            .limit(1);
          if (addon)
            await tx
              .update(OrderAddon)
              .set({ is_nps_notification_checked: 1 })
              .where(eq(OrderAddon.order_id, BigInt(orderId)));
          else
            await tx.insert(OrderAddon).values({
              order_id: BigInt(orderId),
              shipped_location: 'MW1',
              is_nps_mail_sent: 0,
              hl_charges_refunded: 0,
              is_nps_notification_checked: 1,
              order_success_timestamp: timestamp,
              created_at: timestamp,
              updated_at: timestamp,
            });
        }
        const trace = currentRequestTrace(),
          id = `order-sms:${orderId}`;
        await tx
          .insert(paymentOutbox)
          .values({
            id,
            kind: 'order-sms',
            orderId,
            storeId: state.storeId,
            status: 'pending',
            requestId: trace?.requestId ?? null,
            operatorId: state.operatorId ?? trace?.userId ?? null,
            createdAt: timestamp,
          })
          .onDuplicateKeyUpdate({ set: { id } });
      }
      return {
        invoice,
        transactionId: transactionIdentifier(
          orderId,
          record.reference,
          Number(pine?.count || 0),
          Number(paytm?.count || 0),
          Boolean(active),
        ),
      };
    });
}

/** A zero-total order has no cash/terminal attempt. Verify committed allocation proof on every read. */
export function prepaidSettlementReader(db: Databases) {
  return async (state: CheckoutState): Promise<PrepaidSettlement | null> => {
    if (state.phase !== 'submitted' || !state.orderId || !state.orderSubmissionOperationId)
      return null;
    const orderId = state.orderId,
      receiptId = state.orderSubmissionOperationId;
    return db.get('writer').transaction(async (tx) => {
      const [row] = await tx
        .select({
          payment: Order.payment_statuses,
          status: Order.order_statuses,
          method: Order.payment_methods,
          payable: Order.pay_amt,
          reference: Order.order_ref_no,
          transaction: OrderStore.transaction_id,
          customer: Order.user,
        })
        .from(OrderStore)
        .innerJoin(Order, eq(Order.id, OrderStore.order))
        .where(
          and(
            eq(OrderStore.store, BigInt(state.storeId)),
            eq(OrderStore.counter, BigInt(state.counterId)),
            eq(OrderStore.order, BigInt(orderId)),
          ),
        )
        .limit(1)
        .for('update');
      if (row) await assertImportOrderMutationAvailable(tx, orderId);
      if (
        !row ||
        row.payment !== 4n ||
        row.status !== 3n ||
        row.method !== 3n ||
        row.payable !== 0 ||
        String(row.customer) !== (state.customerId || state.operatorCustomerId)
      )
        return null;
      await assertCheckoutProjection(tx, {
        orderId,
        storeId: state.storeId,
        counterId: state.counterId,
        customerId: state.customerId || state.operatorCustomerId,
      });
      return {
        status: 'paid',
        source: 'prepaid',
        orderId,
        receiptId,
        checkoutId: state.id,
        checkoutOperationId: receiptId,
        transactionId:
          row.transaction || transactionIdentifier(orderId, row.reference, 0, 0, false),
        cashAmount: '0.00',
        onlineAmount: '0.00',
      };
    });
  };
}
