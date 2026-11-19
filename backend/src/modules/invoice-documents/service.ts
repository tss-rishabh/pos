import { and, asc, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  HasProduct,
  Order,
  OrderStore,
  PaymentStatus,
  Store,
  UserStore,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { sanitizeInvoiceHtml } from '../checkout/invoices.js';
import type { InvoiceAdapter, WhatsappInvoiceOutcome } from './adapter.js';
import type {
  InvoiceCapabilities,
  InvoiceDocument,
  InvoiceDocumentScope,
  InvoiceKind,
} from './contracts.js';
import type { InvoiceDocumentOptions } from './options.js';

/** Legacy flash text "Unauthorized access to the store order." (`order/views.py:792`). */
const unauthorized = () =>
  new AppError(404, 'ORDER_NOT_FOUND', 'Unauthorized access to the store order.');
const missing = () => new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
const filename = (kind: InvoiceKind, orderId: string) =>
  `${kind === 'store' ? '' : `${kind}-`}tax-invoice-${orderId}.html`;

export function invoiceDocumentService(
  config: Config,
  db: Databases,
  options: InvoiceDocumentOptions,
  adapter: InvoiceAdapter,
  log: (outcome: WhatsappInvoiceOutcome) => void = () => {},
) {
  const reader = () => db.get('primary');
  /** `user_stores` for role != 1, every active store for role 1 (`order/views.py:780-783`). */
  async function userCanUseStore(user: Principal, storeId: string) {
    const [row] =
      user.role === 1
        ? await reader()
            .select({ id: Store.id })
            .from(Store)
            .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
            .limit(1)
        : await reader()
            .select({ id: UserStore.id })
            .from(UserStore)
            .where(
              and(
                eq(UserStore.django_user_id, BigInt(user.id)),
                eq(UserStore.store_id, BigInt(storeId)),
              ),
            )
            .limit(1);
    return Boolean(row);
  }
  async function existingOrder(orderId: string) {
    const [order] = await reader()
      .select({ id: Order.id })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    if (!order) throw missing();
  }
  /**
   * `ShowOrderInvoiceView` (`order/views.py:769-833`). Store orders need an `order_stores` row
   * in the user's stores, unless `?cr=1` (`global-online` access) where any row suffices.
   * Express (`?is_hl=1&store_id=`): only that store's `express_line_item` lines are rendered.
   */
  async function storeInvoice(user: Principal, scope: InvoiceDocumentScope, express: boolean) {
    let hasProductIds: string[] | null = null;
    let number: string | null = null;
    if (express) {
      // Security (W5): legacy skips every store check for is_hl and renders the whole order
      // when the store has no express lines. The rewrite requires access to that store and
      // at least one of its express lines.
      if (!(await userCanUseStore(user, scope.storeId))) throw unauthorized();
      const lines = await reader()
        .select({ id: ExpressLineItem.has_product })
        .from(ExpressLineItem)
        .where(
          and(
            eq(ExpressLineItem.order, BigInt(scope.orderId)),
            eq(ExpressLineItem.store_id, Number(scope.storeId)),
          ),
        );
      hasProductIds = lines.flatMap((row) => (row.id === null ? [] : [String(row.id)]));
      if (!hasProductIds.length) throw unauthorized();
    } else {
      const rows = await reader()
        .select({ storeId: OrderStore.store, number: OrderStore.order_invoice })
        .from(OrderStore)
        .where(eq(OrderStore.order, BigInt(scope.orderId)))
        .orderBy(asc(OrderStore.id));
      const visible = scope.access
        ? rows
        : rows.filter((row) => String(row.storeId) === scope.storeId);
      if (!visible.length || (!scope.access && !(await userCanUseStore(user, scope.storeId))))
        throw unauthorized();
      number = visible[0]!.number || null;
    }
    if (options.whatsappInvoice) {
      // ENABLE_WHATSAPP_INVOICE: every store-invoice GET after the access checks
      // (`order/views.py:797-798`); a failure is only logged and the page still renders.
      const outcome = await adapter.sendWhatsappInvoice(scope.orderId);
      if (outcome !== 'sent') log(outcome);
    }
    return { html: await adapter.storeReceipt(scope.orderId, hasProductIds), number };
  }
  return {
    async document(
      user: Principal,
      scope: InvoiceDocumentScope,
      kind: InvoiceKind,
    ): Promise<InvoiceDocument> {
      let source: { html: string; number: string | null };
      if (kind === 'store' || kind === 'express')
        source = await storeInvoice(user, scope, kind === 'express');
      else {
        // `ShowOnlineOrderInvoiceView` / `ShowOnlineSDDOrderInvoiceView` check only the login.
        await existingOrder(scope.orderId);
        source = {
          html:
            kind === 'online'
              ? await adapter.onlineInvoice(scope.orderId)
              : await adapter.sameDayReceipt(scope.orderId),
          number: null,
        };
      }
      return {
        ...(scope.access ? { access: scope.access } : {}),
        kind,
        storeId: scope.storeId,
        orderId: scope.orderId,
        number: source.number,
        filename: filename(kind, scope.orderId),
        // Security (W5): legacy renders the renderer HTML with `|safe`; the rewrite sanitizes it.
        html: sanitizeInvoiceHtml(source.html),
      };
    },
    /**
     * Which online-detail invoice links legacy renders (`order/online/show.html:233-243`): the
     * full invoice when the payment status is "Paid", plus the SDD invoice for a split order
     * with both SDD (order_platform 3/4) and normal shipments (`Helpers.has_multiple_shipment`).
     */
    async capabilities(
      _user: Principal,
      scope: InvoiceDocumentScope,
    ): Promise<InvoiceCapabilities> {
      const [order] = await reader()
        .select({ split: Order.is_split_order, payment: PaymentStatus.payment_status })
        .from(Order)
        .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
        .where(eq(Order.id, BigInt(scope.orderId)))
        .limit(1);
      if (!order) throw missing();
      const actions: InvoiceCapabilities['actions'] = [];
      if (order.payment === 'Paid') {
        actions.push({ kind: 'online', available: Boolean(options.onlineInvoiceUrl) });
        if (order.split) {
          const platforms = await reader()
            .selectDistinct({ platform: HasProduct.order_platform })
            .from(HasProduct)
            .where(eq(HasProduct.order, BigInt(scope.orderId)));
          const sdd = platforms.some((row) => [3n, 4n].includes(row.platform)),
            normal = platforms.some((row) => ![3n, 4n].includes(row.platform));
          if (sdd && normal)
            actions.push({ kind: 'same-day', available: Boolean(options.sameDayReceiptUrl) });
        }
      }
      return {
        ...(scope.access ? { access: scope.access } : {}),
        storeId: scope.storeId,
        orderId: scope.orderId,
        actions,
      };
    },
  };
}
export type InvoiceDocumentService = ReturnType<typeof invoiceDocumentService>;
