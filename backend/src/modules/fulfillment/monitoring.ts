import { sourceIntId as numericStore } from './source-id.js';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gte, inArray, lt, max, min, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  Order,
  OrderStatus,
  PaymentStatus,
  Product,
  Store,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { productImage } from '../catalog.js';
import { fulfillmentOrderFacts, type ExpressStatus } from './domain.js';
import { lineSelection, linesToDto } from './service.js';
import type { CheckInReader } from './checkin.js';

export const monitorTabs = {
  rejected: ['REJECTED', 'TIMED_OUT'],
  in_queue: ['PENDING'],
  not_packed: ['ACCEPTED'],
  packed: ['PACKED'],
  shipped: ['OUT_FOR_DELIVERY', 'DELIVERED', 'RTO'],
} as const;
export const monitorTabSchema = z.enum(['rejected', 'in_queue', 'not_packed', 'packed', 'shipped']);
export type MonitorTab = z.infer<typeof monitorTabSchema>;
export interface MonitoringInput {
  /** Optional, as legacy `HLGlobalFilters`; an absent bound is not applied. */
  from?: string;
  to?: string;
  /** Empty = all stores (legacy `store_ids=[]`). */
  storeIds?: string[];
  orderIds?: string[];
  tab: MonitorTab;
  subStatuses?: ExpressStatus[];
  page: number;
  pageSize: 10 | 25 | 50 | 100 | 500;
}
const scalar = z.union([z.string(), z.number(), z.bigint()]).transform(String),
  nullableScalar = scalar.nullable();
const instant = z.string().transform((value) => value.replace('T', ' ').slice(0, 19));
const rowSchema = z.object({
  id: scalar,
  orderId: scalar,
  storeId: scalar,
  hasProductId: scalar,
  status: z.string().nullable(),
  pendingExpiresAt: instant.nullable(),
  acceptedExpiresAt: instant.nullable(),
  productId: nullableScalar,
  productName: z.string().nullable(),
  productStatus: z.string().nullable(),
  quantity: nullableScalar,
  preGstAmount: z.coerce.number().nullable(),
  gst: z.coerce.number().nullable(),
  awb: z.string().nullable(),
  shipmentId: nullableScalar,
  vincStatus: z.string(),
  updatedAt: instant.nullable(),
  price: nullableScalar,
  images: z.string().nullable(),
  parentImages: z.string().nullable(),
  parentProductId: nullableScalar,
  orderExists: nullableScalar,
  reference: z.string().nullable(),
  userId: nullableScalar,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  createdAt: instant.nullable(),
  paymentStatus: z.string().nullable(),
  orderStatus: z.string().nullable(),
  storeName: z.string().nullable(),
});
type MonitorLine = z.infer<typeof rowSchema>;
const pairSchema = z.object({ orderId: scalar, storeId: scalar, expiresAt: instant.nullable() });
type Pair = z.infer<typeof pairSchema>;
const countSchema = z.object({
  status: z.string().nullable(),
  count: z.coerce.number().int().nonnegative(),
});
export function monitorCounts(rows: z.infer<typeof countSchema>[]) {
  const counts = new Map(rows.map((row) => [row.status, row.count]));
  return Object.fromEntries(
    Object.entries(monitorTabs).map(([tab, statuses]) => [
      tab,
      statuses.reduce((sum, status) => sum + (counts.get(status) || 0), 0),
    ]),
  ) as Record<MonitorTab, number>;
}

function pageRange(page: number, totalPages: number) {
  let start = Math.max(1, page - 3),
    end = Math.min(totalPages, page + 3);
  if (end - start < 6) {
    start = Math.max(1, end - 6);
    end = Math.min(totalPages, start + 6);
  }
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => index + start);
}
function assemble(
  pairs: Pair[],
  lines: MonitorLine[],
  packed: Map<string, string>,
  clock: Temporal.Instant,
  zone: string,
) {
  const groups = new Map<string, MonitorLine[]>(),
    stores = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = `${line.orderId}:${line.storeId}`,
      group = groups.get(key) || [];
    group.push(line);
    groups.set(key, group);
    const ids = stores.get(line.orderId) || new Set<string>();
    ids.add(line.storeId);
    stores.set(line.orderId, ids);
  }
  return pairs.flatMap((pair) => {
    const key = `${pair.orderId}:${pair.storeId}`,
      items = groups.get(key) || [],
      order = items.find((line) => line.orderExists !== null);
    if (!order) return [];
    const fallback = items
        .filter((line) => line.status === 'PACKED')
        .map((line) => line.updatedAt)
        .filter((stamp): stamp is string => stamp !== null)
        .sort()
        .at(-1),
      packedAt = packed.get(key) || fallback || null;
    const packedSeconds = packedAt
      ? Math.max(
          0,
          Math.trunc(
            (clock.epochMilliseconds -
              Temporal.PlainDateTime.from(packedAt.replace(' ', 'T')).toZonedDateTime(zone)
                .epochMilliseconds) /
              1000,
          ),
        )
      : null;
    return [
      {
        orderId: pair.orderId,
        storeId: pair.storeId,
        storeName: order.storeName || `Store ${pair.storeId}`,
        reference: order.reference || '',
        userId: order.userId,
        customerName: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus === 'Partially Shipped' ? 'Shipped' : order.orderStatus,
        createdAt: order.createdAt,
        expiresAt: pair.expiresAt,
        isSplit: (stores.get(pair.orderId)?.size || 0) > 1,
        packedAt,
        packedSeconds,
        storeOrderAmount: fulfillmentOrderFacts(items.map((line) => ({ ...line, image: null })))
          .storeOrderAmount,
        lines: items.map((line) => ({
          id: line.id,
          hasProductId: line.hasProductId,
          productId: line.productId,
          parentProductId: line.parentProductId,
          productName: line.productName,
          image: productImage(line.images, line.parentImages),
          price: line.price,
          quantity: line.quantity,
          gst: line.gst,
          status: line.status,
          pendingExpiresAt: line.pendingExpiresAt,
          acceptedExpiresAt: line.acceptedExpiresAt,
        })),
      },
    ];
  });
}
export function fulfillmentMonitoring(
  config: Config,
  databases: Databases,
  checkins: Pick<CheckInReader, 'checkedInStore'>,
  clock = () => Temporal.Now.instant(),
) {
  return {
    /** Legacy store picker: every store, ordered by name (`order/views.py:5419`). */
    async stores() {
      const rows = await databases
        .get('data')
        .select({
          id: Store.id,
          name: Store.store_name,
          locationCode: Store.location_code,
          active: Store.is_active,
        })
        .from(Store)
        .orderBy(asc(Store.store_name));
      return { data: rows.map((row) => ({ ...row, id: String(row.id) })) };
    },
    /** First-load filters (`HLGlobalFilters.initial_for_user`): today and the check-in store. */
    async defaults(user: Principal) {
      const today = clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString(),
        store = await checkins.checkedInStore(user.id);
      return {
        from: today,
        to: today,
        storeIds: store ? [store] : [],
        tab: 'in_queue' as const,
        pageSize: 25,
      };
    },
    /** Legacy `hl_all_stores.get_tab_counts` + `get_orders` on the read replica. */
    async read(input: MonitoringInput) {
      let from = input.from,
        to = input.to;
      if (from && to && Temporal.PlainDate.compare(from, to) > 0) [from, to] = [to, from];
      const tabStatuses = monitorTabs[input.tab] as readonly ExpressStatus[],
        selected = tabStatuses.filter(
          (status) => !input.subStatuses?.length || input.subStatuses.includes(status),
        ),
        statuses = selected.length ? selected : [...tabStatuses];
      const empty = {
        tabCounts: monitorCounts([]),
        data: [],
        page: 1,
        totalPages: 0,
        total: 0,
        hasPrevious: false,
        hasNext: false,
        pageRange: [],
      };
      const db = databases.get('data'),
        storeIds = [...new Set(input.storeIds ?? [])],
        base = and(
          from ? gte(ExpressLineItem.pending_expires_at, from + ' 00:00:00') : undefined,
          to
            ? lt(
                ExpressLineItem.pending_expires_at,
                Temporal.PlainDate.from(to).add({ days: 1 }).toString() + ' 00:00:00',
              )
            : undefined,
          storeIds.length
            ? inArray(ExpressLineItem.store_id, storeIds.map(numericStore))
            : undefined,
          input.orderIds?.length
            ? inArray(ExpressLineItem.order, input.orderIds.map(BigInt))
            : undefined,
        ),
        condition = and(base, inArray(ExpressLineItem.status, statuses));
      const counts = z.array(countSchema).parse(
        await db
          .select({
            status: ExpressLineItem.status,
            count: sql<number>`count(distinct ${ExpressLineItem.order})`,
          })
          .from(ExpressLineItem)
          .where(base)
          .groupBy(ExpressLineItem.status),
      );
      const selectedPairs = db
        .select({ orderId: ExpressLineItem.order, storeId: ExpressLineItem.store_id })
        .from(ExpressLineItem)
        .where(condition)
        .groupBy(ExpressLineItem.order, ExpressLineItem.store_id)
        .as('selected_pairs');
      const [count] = await db.select({ count: sql<number>`count(*)` }).from(selectedPairs);
      const total = Number(count?.count || 0);
      if (!total) return { ...empty, tabCounts: monitorCounts(counts) };
      const totalPages = Math.ceil(total / input.pageSize),
        page = Math.max(1, Math.min(input.page, totalPages));
      const pairs = z.array(pairSchema).parse(
        await db
          .select({
            orderId: ExpressLineItem.order,
            storeId: ExpressLineItem.store_id,
            expiresAt: min(ExpressLineItem.pending_expires_at),
          })
          .from(ExpressLineItem)
          .where(condition)
          .groupBy(ExpressLineItem.order, ExpressLineItem.store_id)
          .orderBy(desc(min(ExpressLineItem.pending_expires_at)), desc(ExpressLineItem.order))
          .limit(input.pageSize)
          .offset((page - 1) * input.pageSize),
      );
      const ids = [...new Set(pairs.map((pair) => pair.orderId))].map(BigInt),
        parent = alias(Product, 'monitor_parent');
      const rows = await db
        .select({
          ...lineSelection,
          updatedAt: ExpressLineItem.updated_at,
          price: HasProduct.price,
          images: Product.images_new,
          parentImages: parent.images_new,
          parentProductId: Product.parent_prod_id,
          orderExists: Order.id,
          reference: Order.order_ref_no,
          userId: Order.user,
          firstName: Order.first_name,
          lastName: Order.last_name,
          createdAt: Order.created_at,
          paymentStatus: PaymentStatus.payment_status,
          orderStatus: OrderStatus.order_status,
          storeName: Store.store_name,
        })
        .from(ExpressLineItem)
        .leftJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
        .leftJoin(Product, eq(Product.id, HasProduct.product))
        .leftJoin(parent, eq(parent.id, Product.parent_prod_id))
        .leftJoin(Order, eq(Order.id, ExpressLineItem.order))
        .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
        .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
        .leftJoin(Store, eq(Store.id, sql`${ExpressLineItem.store_id}`))
        .where(and(condition, inArray(ExpressLineItem.order, ids)))
        .orderBy(asc(ExpressLineItem.id));
      const lines = z
        .array(rowSchema)
        .parse(rows.map((row) => ({ ...row, ...linesToDto([row])[0] })));
      const packed = new Map<string, string>();
      if (input.tab === 'packed') {
        const logs = await db
          .select({
            orderId: ExpressOrderStatusLog.order_id,
            storeId: ExpressOrderStatusLog.store_id,
            packedAt: max(ExpressOrderStatusLog.changed_at),
          })
          .from(ExpressOrderStatusLog)
          .where(
            and(
              inArray(ExpressOrderStatusLog.order_id, ids),
              eq(ExpressOrderStatusLog.new_status, 'PACKED'),
            ),
          )
          .groupBy(ExpressOrderStatusLog.order_id, ExpressOrderStatusLog.store_id);
        for (const row of logs)
          if (row.packedAt) packed.set(`${row.orderId}:${row.storeId}`, row.packedAt);
      }
      return {
        tabCounts: monitorCounts(counts),
        data: assemble(pairs, lines, packed, clock(), config.BUSINESS_TIMEZONE),
        page,
        totalPages,
        total,
        hasPrevious: page > 1,
        hasNext: page < totalPages,
        pageRange: pageRange(page, totalPages),
      };
    },
  };
}
