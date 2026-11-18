import { sourceIntId as integerId } from './source-id.js';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, min, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  HyperlocalRejectionReason,
  Notification,
  Order,
  OrderStatus,
  PaymentStatus,
  Product,
  UsersNotification,
} from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import {
  assertCurrentOperatorIdentity,
  assertCurrentStoreAccess,
} from '../administration/authorization.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { productImage } from '../catalog.js';
import {
  calendarBounds,
  fulfillmentOrderFacts,
  localTimestamp,
  tabStatuses,
  type ExpressStatus,
  type FulfillmentLine,
  type FulfillmentTab,
} from './domain.js';
import type { CheckInReader } from './checkin.js';
import type { FulfillmentEffects } from './effects.js';
import { pythonIdList } from './effects.js';
import type { FulfillmentOptions } from './options.js';
import { slackText } from './slack-text.js';

function safeNotificationUrl(value: string | null): string | null {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    // WHATWG parsing normalizes slash/backslash prefixes into network URLs.
    // Validate the actual destination rather than a leading-slash regex alone.
    const origin = 'https://pos.invalid';
    const parsed = new URL(value, origin);
    return parsed.origin === origin && !parsed.username && !parsed.password ? value : null;
  } catch {
    return null;
  }
}

const parentProduct = alias(Product, 'fulfillment_parent_product');
export const lineSelection = {
  id: ExpressLineItem.id,
  orderId: ExpressLineItem.order,
  storeId: ExpressLineItem.store_id,
  hasProductId: ExpressLineItem.has_product,
  status: ExpressLineItem.status,
  pendingExpiresAt: ExpressLineItem.pending_expires_at,
  acceptedExpiresAt: ExpressLineItem.accepted_expires_at,
  productId: HasProduct.product,
  productName: Product.product,
  productStatus: HasProduct.status,
  quantity: HasProduct.qty,
  preGstAmount: HasProduct.pre_gst_amt,
  gst: HasProduct.gst,
  awb: HasProduct.awb,
  shipmentId: HasProduct.shipment_id,
  vincStatus: ExpressLineItem.vinc_status,
};
/** `lineSelection` plus the card columns of `_order_cards.html` (price, image, product link). */
const cardLineSelection = {
  ...lineSelection,
  price: HasProduct.price,
  images: Product.images_new,
  parentImages: parentProduct.images_new,
  parentProductId: Product.parent_prod_id,
};
type LineRecord = { [K in keyof typeof lineSelection]: unknown } & {
  price?: unknown;
  images?: unknown;
  parentImages?: unknown;
  parentProductId?: unknown;
};
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
export function linesToDto(rows: LineRecord[]): FulfillmentLine[] {
  return rows.map((row) => ({
    id: String(row.id),
    orderId: String(row.orderId),
    storeId: String(row.storeId),
    hasProductId: String(row.hasProductId),
    status: text(row.status),
    pendingExpiresAt: text(row.pendingExpiresAt),
    acceptedExpiresAt: text(row.acceptedExpiresAt),
    productId: text(row.productId),
    productName: text(row.productName),
    productStatus: text(row.productStatus),
    quantity: text(row.quantity),
    preGstAmount: row.preGstAmount === null ? null : Number(row.preGstAmount),
    gst: row.gst === null ? null : Number(row.gst),
    awb: text(row.awb),
    shipmentId: text(row.shipmentId),
    vincStatus: String(row.vincStatus || ''),
    price: text(row.price),
    image: row.images === undefined ? null : productImage(text(row.images), text(row.parentImages)),
    parentProductId: text(row.parentProductId),
  }));
}
const minimum = (values: (string | null)[]) =>
  values.filter((value): value is string => value !== null).sort()[0] ?? null;

export interface AdminFulfillmentEdit {
  status?: ExpressStatus;
  pendingExpiresAt?: string;
  acceptedExpiresAt?: string;
}
export interface FulfillmentResult {
  message: 'Success';
  updatedCount: number;
}
export interface FulfillmentServiceDependencies {
  checkins: CheckInReader;
  effects: FulfillmentEffects;
  clock?: () => Temporal.Instant;
}
const conflict = (code: string, message: string) => new AppError(409, code, message);

export function fulfillmentService(
  config: Config,
  databases: Databases,
  options: FulfillmentOptions,
  dependencies: FulfillmentServiceDependencies,
) {
  const clock = dependencies.clock ?? (() => Temporal.Now.instant()),
    { checkins, effects } = dependencies;
  const timestamp = () => localTimestamp(clock(), config.BUSINESS_TIMEZONE);

  /** Legacy `_hl_get_tab_counts` (`order/views.py:4696-4746`): today's order-id sets per tab. */
  async function tabSets(storeId: string) {
    const bounds = calendarBounds(clock(), config.BUSINESS_TIMEZONE);
    const rows = await databases
      .get('data')
      .selectDistinct({ orderId: ExpressLineItem.order, status: ExpressLineItem.status })
      .from(ExpressLineItem)
      .where(
        and(
          eq(ExpressLineItem.store_id, integerId(storeId)),
          or(
            and(
              eq(ExpressLineItem.status, 'PENDING'),
              gte(ExpressLineItem.pending_expires_at, bounds.start),
              lt(ExpressLineItem.pending_expires_at, bounds.end),
            ),
            and(
              inArray(ExpressLineItem.status, [
                'ACCEPTED',
                'PACKED',
                'OUT_FOR_DELIVERY',
                'DELIVERED',
                'RTO',
              ]),
              gte(ExpressLineItem.accepted_expires_at, bounds.start),
              lt(ExpressLineItem.accepted_expires_at, bounds.end),
            ),
          ),
        ),
      );
    const sets: Record<FulfillmentTab, Set<string>> = {
      in_queue: new Set(),
      not_packed: new Set(),
      packed: new Set(),
      shipped: new Set(),
    };
    for (const row of rows)
      if (row.orderId !== null)
        for (const tab of Object.keys(sets) as FulfillmentTab[])
          if (tabStatuses[tab].includes(row.status as ExpressStatus))
            sets[tab].add(String(row.orderId));
    return sets;
  }
  const sortIds = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  async function summary(storeId: string) {
    const sets = await tabSets(storeId);
    return {
      tabCounts: Object.fromEntries(
        Object.entries(sets).map(([tab, ids]) => [tab, ids.size]),
      ) as Record<FulfillmentTab, number>,
      orderIds: Object.fromEntries(
        Object.entries(sets).map(([tab, ids]) => [tab, sortIds(ids)]),
      ) as Record<FulfillmentTab, string[]>,
    };
  }
  /** Legacy `_hl_get_orders_for_tab` (`order/views.py:4749-4846`). */
  async function tabOrders(storeId: string, tab: FulfillmentTab, offset: number) {
    const limit = options.HL_PAGE_SIZE,
      ids = (await tabSets(storeId))[tab];
    if (!ids.size) return { data: [], hasMore: false, nextOffset: 0, orderIds: [] as string[] };
    const db = databases.get('data');
    const expires =
      tab === 'in_queue' ? ExpressLineItem.pending_expires_at : ExpressLineItem.accepted_expires_at;
    const rows = await db
      .select({
        id: Order.id,
        userId: Order.user,
        firstName: Order.first_name,
        lastName: Order.last_name,
        createdAt: Order.created_at,
        paymentStatus: PaymentStatus.payment_status,
        orderStatus: OrderStatus.order_status,
        expiresAt: min(expires),
      })
      .from(Order)
      .innerJoin(
        ExpressLineItem,
        and(eq(ExpressLineItem.order, Order.id), eq(ExpressLineItem.store_id, integerId(storeId))),
      )
      .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
      .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
      .where(inArray(Order.id, [...ids].map(BigInt)))
      .groupBy(Order.id)
      .orderBy(asc(min(expires)), asc(Order.id))
      .limit(limit)
      .offset(offset);
    const lineRows = rows.length
      ? await db
          .select(cardLineSelection)
          .from(ExpressLineItem)
          .leftJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
          .leftJoin(Product, eq(Product.id, HasProduct.product))
          .leftJoin(parentProduct, eq(parentProduct.id, Product.parent_prod_id))
          .where(
            and(
              eq(ExpressLineItem.store_id, integerId(storeId)),
              inArray(
                ExpressLineItem.order,
                rows.map((row) => row.id),
              ),
            ),
          )
          .orderBy(asc(ExpressLineItem.id))
      : [];
    const lines = linesToDto(lineRows);
    return {
      data: rows.map((row) => {
        const orderLines = lines.filter((line) => line.orderId === String(row.id));
        return {
          id: String(row.id),
          userId: String(row.userId),
          customerName: `${row.firstName} ${row.lastName}`,
          paymentStatus: row.paymentStatus,
          // `_order_cards.html:93`: "Partially Shipped" is shown as "Shipped".
          orderStatus: row.orderStatus === 'Partially Shipped' ? 'Shipped' : row.orderStatus,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          lines: orderLines,
          ...fulfillmentOrderFacts(orderLines),
        };
      }),
      hasMore: offset + limit < ids.size,
      nextOffset: offset + limit,
      orderIds: rows.map((row) => String(row.id)),
    };
  }
  /** The viewer's legacy check-in store (`Helpers.get_checkin_data(...)[0]`). */
  async function checkInStore(user: Principal) {
    return checkins.checkedInStore(user.id);
  }
  async function storeName(storeId: string) {
    const row = await effects.store(storeId);
    return {
      name: row ? (row.name ?? 'None') : `Store ${storeId}`,
      slackUrl: row?.slackUrl ?? null,
    };
  }
  async function readLines(
    executor: Pick<ReturnType<Databases['get']>, 'select'>,
    orderId: string,
    storeId: string,
    lock: boolean,
  ) {
    const scope = and(
      eq(ExpressLineItem.order, BigInt(orderId)),
      eq(ExpressLineItem.store_id, integerId(storeId)),
    );
    // Lock only this order/store's express rows, then read the joined product facts.
    if (lock)
      await executor
        .select({ id: ExpressLineItem.id })
        .from(ExpressLineItem)
        .where(scope)
        .for('update');
    return linesToDto(
      await executor
        .select(lineSelection)
        .from(ExpressLineItem)
        .leftJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
        .leftJoin(Product, eq(Product.id, HasProduct.product))
        .where(scope)
        .orderBy(asc(ExpressLineItem.id)),
    );
  }
  /**
   * Server-side form of the legacy card guards (`_order_cards.html:98-160`, countdown
   * `progress.html:500-520`): the legacy page never offers these actions in these states.
   */
  function assertActionable(
    action: 'ACCEPT' | 'REJECT' | 'PACK' | 'SHIP',
    lines: FulfillmentLine[],
  ) {
    if (!lines.length)
      throw new AppError(
        404,
        'FULFILLMENT_ORDER_NOT_FOUND',
        'No line items found for this order and store.',
      );
    const facts = fulfillmentOrderFacts(lines),
      now = timestamp();
    if (action === 'ACCEPT' || action === 'REJECT') {
      if (action === 'REJECT' && lines.some((line) => line.status === 'ACCEPTED'))
        throw conflict(
          'FULFILLMENT_REJECT_AFTER_ACCEPTANCE',
          'Accepted orders cannot be rejected. Pack the order or wait for the packing window.',
        );
      if (facts.isTimedOut)
        throw conflict(
          'FULFILLMENT_EXPIRED_AWAITING_ALLOCATION',
          'Expired – Waiting for Allocation',
        );
      if (!facts.isVincAllocated)
        throw conflict('FULFILLMENT_AWAITING_ALLOCATION', 'Waiting for Allocation');
      const expires = minimum(lines.map((line) => line.pendingExpiresAt));
      if (expires !== null && expires <= now)
        throw conflict(
          'FULFILLMENT_ACCEPTANCE_EXPIRED',
          'The acceptance window for this order has expired. It will be automatically rejected.',
        );
    }
    if (action === 'PACK') {
      if (!facts.hasShipmentId)
        throw conflict('FULFILLMENT_AWAITING_SHIPMENT_ID', 'Waiting for Shipment ID');
      const expires = minimum(lines.map((line) => line.acceptedExpiresAt));
      if (expires !== null && expires <= now)
        throw conflict(
          'FULFILLMENT_PACKING_EXPIRED',
          'The packing window for this order has expired. It will be packed automatically.',
        );
    }
    if (action === 'SHIP' && !facts.hasAwb)
      throw conflict('FULFILLMENT_AWAITING_AWB', 'Waiting for AWB');
  }
  async function authorize(user: Principal, storeId: string) {
    if (!/^[1-9]\d*$/.test(user.id))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    requireStore(user, storeId);
  }
  /** Legacy `AjaxExpressOrderMarkShippedView.mark_shipped` (`order/views.py:5092-5137`). */
  async function markShipped(orderId: string, storeId: string, operator: Principal | null) {
    const shipped = await retryTransaction(() =>
      databases.get('writer').transaction(async (tx) => {
        if (operator) await assertCurrentStoreAccess(tx, operator.id, storeId);
        const lines = (await readLines(tx, orderId, storeId, true)).filter(
          (line) => line.status === 'PACKED',
        );
        if (!lines.length) throw conflict('FULFILLMENT_STATE_CONFLICT', 'No packed items found');
        const hasProductIds = [...new Set(lines.map((line) => line.hasProductId))];
        const products = await tx
          .select({ id: HasProduct.id, awb: HasProduct.awb, productId: HasProduct.product })
          .from(HasProduct)
          .where(inArray(HasProduct.id, hasProductIds.map(BigInt)))
          .orderBy(asc(HasProduct.id));
        const now = timestamp();
        const [updated] = await tx
          .update(HasProduct)
          .set({ status: 'OUT_FOR_DELIVERY', updated_at: now })
          .where(inArray(HasProduct.id, hasProductIds.map(BigInt)));
        await tx
          .update(ExpressLineItem)
          .set({ status: 'OUT_FOR_DELIVERY', updated_at: now })
          .where(
            inArray(
              ExpressLineItem.id,
              lines.map((line) => integerId(line.id)),
            ),
          );
        const [ofd] = await tx
          .select({ id: OrderStatus.id })
          .from(OrderStatus)
          .where(eq(OrderStatus.order_status, 'Out For Delivery'))
          .orderBy(asc(OrderStatus.id))
          .limit(1);
        await tx
          .update(Order)
          .set({ order_statuses: ofd?.id ?? BigInt(options.OFD_ORDER_STATUS_ID), updated_at: now })
          .where(eq(Order.id, BigInt(orderId)));
        await tx.insert(ExpressOrderStatusLog).values({
          order_id: BigInt(orderId),
          store_id: integerId(storeId),
          old_status: 'PACKED',
          new_status: 'OUT_FOR_DELIVERY',
          changed_at: now,
        });
        return {
          hasProductIds,
          awb: products[0]?.awb ?? '',
          skus: products.map((row) => String(row.productId)),
          updatedCount: Number(updated.affectedRows),
        };
      }),
    );
    // External calls only after commit, i.e. only for the request that won the row lock.
    await effects.callStatusApi(orderId, shipped.hasProductIds, 'SHIP', true);
    await effects.outForDelivery(orderId, shipped.awb);
    const store = await storeName(storeId);
    await effects.slack(
      `🚚 Hyperlocal Order ID: ${orderId} Shipped from ${slackText(store.name)} | SKUs: ${pythonIdList(shipped.skus)}`,
      { slackUrl: store.slackUrl, sendToCommon: false },
    );
    return { message: 'Success' as const, updatedCount: shipped.updatedCount };
  }

  return {
    summary,
    tabOrders,
    checkInStore,
    /** Hyperlocal progress counts for the viewer's check-in store (`order/views.py:4940-4971`). */
    async progress(user: Principal) {
      const storeId = await checkInStore(user);
      if (!storeId)
        return {
          storeId: null,
          tabCounts: { in_queue: 0, not_packed: 0, packed: 0, shipped: 0 },
          orderIds: { in_queue: [], not_packed: [], packed: [], shipped: [] },
        };
      return { storeId, ...(await summary(storeId)) };
    },
    /** Progress content and Load More (`order/views.py:5284-5353`). */
    async progressOrders(user: Principal, tab: FulfillmentTab, offset: number) {
      const storeId = await checkInStore(user);
      if (!storeId) return { storeId: null, data: [], hasMore: false, nextOffset: 0, orderIds: [] };
      return { storeId, ...(await tabOrders(storeId, tab, offset)) };
    },
    /** Legacy `AjaxHyperlocalExpiryAlertsView` (`order/views.py:5356-5403`). */
    async expiryAlerts(user: Principal, storeId: string) {
      requireStore(user, storeId);
      const start = timestamp(),
        end = localTimestamp(clock().add({ minutes: 35 }), config.BUSINESS_TIMEZONE);
      const db = databases.get('data');
      const result: { orderId: string; type: 'pending' | 'accepted'; expiresAt: string }[] = [];
      for (const type of ['pending', 'accepted'] as const) {
        const expiry =
          type === 'pending'
            ? ExpressLineItem.pending_expires_at
            : ExpressLineItem.accepted_expires_at;
        const rows = await db
          .select({ orderId: ExpressLineItem.order, expiresAt: min(expiry) })
          .from(ExpressLineItem)
          .where(
            and(
              eq(ExpressLineItem.store_id, integerId(storeId)),
              eq(ExpressLineItem.status, type === 'pending' ? 'PENDING' : 'ACCEPTED'),
              gte(expiry, start),
              lte(expiry, end),
            ),
          )
          .groupBy(ExpressLineItem.order)
          .orderBy(asc(min(expiry)));
        result.push(
          ...rows.flatMap((row) =>
            row.expiresAt ? [{ orderId: String(row.orderId), type, expiresAt: row.expiresAt }] : [],
          ),
        );
      }
      const counts = await summary(storeId);
      return {
        expiringSoon: result,
        bannerCounts: {
          unaccepted: counts.tabCounts.in_queue,
          unpacked: counts.tabCounts.not_packed,
          packed: counts.tabCounts.packed,
        },
      };
    },
    async rejectionReasons() {
      const rows = await databases
        .get('primary')
        .select({ id: HyperlocalRejectionReason.id, reason: HyperlocalRejectionReason.reason })
        .from(HyperlocalRejectionReason)
        .where(eq(HyperlocalRejectionReason.is_active, true))
        .orderBy(asc(HyperlocalRejectionReason.id));
      return { data: rows.map((row) => ({ ...row, id: String(row.id) })) };
    },
    /** Accept All (`AjaxExpressLineItemsBulkActionView`, `order/views.py:5002-5014`). */
    async accept(user: Principal, storeId: string, orderId: string): Promise<FulfillmentResult> {
      await authorize(user, storeId);
      const updated = await retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId);
          const lines = await readLines(tx, orderId, storeId, true);
          assertActionable('ACCEPT', lines);
          const pending = lines.filter((line) => line.status === 'PENDING'),
            now = timestamp();
          if (pending.length)
            await tx
              .update(ExpressLineItem)
              .set({ status: 'ACCEPTED', updated_at: now })
              .where(
                inArray(
                  ExpressLineItem.id,
                  pending.map((line) => integerId(line.id)),
                ),
              );
          // Legacy writes this log row unconditionally (`order/views.py:5009`).
          await tx.insert(ExpressOrderStatusLog).values({
            order_id: BigInt(orderId),
            store_id: integerId(storeId),
            old_status: 'PENDING',
            new_status: 'ACCEPTED',
            changed_at: now,
          });
          return pending.length;
        }),
      );
      effects.concurrencySync(storeId, { pending: -updated, accepted: updated });
      const store = await storeName(storeId);
      await effects.slack(
        `✅ Hyperlocal Order ID: ${orderId} Accepted at ${slackText(store.name)}`,
        {
          storeId,
          sendToCommon: false,
        },
      );
      return { message: 'Success', updatedCount: updated };
    },
    /** Reject All (`order/views.py:5015-5040`). */
    async reject(
      user: Principal,
      storeId: string,
      orderId: string,
      rejectionReasonId: string,
    ): Promise<FulfillmentResult> {
      await authorize(user, storeId);
      const [reason] = await databases
        .get('writer')
        .select({ id: HyperlocalRejectionReason.id, reason: HyperlocalRejectionReason.reason })
        .from(HyperlocalRejectionReason)
        .where(
          and(
            eq(HyperlocalRejectionReason.id, BigInt(rejectionReasonId)),
            eq(HyperlocalRejectionReason.is_active, true),
          ),
        )
        .limit(1);
      if (!reason) throw new AppError(400, 'INVALID_REJECTION_REASON', 'Invalid rejection reason');
      const rejected = await retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId);
          const lines = await readLines(tx, orderId, storeId, true);
          assertActionable('REJECT', lines);
          const selected = lines.filter(
              (line) => line.status === 'PENDING' || line.status === 'ACCEPTED',
            ),
            now = timestamp();
          if (selected.length) {
            await tx
              .update(ExpressLineItem)
              .set({ status: 'REJECTED', rejection_reason_id: Number(reason.id), updated_at: now })
              .where(
                inArray(
                  ExpressLineItem.id,
                  selected.map((line) => integerId(line.id)),
                ),
              );
            await tx.insert(ExpressOrderStatusLog).values({
              order_id: BigInt(orderId),
              store_id: integerId(storeId),
              old_status: selected[0]!.status ?? '',
              new_status: 'REJECTED',
              changed_at: now,
            });
          }
          return selected.map((line) => line.hasProductId);
        }),
      );
      const store = await storeName(storeId);
      await effects.rejectionApi(orderId, rejected, {
        kind: 'rejected',
        reason: reason.reason,
        storeName: store.name,
        storeId,
      });
      return { message: 'Success', updatedCount: rejected.length };
    },
    /** Mark All as Packed (`AjaxExpressOrderPackAllView`, `order/views.py:5043-5076`). */
    async pack(user: Principal, storeId: string, orderId: string): Promise<FulfillmentResult> {
      await authorize(user, storeId);
      const lines = await readLines(databases.get('writer'), orderId, storeId, false);
      assertActionable('PACK', lines);
      const accepted = lines.filter((line) => line.status === 'ACCEPTED'),
        hasProductIds = accepted.map((line) => line.hasProductId);
      // Legacy posts PACK to the sync-repo service before its own update (`:5059`).
      await effects.callStatusApi(orderId, hasProductIds, 'PACK', true);
      const updated = await retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId);
          const now = timestamp();
          const [result] = await tx
            .update(ExpressLineItem)
            .set({ status: 'PACKED', updated_at: now })
            .where(
              and(
                eq(ExpressLineItem.order, BigInt(orderId)),
                eq(ExpressLineItem.store_id, integerId(storeId)),
                eq(ExpressLineItem.status, 'ACCEPTED'),
              ),
            );
          await tx.insert(ExpressOrderStatusLog).values({
            order_id: BigInt(orderId),
            store_id: integerId(storeId),
            old_status: 'ACCEPTED',
            new_status: 'PACKED',
            changed_at: now,
          });
          return Number(result.affectedRows);
        }),
      );
      effects.concurrencySync(storeId, { accepted: -updated });
      const store = await storeName(storeId);
      const skus = pythonIdList(await effects.skuIds(hasProductIds));
      await effects.slack(
        `📦 Hyperlocal Order ID: ${orderId} Packed at ${slackText(store.name)} | SKUs: ${skus}`,
        { slackUrl: store.slackUrl, sendToCommon: false },
      );
      return { message: 'Success', updatedCount: updated };
    },
    /** Single line pack (`AjaxExpressLineItemPackView`, `order/views.py:4667-4687`). */
    async packLine(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
    ): Promise<FulfillmentResult> {
      await authorize(user, storeId);
      await retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId);
          const line = (await readLines(tx, orderId, storeId, true)).find(
            (item) => item.id === lineId && item.status === 'ACCEPTED',
          );
          if (!line)
            throw conflict(
              'FULFILLMENT_STATE_CONFLICT',
              'Line item not found or not in ACCEPTED state',
            );
          const now = timestamp();
          await tx
            .update(ExpressLineItem)
            .set({ status: 'PACKED', updated_at: now })
            .where(eq(ExpressLineItem.id, integerId(lineId)));
          await tx.insert(ExpressOrderStatusLog).values({
            order_id: BigInt(orderId),
            store_id: integerId(storeId),
            old_status: 'ACCEPTED',
            new_status: 'PACKED',
            changed_at: now,
          });
        }),
      );
      effects.concurrencySync(storeId, { accepted: -1 });
      return { message: 'Success', updatedCount: 1 };
    },
    /** Mark All as Shipped from the progress page. */
    async ship(user: Principal, storeId: string, orderId: string): Promise<FulfillmentResult> {
      await authorize(user, storeId);
      assertActionable('SHIP', await readLines(databases.get('writer'), orderId, storeId, false));
      return markShipped(orderId, storeId, user);
    },
    /**
     * Courier `ship-express-order/` (`ExpressOrderMarkShippedApiView`, `order/views.py:5141-5166`):
     * the store is the unique store with a PACKED line for this order and AWB.
     */
    async shipFromCourier(orderId: string, awb: string) {
      const matches = await databases
        .get('writer')
        .selectDistinct({ storeId: ExpressLineItem.store_id })
        .from(ExpressLineItem)
        .innerJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
        .where(
          and(
            eq(ExpressLineItem.order, BigInt(orderId)),
            eq(HasProduct.awb, awb),
            eq(ExpressLineItem.status, 'PACKED'),
          ),
        )
        .limit(2);
      if (matches.length !== 1 || matches[0]!.storeId === null) return null;
      return markShipped(orderId, String(matches[0]!.storeId), null);
    },
    /** Mark as RTO (`AjaxExpressOrderMarkRTOView`, `order/views.py:5208-5248`). */
    async rto(user: Principal, storeId: string, orderId: string): Promise<FulfillmentResult> {
      await authorize(user, storeId);
      const marked = await retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId);
          const lines = (await readLines(tx, orderId, storeId, true)).filter(
            (line) => line.status === 'OUT_FOR_DELIVERY',
          );
          if (!lines.length)
            throw conflict('FULFILLMENT_STATE_CONFLICT', 'No out-for-delivery items found for RTO');
          const hasProductIds = lines.map((line) => line.hasProductId);
          const received = await tx
            .select({ id: HasProduct.id, productId: HasProduct.product })
            .from(HasProduct)
            .where(
              and(
                inArray(HasProduct.id, hasProductIds.map(BigInt)),
                eq(HasProduct.status, 'RTO_DELIVERED'),
              ),
            )
            .orderBy(asc(HasProduct.id));
          if (received.length !== hasProductIds.length)
            throw conflict('RTO_NOT_RECEIVED', 'Not all items are in RTO_DELIVERED status');
          const now = timestamp();
          await tx
            .update(ExpressLineItem)
            .set({ status: 'RTO', updated_at: now })
            .where(
              inArray(
                ExpressLineItem.id,
                lines.map((line) => integerId(line.id)),
              ),
            );
          await tx.insert(ExpressOrderStatusLog).values({
            order_id: BigInt(orderId),
            store_id: integerId(storeId),
            old_status: 'OUT_FOR_DELIVERY',
            new_status: 'RTO',
            changed_at: now,
          });
          return { hasProductIds, skus: received.map((row) => String(row.productId)) };
        }),
      );
      await effects.vinculumRto(orderId, marked.hasProductIds);
      const store = await storeName(storeId);
      await effects.slack(
        `🔄 Hyperlocal Order ID: ${orderId} marked as RTO at ${slackText(store.name)} | SKUs: ${pythonIdList(marked.skus)}`,
        { slackUrl: store.slackUrl },
      );
      return { message: 'Success', updatedCount: marked.hasProductIds.length };
    },
    /** Super-admin edit (`AjaxHyperlocalAdminEditView`, `order/views.py:5505-5580`): role 1 only. */
    async edit(user: Principal, storeId: string, orderId: string, edit: AdminFulfillmentEdit) {
      requireRole(user, [1]);
      return retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentOperatorIdentity(tx, user.id, [1]);
          const rows = await tx
            .select({ id: ExpressLineItem.id, status: ExpressLineItem.status })
            .from(ExpressLineItem)
            .where(
              and(
                eq(ExpressLineItem.order, BigInt(orderId)),
                eq(ExpressLineItem.store_id, integerId(storeId)),
              ),
            )
            .for('update');
          if (!rows.length)
            throw new AppError(
              404,
              'FULFILLMENT_ORDER_NOT_FOUND',
              'No line items found for this order',
            );
          const now = timestamp();
          const changed = rows.filter((row) => edit.status && row.status !== edit.status);
          if (changed.length)
            await tx.insert(ExpressOrderStatusLog).values(
              changed.map((row) => ({
                order_id: BigInt(orderId),
                store_id: integerId(storeId),
                old_status: row.status || '',
                new_status: edit.status!,
                changed_at: now,
              })),
            );
          await tx
            .update(ExpressLineItem)
            .set({
              updated_at: now,
              ...(edit.status ? { status: edit.status } : {}),
              ...(edit.pendingExpiresAt
                ? { pending_expires_at: edit.pendingExpiresAt.replace('T', ' ') + ':00' }
                : {}),
              ...(edit.acceptedExpiresAt
                ? { accepted_expires_at: edit.acceptedExpiresAt.replace('T', ' ') + ':00' }
                : {}),
            })
            .where(
              inArray(
                ExpressLineItem.id,
                rows.map((row) => row.id),
              ),
            );
          return { success: true as const, updatedCount: rows.length };
        }),
      );
    },
    async notifications(user: Principal, storeId: string, after = '0', limit = 30) {
      requireStore(user, storeId);
      const db = databases.get('primary');
      const where = and(
        eq(UsersNotification.pos_admin_id, integerId(user.id)),
        eq(Notification.store_id, integerId(storeId)),
      );
      const rows = await db
        .select({
          id: Notification.id,
          title: Notification.title,
          url: Notification.url_key,
          orderId: Notification.order_id,
          isViewed: UsersNotification.is_viewed,
          createdAt: Notification.created_at,
        })
        .from(UsersNotification)
        .innerJoin(Notification, eq(UsersNotification.notification, sql`${Notification.id}`))
        .where(and(where, after !== '0' ? gt(Notification.id, BigInt(after)) : undefined))
        .orderBy(desc(Notification.id))
        .limit(limit + 1);
      const [count] = await db
        .select({ count: sql<number>`count(*)` })
        .from(UsersNotification)
        .innerJoin(Notification, eq(UsersNotification.notification, sql`${Notification.id}`))
        .where(and(where, eq(UsersNotification.is_viewed, 0)));
      return {
        data: rows.slice(0, limit).map((row) => ({
          ...row,
          id: String(row.id),
          orderId: row.orderId === null ? null : String(row.orderId),
          isViewed: row.isViewed === 1,
          url: safeNotificationUrl(row.url),
        })),
        unreadCount: Number(count?.count || 0),
        hasMore: rows.length > limit,
      };
    },
    async markNotificationRead(user: Principal, storeId: string, notificationId: string) {
      requireStore(user, storeId);
      const db = databases.get('writer');
      const [notice] = await db
        .select({ id: Notification.id })
        .from(Notification)
        .where(
          and(
            eq(Notification.id, BigInt(notificationId)),
            eq(Notification.store_id, integerId(storeId)),
          ),
        )
        .limit(1);
      if (notice)
        await db
          .update(UsersNotification)
          .set({ is_viewed: 1, updated_at: timestamp() })
          .where(
            and(
              eq(UsersNotification.notification, BigInt(notificationId)),
              eq(UsersNotification.pos_admin_id, integerId(user.id)),
            ),
          );
      return { status: 'success', message: 'Recorded' };
    },
  };
}
export type FulfillmentService = ReturnType<typeof fulfillmentService>;
