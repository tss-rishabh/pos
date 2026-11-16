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
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { businessRange, routeRead } from '../../domain/routing.js';
import { productImage } from '../catalog.js';
import { warehouseService } from '../warehouse.js';
import { fulfillmentOrderFacts, type ExpressStatus } from './domain.js';
import { lineSelection, linesToDto } from './service.js';
import {
  monitoringOptions,
  monitoringTable,
  type MonitoringOptions,
} from './monitoring-options.js';

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
  from: string;
  to: string;
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

function range(input: MonitoringInput, zone: string) {
  const from = Temporal.PlainDate.from(input.from),
    to = Temporal.PlainDate.from(input.to);
  if (Temporal.PlainDate.compare(from, to) > 0)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'The To date precedes the From date.');
  return { start: businessRange(input.from, zone).start, end: businessRange(input.to, zone).end };
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
        storeOrderAmount: fulfillmentOrderFacts(items).storeOrderAmount,
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
  options: MonitoringOptions = monitoringOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  const queryReport = (
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string | string[]>,
  ) => warehouse.queryReport(statement, params, types, 'fulfillment-monitoring');
  return {
    async stores(user: Principal) {
      const rows = await databases
        .get('primary')
        .select({
          id: Store.id,
          name: Store.store_name,
          locationCode: Store.location_code,
          active: Store.is_active,
        })
        .from(Store)
        .where(user.role === 1 ? undefined : inArray(Store.id, user.storeIds.map(BigInt)))
        .orderBy(asc(Store.store_name));
      return { data: rows.map((row) => ({ ...row, id: String(row.id) })) };
    },
    async read(user: Principal, input: MonitoringInput) {
      let storeIds = input.storeIds?.length ? [...new Set(input.storeIds)] : user.storeIds;
      storeIds.forEach((id) => requireStore(user, id));
      if (user.role === 1 && !input.storeIds?.length) {
        const stores = await databases
          .get('primary')
          .select({ id: Store.id })
          .from(Store)
          .limit(2001);
        if (stores.length > 2000)
          throw new AppError(422, 'REPORT_TOO_LARGE', 'Select a store group.');
        storeIds = stores.map((store) => String(store.id));
      }
      const reportRange = range(input, config.BUSINESS_TIMEZONE),
        reader = routeRead(
          { kind: 'report', range: reportRange },
          clock(),
          config.BUSINESS_TIMEZONE,
        ),
        tabStatuses = monitorTabs[input.tab] as readonly ExpressStatus[],
        selected = tabStatuses.filter(
          (status) => !input.subStatuses?.length || input.subStatuses.includes(status),
        ),
        statuses = selected.length ? selected : [...tabStatuses];
      const empty = {
        reader,
        range: reportRange,
        tabCounts: monitorCounts([]),
        data: [],
        page: 1,
        totalPages: 0,
        total: 0,
        hasPrevious: false,
        hasNext: false,
        pageRange: [],
      };
      if (!storeIds.length) return empty;
      let counts: z.infer<typeof countSchema>[], total: number, pairs: Pair[], lines: MonitorLine[];
      const packed = new Map<string, string>();
      let page: number, totalPages: number;
      const end = Temporal.PlainDate.from(input.to).add({ days: 1 }).toString();
      if (reader === 'bigquery') {
        const table = (key: keyof MonitoringOptions) => monitoringTable(options, key),
          eli = table('BQ_FULFILLMENT_EXPRESS_LINES');
        const base = `CAST(e.store_id AS STRING) IN UNNEST(@stores) AND e.pending_expires_at>=DATETIME(@start) AND e.pending_expires_at<DATETIME(@end)${input.orderIds?.length ? ' AND CAST(e.order_id AS STRING) IN UNNEST(@orders)' : ''}`;
        const params: Record<string, unknown> = {
            stores: storeIds,
            start: input.from,
            end,
            ...(input.orderIds?.length ? { orders: input.orderIds } : {}),
          },
          types: Record<string, string | string[]> = {
            stores: ['STRING'],
            start: 'DATE',
            end: 'DATE',
            ...(input.orderIds?.length ? { orders: ['STRING'] } : {}),
          };
        counts = z
          .array(countSchema)
          .parse(
            await queryReport(
              `SELECT e.status,COUNT(DISTINCT e.order_id) AS count FROM ${eli} e WHERE ${base} GROUP BY e.status`,
              params,
              types,
            ),
          );
        const statusParams = { ...params, statuses },
          statusTypes = { ...types, statuses: ['STRING'] };
        const totals = await queryReport(
          `SELECT COUNT(*) AS count FROM (SELECT e.order_id,e.store_id FROM ${eli} e WHERE ${base} AND e.status IN UNNEST(@statuses) GROUP BY e.order_id,e.store_id)`,
          statusParams,
          statusTypes,
        );
        total = z.coerce.number().int().nonnegative().parse(totals[0]?.count);
        totalPages = Math.ceil(total / input.pageSize);
        page = Math.max(1, Math.min(input.page, totalPages || 1));
        pairs = z
          .array(pairSchema)
          .parse(
            await queryReport(
              `SELECT CAST(e.order_id AS STRING) AS orderId,CAST(e.store_id AS STRING) AS storeId,CAST(MIN(e.pending_expires_at) AS STRING) AS expiresAt FROM ${eli} e WHERE ${base} AND e.status IN UNNEST(@statuses) GROUP BY e.order_id,e.store_id ORDER BY MIN(e.pending_expires_at) DESC,e.order_id DESC LIMIT @limit OFFSET @offset`,
              { ...statusParams, limit: input.pageSize, offset: (page - 1) * input.pageSize },
              { ...statusTypes, limit: 'INT64', offset: 'INT64' },
            ),
          );
        if (!pairs.length) return { ...empty, tabCounts: monitorCounts(counts) };
        const pageOrders = [...new Set(pairs.map((pair) => pair.orderId))];
        const rows = await queryReport(
          `SELECT CAST(e.id AS STRING) AS id,CAST(e.order_id AS STRING) AS orderId,CAST(e.store_id AS STRING) AS storeId,CAST(e.has_product_id AS STRING) AS hasProductId,e.status,CAST(e.pending_expires_at AS STRING) AS pendingExpiresAt,CAST(e.accepted_expires_at AS STRING) AS acceptedExpiresAt,CAST(h.prod_id AS STRING) AS productId,p.product AS productName,h.status AS productStatus,CAST(h.qty AS STRING) AS quantity,h.pre_gst_amt AS preGstAmount,h.gst,h.awb,CAST(h.shipment_id AS STRING) AS shipmentId,e.vinc_status AS vincStatus,CAST(e.updated_at AS STRING) AS updatedAt,CAST(h.price AS STRING) AS price,p.images_new AS images,pp.images_new AS parentImages,CAST(p.parent_prod_id AS STRING) AS parentProductId,CAST(o.id AS STRING) AS orderExists,o.order_ref_no AS reference,CAST(o.user_id AS STRING) AS userId,o.first_name AS firstName,o.last_name AS lastName,CAST(o.created_at AS STRING) AS createdAt,ps.payment_status AS paymentStatus,os.order_status AS orderStatus,s.store_name AS storeName FROM ${eli} e LEFT JOIN ${table('BQ_FULFILLMENT_HAS_PRODUCTS')} h ON h.id=e.has_product_id LEFT JOIN ${table('BQ_FULFILLMENT_PRODUCTS')} p ON p.id=h.prod_id LEFT JOIN ${table('BQ_FULFILLMENT_PRODUCTS')} pp ON pp.id=p.parent_prod_id LEFT JOIN ${table('BQ_FULFILLMENT_ORDERS')} o ON o.id=e.order_id LEFT JOIN ${table('BQ_FULFILLMENT_STORES')} s ON s.id=e.store_id LEFT JOIN ${table('BQ_FULFILLMENT_PAYMENT_STATUSES')} ps ON ps.id=o.payment_status LEFT JOIN ${table('BQ_FULFILLMENT_ORDER_STATUSES')} os ON os.id=o.order_status WHERE ${base} AND e.status IN UNNEST(@statuses) AND CAST(e.order_id AS STRING) IN UNNEST(@pageOrders) ORDER BY e.id`,
          { ...statusParams, pageOrders },
          { ...statusTypes, pageOrders: ['STRING'] },
        );
        lines = z.array(rowSchema).parse(rows);
        if (input.tab === 'packed') {
          const logs = await queryReport(
            `SELECT CAST(order_id AS STRING) AS orderId,CAST(store_id AS STRING) AS storeId,CAST(MAX(changed_at) AS STRING) AS packedAt FROM ${table('BQ_FULFILLMENT_STATUS_LOGS')} WHERE CAST(order_id AS STRING) IN UNNEST(@orders) AND new_status='PACKED' GROUP BY order_id,store_id`,
            { orders: pageOrders },
            { orders: ['STRING'] },
          );
          for (const row of logs) {
            const result = z
              .object({ orderId: scalar, storeId: scalar, packedAt: instant })
              .parse(row);
            packed.set(`${result.orderId}:${result.storeId}`, result.packedAt);
          }
        }
      } else {
        const db = databases.get('data'),
          base = and(
            inArray(ExpressLineItem.store_id, storeIds.map(numericStore)),
            gte(ExpressLineItem.pending_expires_at, input.from + ' 00:00:00'),
            lt(ExpressLineItem.pending_expires_at, end + ' 00:00:00'),
            input.orderIds?.length
              ? inArray(ExpressLineItem.order, input.orderIds.map(BigInt))
              : undefined,
          ),
          condition = and(base, inArray(ExpressLineItem.status, statuses));
        counts = z.array(countSchema).parse(
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
        total = Number(count?.count || 0);
        totalPages = Math.ceil(total / input.pageSize);
        page = Math.max(1, Math.min(input.page, totalPages || 1));
        pairs = z.array(pairSchema).parse(
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
        if (!pairs.length) return { ...empty, tabCounts: monitorCounts(counts) };
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
        lines = z.array(rowSchema).parse(rows.map((row) => ({ ...row, ...linesToDto([row])[0] })));
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
      }
      return {
        reader,
        range: reportRange,
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
