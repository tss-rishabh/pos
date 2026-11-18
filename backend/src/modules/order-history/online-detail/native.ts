import { and, asc, desc, eq, gte, lt, lte, sql, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { AppError } from '../../../domain/errors.js';
import type { Databases } from '../../../db/pools.js';
import {
  Order,
  OrderStatus,
  PaymentStatus,
  PaymentMethod,
  OrderStore,
  HasProduct,
  Product,
  OrderPlatform,
  ExpressLineItem,
  HyperlocalLocation,
  HyperlocalOrderLog,
  HyperlocalFdLog,
  PosTransactionLog,
  MUser,
} from '../../../db/legacy-schema.js';
import { benefitMemberships } from '../../customer-insights/benefits-schema.js';
import { customerMembership } from '../../customer-insights/benefits-values.js';
import type { OrderReadRange } from '../contracts.js';
import {
  onlineDetailFact,
  currentOrderCustomer,
  currentOrderProducts,
  type OnlineDetailFact,
} from './contracts.js';
import { detailInvalid } from './errors.js';
import { nextStoreIds } from './authority.js';
import { detailDecimal, detailPaymentEntries, safeTrackingUrl, detailWallet } from './values.js';

type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
const optionalId = (value: bigint | number | null) =>
  value === null || value === 0n || value === 0 ? null : String(value);
const optionalTime = (value: string | null) => (!value || value.startsWith('0000-') ? null : value);
/** One bounded, repeatable, read-only native snapshot; historical paths never call it. */
export async function readNativeOnlineDetail(
  tx: Transaction,
  orderId: string,
  range: OrderReadRange,
  inclusiveEnd?: string,
): Promise<OnlineDetailFact | null> {
  const [header] = await tx
    .select({
      id: Order.id,
      customerId: Order.user,
      reference: Order.order_ref_no,
      createdAt: Order.created_at,
      amount: Order.order_amt,
      payAmount: Order.pay_amt,
      statusId: Order.order_statuses,
      status: OrderStatus.order_status,
      paymentStatusId: Order.payment_statuses,
      paymentStatus: PaymentStatus.payment_status,
      methodId: Order.payment_methods,
      method: PaymentMethod.name,
      global: Order.is_global_order,
      split: Order.is_split_order,
      locationId: Order.location_id,
      locationType: Order.location_type,
      transfer: Order.is_transfer,
      next: Order.next_location_ids,
      startSlot: Order.start_timeslot,
      endSlot: Order.end_timeslot,
      parentOrderId: Order.hl_parent_order_id,
      moneyUsed: Order.tss_money_used,
      pointsUsed: Order.tss_points_used,
      voucherUsed: Order.voucher_amt_used,
      couponUsed: Order.coupon_amt_used,
    })
    .from(Order)
    .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
    .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
    .leftJoin(PaymentMethod, eq(PaymentMethod.id, Order.payment_methods))
    .where(
      and(
        eq(Order.id, BigInt(orderId)),
        gte(Order.created_at, range.start),
        inclusiveEnd ? lte(Order.created_at, inclusiveEnd) : lt(Order.created_at, range.end),
      ),
    )
    .limit(1);
  if (!header) return null;
  const [logSize] = await tx
    .select({
      rows: sql<string>`CAST(COUNT(*) AS CHAR)`,
      bytes: sql<string>`CAST(COALESCE(SUM(OCTET_LENGTH(${PosTransactionLog.pay_dict})+COALESCE(OCTET_LENGTH(${PosTransactionLog.comment}),0)+256),0) AS CHAR)`,
    })
    .from(PosTransactionLog)
    .where(eq(PosTransactionLog.order_id, header.id));
  if (!logSize || !/^[0-9]+$/.test(logSize.rows) || !/^[0-9]+$/.test(logSize.bytes))
    throw detailInvalid();
  if (BigInt(logSize.rows) >= 10000n || BigInt(logSize.bytes) > 2000000n)
    throw new AppError(
      422,
      'ORDER_DETAIL_TOO_LARGE',
      'This order exceeds the complete detail limit.',
    );
  const mappings = await tx
    .select({ storeId: OrderStore.store })
    .from(OrderStore)
    .where(eq(OrderStore.order, header.id))
    .orderBy(asc(OrderStore.id))
    .limit(10001);
  const lines = await tx
    .select({
      id: HasProduct.id,
      productId: HasProduct.product,
      quantity: HasProduct.qty,
      amount: HasProduct.price,
      gst: HasProduct.gst,
      status: HasProduct.status,
      platformId: HasProduct.order_platform,
      platform: OrderPlatform.name,
    })
    .from(HasProduct)
    .leftJoin(OrderPlatform, eq(OrderPlatform.id, HasProduct.order_platform))
    .where(eq(HasProduct.order, header.id))
    .orderBy(asc(HasProduct.id))
    .limit(10001);
  const express = await tx
    .select({
      id: ExpressLineItem.id,
      lineId: ExpressLineItem.has_product,
      storeId: ExpressLineItem.store_id,
      status: ExpressLineItem.status,
      pendingExpiresAt: ExpressLineItem.pending_expires_at,
      acceptedExpiresAt: ExpressLineItem.accepted_expires_at,
      rejectionReasonId: ExpressLineItem.rejection_reason_id,
      cancellationReason: ExpressLineItem.cancellation_reason,
    })
    .from(ExpressLineItem)
    .where(eq(ExpressLineItem.order, header.id))
    .orderBy(asc(ExpressLineItem.id))
    .limit(10001);
  const logs = await tx
    .select({
      id: PosTransactionLog.id,
      createdAt: PosTransactionLog.created_at,
      comment: PosTransactionLog.comment,
      paymentStatus: PosTransactionLog.payment_status,
      orderStatus: OrderStatus.order_status,
      payments: PosTransactionLog.pay_dict,
    })
    .from(PosTransactionLog)
    .leftJoin(OrderStatus, eq(OrderStatus.id, PosTransactionLog.order_status))
    .where(eq(PosTransactionLog.order_id, header.id))
    .orderBy(asc(PosTransactionLog.id))
    .limit(10001);
  if (
    mappings.length > 10000 ||
    lines.length > 10000 ||
    express.length > 10000 ||
    logs.length >= 10000
  )
    throw detailInvalid();
  if (BigInt(logSize.rows) !== BigInt(logs.length)) throw detailInvalid();
  const lineIds = new Set(lines.map((line) => String(line.id)));
  const expressByLine = new Map<string, typeof express>();
  for (const item of express) {
    const key = String(item.lineId);
    const bucket = expressByLine.get(key) ?? [];
    bucket.push(item);
    expressByLine.set(key, bucket);
  }
  if (express.some((item) => !lineIds.has(String(item.lineId)))) throw detailInvalid();
  let ownerStoreId: string | null =
    header.locationType === 'SW' ? optionalId(header.locationId) : null;
  if (header.locationType === 'NW' && header.locationId !== null) {
    const [location] = await tx
      .select({ storeId: HyperlocalLocation.store_id })
      .from(HyperlocalLocation)
      .where(eq(HyperlocalLocation.id, BigInt(header.locationId)))
      .limit(1);
    ownerStoreId =
      location?.storeId === null || location?.storeId === undefined
        ? null
        : String(location.storeId);
  }
  const [delivery] = await tx
    .select({
      id: HyperlocalOrderLog.borzo_id,
      sourceTracking: HyperlocalOrderLog.source_tracking_url,
      destinationTracking: HyperlocalOrderLog.destination_tracking_url,
    })
    .from(HyperlocalOrderLog)
    .where(eq(HyperlocalOrderLog.order_id, header.id))
    .orderBy(asc(HyperlocalOrderLog.id))
    .limit(1);
  const [ticket] = await tx
    .select({
      id: HyperlocalFdLog.fd_ticket_id,
      status: HyperlocalFdLog.fd_ticket_status,
      message: HyperlocalFdLog.comment,
    })
    .from(HyperlocalFdLog)
    .where(eq(HyperlocalFdLog.order_id, header.id))
    .orderBy(asc(HyperlocalFdLog.id))
    .limit(1);
  const [child] = await tx
    .select({ id: Order.id })
    .from(Order)
    .where(eq(Order.hl_parent_order_id, header.id))
    .orderBy(desc(Order.id))
    .limit(1);
  const [placedStatus] = await tx
    .select({ name: OrderStatus.order_status })
    .from(OrderStatus)
    .where(eq(OrderStatus.id, 1n))
    .limit(1);
  if (!placedStatus || header.methodId === null || header.method === null) throw detailInvalid();
  const cash = header.methodId === 14n;
  const fact = {
    contract: 'pos-source-online-order-detail-v1' as const,
    orderId: String(header.id),
    customerId: String(header.customerId),
    createdAt: header.createdAt,
    timeZone: range.timeZone,
    reference: header.reference,
    amount: detailDecimal(header.amount),
    payAmount: detailDecimal(header.payAmount),
    status: { id: header.statusId === null ? null : String(header.statusId), label: header.status },
    paymentStatus: {
      id: header.paymentStatusId === null ? null : String(header.paymentStatusId),
      label: header.paymentStatus,
    },
    paymentMethod: {
      id: header.methodId === null ? null : String(header.methodId),
      label: header.method,
    },
    global: Boolean(header.global),
    split: Boolean(header.split),
    storeIds: [...new Set(mappings.map((row) => String(row.storeId)))].sort(),
    delivery: {
      locationId: header.locationId === null ? null : String(header.locationId),
      locationType: header.locationType,
      ownerStoreId,
      transfer: Boolean(header.transfer),
      nextStoreIds: nextStoreIds(header.next),
      startSlot: optionalTime(header.startSlot),
      endSlot: optionalTime(header.endSlot),
      parentOrderId: optionalId(header.parentOrderId),
      childOrderId: child ? String(child.id) : null,
      courier: {
        id: optionalId(delivery?.id ?? null),
        sourceTracking: safeTrackingUrl(delivery?.sourceTracking ?? null),
        destinationTracking: safeTrackingUrl(delivery?.destinationTracking ?? null),
      },
      ticket: {
        id: ticket?.id ?? null,
        status: ticket?.status ?? null,
        message: ticket?.message ?? null,
      },
    },
    lines: lines.map((line) => ({
      id: String(line.id),
      productId: String(line.productId),
      quantity: String(line.quantity),
      amount: detailDecimal(line.amount),
      gst: detailDecimal(line.gst),
      status: line.status,
      platform: { id: String(line.platformId), name: line.platform },
      express: (expressByLine.get(String(line.id)) ?? []).map((item) => ({
        id: String(item.id),
        storeId: optionalId(item.storeId),
        status: item.status,
        pendingExpiresAt: optionalTime(item.pendingExpiresAt),
        acceptedExpiresAt: optionalTime(item.acceptedExpiresAt),
        rejectionReasonId: optionalId(item.rejectionReasonId),
        cancellationReason: item.cancellationReason,
      })),
    })),
    timeline: [
      {
        id: 'placement' as const,
        createdAt: header.createdAt,
        comment: `Order Placed ${cash ? 'on store' : 'online'} using payment method : ${header.method ?? ''}`,
        paymentStatus: cash ? 'Pending' : 'PAID',
        orderStatus: placedStatus.name,
        payments: [
          { method: 'tss money used', value: detailDecimal(header.moneyUsed) },
          { method: 'tss points used', value: detailDecimal(header.pointsUsed) },
          {
            method: 'voucher amt used',
            value: header.voucherUsed === null ? null : detailDecimal(header.voucherUsed),
          },
          { method: 'coupon amt used', value: detailDecimal(header.couponUsed) },
          { method: cash ? 'POC PAY AMT' : 'PAY AMT', value: detailDecimal(header.payAmount) },
        ],
      },
      ...logs.map((log) => ({
        id: String(log.id),
        createdAt: log.createdAt,
        comment: log.comment ?? '',
        paymentStatus: String(log.paymentStatus),
        orderStatus: log.orderStatus,
        payments: detailPaymentEntries(log.payments),
      })),
    ],
  };
  if (Buffer.byteLength(JSON.stringify(fact)) > 4000000)
    throw new AppError(
      422,
      'ORDER_DETAIL_TOO_LARGE',
      'This order exceeds the complete detail limit.',
    );
  const parsed = onlineDetailFact.safeParse(fact);
  if (!parsed.success) throw detailInvalid();
  return parsed.data;
}
/** Current operational profile is accessible only after an order/customer authority binding. */
export async function readCurrentOrderCustomer(
  db: Databases,
  customerId: string,
  timeZone: string,
  now: number,
) {
  return db.get('primary').transaction(
    async (tx) => {
      const [profile] = await tx
        .select({
          id: MUser.id,
          firstName: MUser.firstname,
          lastName: MUser.lastname,
          email: MUser.email,
          telephone: MUser.telephone,
          money: MUser.tss_money,
          points: MUser.tss_points,
        })
        .from(MUser)
        .where(eq(MUser.id, BigInt(customerId)))
        .limit(1);
      if (!profile) throw detailInvalid();
      const [membership] = await tx
        .select({ value: benefitMemberships.value, active: benefitMemberships.active })
        .from(benefitMemberships)
        .where(
          and(
            eq(benefitMemberships.entity, profile.email),
            eq(benefitMemberships.attribute, 'EXCLUSIVE_EXPIRY'),
          ),
        )
        .limit(1);
      const parsed = currentOrderCustomer.safeParse({
        ...profile,
        id: String(profile.id),
        money: detailWallet(profile.money),
        points: detailWallet(profile.points),
        membership: customerMembership(
          membership,
          Temporal.Instant.fromEpochMilliseconds(now)
            .toZonedDateTimeISO(timeZone)
            .toPlainDateTime(),
        ),
        freshness: 'current',
        fetchedAt: new Date(now).toISOString(),
      });
      if (!parsed.success) throw detailInvalid();
      return parsed.data;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Only current catalog dimensions; never rereads historical HP prices, GST or quantities. */
export async function readCurrentOrderProducts(
  db: Databases,
  productIds: readonly string[],
  now: number,
) {
  const ids = [...new Set(productIds)];
  if (ids.length > 10000) throw detailInvalid();
  const rows = ids.length
    ? await db
        .get('primary')
        .select({
          id: Product.id,
          parentId: Product.parent_prod_id,
          name: Product.product,
          typeId: Product.prod_type,
        })
        .from(Product)
        .where(inArray(Product.id, ids.map(BigInt)))
        .orderBy(asc(Product.id))
    : [];
  if (rows.length !== ids.length) throw detailInvalid();
  const parsed = currentOrderProducts.safeParse({
    freshness: 'current',
    fetchedAt: new Date(now).toISOString(),
    items: rows.map((row) => ({
      id: String(row.id),
      parentId: String(row.parentId ?? 0),
      name: row.name,
      typeId: String(row.typeId ?? 0),
    })),
  });
  if (!parsed.success) throw detailInvalid();
  return parsed.data;
}
