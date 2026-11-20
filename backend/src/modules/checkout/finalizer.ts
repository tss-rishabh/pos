import { and, asc, eq, like, or, sql } from 'drizzle-orm';
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
import type { JobProducer } from '../../jobs/contract.js';
import { enqueueOrderSms } from './order-sms.js';
import { checkoutSubject } from './contracts.js';
import type { AdministrationTransaction } from '../administration/checkins.js';

/** Same fiscal-year and invoice representation as Helpers.get_financial_year. */
export function financialYear(date: string): string {
  const value = Temporal.PlainDate.from(date.slice(0, 10));
  const start = value.month >= 4 ? value.year : value.year - 1;
  return String(start).slice(-2) + String(start + 1).slice(-2);
}
/**
 * A LIKE pattern that matches `value` literally (MySQL's default escape character `\`), as
 * Django's `startswith` lookup escapes its argument (`prep_for_like_query`).
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
/** Source Helpers.get_transaction_id preserves hyphen handling for Paytm. */
export function transactionIdentifier(
  orderId: string,
  // orders.order_ref_no is nullable. Legacy helpers.py:714-737 treats None as falsy
  // (falls back to order_id) except under an active Paytm attempt, where
  // order_ref_no.replace() raises (helpers.py:730).
  reference: string | null,
  inactivePineCount: number,
  inactivePaytmCount: number,
  activePaytm: boolean,
): string {
  if (activePaytm) {
    if (reference === null)
      throw new Error('Legacy transaction ID requires order_ref_no with an active Paytm attempt.');
    reference = reference.replaceAll('-', '');
  }
  const count =
    (inactivePineCount ? inactivePineCount + 1 : 0) +
    (inactivePaytmCount ? inactivePaytmCount + 1 : 0);
  if (count) {
    const suffix = activePaytm ? String(count) : `-${count}`,
      normalized = activePaytm ? reference?.replaceAll('-', '') : reference;
    return `${normalized || orderId}${suffix}`;
  }
  const result = reference || orderId;
  return result.replaceAll('-', '').length >= 8 ? result : orderId;
}
type FinalizerState = Pick<
  CheckoutState,
  | 'storeId'
  | 'counterId'
  | 'customerId'
  | 'operatorCustomerId'
  | 'lineSalespersons'
  | 'salespersonId'
> &
  Partial<Pick<CheckoutState, 'orderNotifications' | 'operatorId'>>;

/**
 * Per-line salesperson, written right after `pos/order` and before the payment confirmation
 * (`order/views.py:2779-2795`): the per-product Redis value, else the master salesperson, else 0.
 * Legacy always writes the value, including 0.
 */
export function orderLineSalespersons(db: Databases) {
  return async (
    state: Pick<CheckoutState, 'lineSalespersons' | 'salespersonId'>,
    orderId: string,
  ) => {
    await db.get('writer').transaction(async (tx) => {
      const lines = await tx
        .select({ id: HasProduct.id, productId: HasProduct.product })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(orderId)))
        .orderBy(asc(HasProduct.id));
      for (const line of lines) {
        const assigned = state.lineSalespersons[String(line.productId)] || state.salespersonId;
        await tx
          .update(HasProduct)
          .set({ salesperson_id: assigned ? Number(assigned) : 0 })
          .where(eq(HasProduct.id, line.id));
      }
    });
  };
}

/**
 * The post-confirmation part of `AjaxOrderView.post` (`order/views.py:2797-2835`).
 * - The invoice number is generated whether or not the confirmation succeeded (2799-2809;
 *   `Helpers.generate_invoice_number`, helpers/helpers.py:2209-2249, from `orders.updated_at`).
 * - Only after a confirmed order: `gift_vouchers.status = 0` (2815-2818), the NPS add-on when the
 *   NPS switch is on (2821-2830) and the order SMS task (2831), queued after commit.
 */
export function orderFinalizer(
  db: Databases,
  config: Config,
  orderKind: 'ordinary' | 'exchange' = 'ordinary',
  jobs?: JobProducer,
) {
  return async (
    state: FinalizerState,
    orderId: string,
    outcome: { confirmed: boolean } = { confirmed: true },
  ) => {
    const work = async (tx: AdministrationTransaction) => {
      const [record] = await tx
        .select({
          id: OrderStore.id,
          storeId: OrderStore.store,
          invoice: OrderStore.order_invoice,
          reference: Order.order_ref_no,
          date: Order.updated_at,
        })
        .from(OrderStore)
        .innerJoin(Order, eq(Order.id, OrderStore.order))
        .where(eq(OrderStore.order, BigInt(orderId)))
        .orderBy(asc(OrderStore.id))
        .limit(1)
        .for('update');
      let invoice = record?.invoice || null;
      if (record && !invoice) {
        const [store] = await tx
          .select({ code: Store.location_code })
          .from(Store)
          .where(eq(Store.id, record.storeId))
          .limit(1)
          .for('update');
        const fy = financialYear(
          record.date ||
            Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString(),
        );
        // `Helpers.generate_invoice_number` (helpers.py:2208-2245) formats the nullable
        // `Store.location_code` in f-strings, so a NULL code is 'None'. Its Django
        // `startswith` lookups escape `\ % _`, so the code is matched literally.
        const code = store?.code ?? 'None',
          literal = likeLiteral(code);
        const [last] = await tx
          .select({ invoice: sql<string | null>`max(${OrderStore.order_invoice})` })
          .from(OrderStore)
          .where(
            and(
              eq(OrderStore.store, record.storeId),
              or(
                like(OrderStore.order_invoice, `${literal}/${fy}/INV/%`),
                like(OrderStore.order_invoice, `${literal}${fy}INV%`),
              ),
            ),
          )
          .for('update');
        const sequence = last?.invoice ? Number(/(\d+)$/.exec(last.invoice)?.[1] || 0) + 1 : 1;
        invoice = `${code}${fy}INV${String(sequence).padStart(5, '0')}`;
        await tx
          .update(OrderStore)
          .set({ order_invoice: invoice })
          .where(eq(OrderStore.order, BigInt(orderId)));
      }
      if (outcome.confirmed) {
        // "Update zero beacuse payment not done yet" (order/views.py:2815-2818).
        await tx
          .update(GiftVoucher)
          .set({ status: 0 })
          .where(eq(GiftVoucher.order_id, BigInt(orderId)));
        if (orderKind === 'ordinary' && state.orderNotifications?.npsFeedback) {
          const timestamp = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
            .toPlainDateTime()
            .toString({ smallestUnit: 'second' })
            .replace('T', ' ');
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
      return {
        invoice,
        transactionId: transactionIdentifier(
          orderId,
          record?.reference ?? null,
          Number(pine?.count || 0),
          Number(paytm?.count || 0),
          Boolean(active),
        ),
      };
    };
    const result = await db.get('writer').transaction(work);
    // `tasks.send_sms.delay(order)` runs after the confirmed order (2831); the job is queued only
    // after the transaction above committed.
    if (outcome.confirmed && orderKind === 'ordinary' && state.orderNotifications)
      await enqueueOrderSms(jobs, orderId);
    return result;
  };
}

/**
 * Operator-driven confirmation reconciliation: the created order must exist for this sale's
 * store and counter. A writer read only; it never re-sends pos/order or the confirmation.
 */
export function createdOrderVerifier(db: Databases) {
  return async (state: Pick<CheckoutState, 'storeId' | 'counterId'>, orderId: string) => {
    const [row] = await db
      .get('writer')
      .select({ id: OrderStore.id })
      .from(OrderStore)
      .where(
        and(
          eq(OrderStore.order, BigInt(orderId)),
          eq(OrderStore.store, BigInt(state.storeId)),
          eq(OrderStore.counter, BigInt(state.counterId)),
        ),
      )
      .limit(1);
    if (!row)
      throw new AppError(
        409,
        'CREATED_ORDER_SCOPE_MISMATCH',
        'The created order could not be found in this store and counter.',
      );
  };
}

/** A zero-total order has no cash/terminal attempt. Verify committed allocation proof on every read. */
export function prepaidSettlementReader(db: Databases) {
  return async (state: CheckoutState): Promise<PrepaidSettlement | null> => {
    if (state.phase !== 'submitted' || !state.orderId || !state.orderSubmissionOperationId)
      return null;
    const orderId = state.orderId,
      receiptId = state.orderSubmissionOperationId;
    const work = async (tx: AdministrationTransaction): Promise<PrepaidSettlement | null> => {
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
      if (
        !row ||
        row.payment !== 4n ||
        row.status !== 3n ||
        row.method !== 3n ||
        row.payable !== 0 ||
        String(row.customer) !== checkoutSubject(state)
      )
        return null;
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
    };
    return db.get('writer').transaction(work);
  };
}
