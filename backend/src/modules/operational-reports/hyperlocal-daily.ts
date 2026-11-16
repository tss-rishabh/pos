import { Temporal } from '@js-temporal/polyfill';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  Order,
  OrderStatus,
  Store,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { warehouseService } from '../warehouse.js';
import {
  businessTimestamp,
  scalarId,
  timestampReportBounds,
  warehouseView,
} from './report-inputs.js';
import { maskCustomerName } from './privacy.js';
import { reportCsvCell } from './export-domain.js';
import { pythonFloatString } from './number-format.js';

export const hyperlocalDailyInputSchema = z
  .object({
    from: businessTimestamp,
    to: businessTimestamp,
    storeIds: z.array(identifier).max(500).default([]),
    sort: z.literal('order_date').default('order_date'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.number().int().min(1).max(1000000).default(1),
    pageSize: z.number().int().min(1).max(500).default(25),
  })
  .strict();
export type HyperlocalDailyInput = z.infer<typeof hyperlocalDailyInputSchema>;
export const hyperlocalDailyOptions = (env: NodeJS.ProcessEnv = process.env) =>
  z.object({ BQ_HYPERLOCAL_DAILY_VIEW: warehouseView }).parse(env);
const dateTime = z
  .string()
  .nullable()
  .transform((value) => value?.replace('T', ' ').slice(0, 19) || null);
const reportRow = z.object({
  order_id: scalarId,
  user_id: scalarId,
  line_item_id: scalarId,
  sku_id: scalarId,
  customer_name: z.string().nullable(),
  qty: z.coerce.number().int(),
  amount: z.coerce.number().finite(),
  order_status: z.string().nullable(),
  line_item_status: z.string(),
  express_line_item_status: z.string().nullable(),
  order_date: dateTime,
  location_code: z.string(),
  store_name: z.string(),
  allocation_date: dateTime,
  pack_date: dateTime,
  pickup_date: dateTime,
  delivery_date: dateTime,
});
export type HyperlocalDailyRow = z.infer<typeof reportRow>;
const partialRow = reportRow
  .omit({ allocation_date: true, pack_date: true, pickup_date: true, delivery_date: true })
  .extend({ store_id: scalarId });
export const hyperlocalDailyColumns = [
  ['order_id', 'Order ID'],
  ['user_id', 'User ID'],
  ['line_item_id', 'Line Item Id'],
  ['sku_id', 'SKU ID'],
  ['customer_name', 'Name'],
  ['qty', 'Qty'],
  ['amount', 'Amount'],
  ['order_status', 'Order Status'],
  ['line_item_status', 'Line Item Status'],
  ['express_line_item_status', 'Express Line Item Status'],
  ['order_date', 'Order Date'],
  ['location_code', 'Store Code'],
  ['store_name', 'Store Name'],
  ['allocation_date', 'Order Allocation Date to POS'],
  ['pack_date', 'Order Pack Date'],
  ['pickup_date', 'Order Pickup Date'],
  ['delivery_date', 'Order Delivery Date'],
] as const;
const dateFields = new Set<string>([
  'order_date',
  'allocation_date',
  'pack_date',
  'pickup_date',
  'delivery_date',
]);
function sourceDate(value: string | null) {
  if (!value) return '';
  try {
    const date = Temporal.PlainDateTime.from(value.replace(' ', 'T'));
    return `${String(date.day).padStart(2, '0')}/${String(date.month).padStart(2, '0')}/${String(date.year % 100).padStart(2, '0')} ${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
export function hyperlocalDailyCsv(rows: readonly HyperlocalDailyRow[]) {
  return (
    '\uFEFF' +
    [
      hyperlocalDailyColumns.map(([, label]) => label),
      ...rows.map((row) =>
        hyperlocalDailyColumns.map(([key]) =>
          dateFields.has(key)
            ? sourceDate(row[key] as string | null)
            : key === 'amount'
              ? pythonFloatString(row.amount)
              : row[key],
        ),
      ),
    ]
      .map((row) => row.map(reportCsvCell).join(','))
      .join('\r\n')
  );
}
/** Role 1 internal operators may select all; other operators default to assigned stores. */
export function hyperlocalDailyScope(user: Principal, requested: readonly string[]) {
  const ids = [...new Set(requested)],
    restricted = user.role !== 1 || user.userType === 2;
  if (restricted && ids.some((id) => !user.storeIds.includes(id)))
    throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
  return {
    ids: ids.length ? ids : restricted ? [...new Set(user.storeIds)] : [],
    global: !restricted && !ids.length,
  };
}
const counts = z.array(
  z.object({ count: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
);
export function hyperlocalDailyReportService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof hyperlocalDailyOptions> = hyperlocalDailyOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async read(user: Principal, value: HyperlocalDailyInput, all = false) {
      const input = hyperlocalDailyInputSchema.parse(value),
        scope = hyperlocalDailyScope(user, input.storeIds),
        bounds = timestampReportBounds(config, input.from, input.to, clock());
      if (!scope.global && !scope.ids.length)
        return {
          reader: bounds.reader,
          data: [] as HyperlocalDailyRow[],
          total: 0,
          page: 1,
          totalPages: 0,
        };
      try {
        let total: number, page: number, totalPages: number, rows: HyperlocalDailyRow[];
        const limit = all ? 70001 : input.pageSize;
        if (bounds.reader === 'bigquery') {
          if (!options.BQ_HYPERLOCAL_DAILY_VIEW)
            return unavailable('BigQuery hyperlocal daily view');
          const table = '`' + options.BQ_HYPERLOCAL_DAILY_VIEW + '`',
            params = {
              start: bounds.from,
              end: bounds.to,
              stores: scope.ids,
              allStores: scope.global,
            },
            types = { start: 'DATETIME', end: 'DATETIME', stores: ['STRING'], allStores: 'BOOL' },
            where =
              'pending_expires_at>=@start AND pending_expires_at<=@end AND (@allStores OR CAST(store_id AS STRING) IN UNNEST(@stores))',
            groups =
              'order_id,user_id,line_item_id,sku_id,customer_name,order_status,line_item_status,express_line_item_status,order_date,store_id,location_code,store_name';
          total =
            counts.parse(
              await warehouse.queryReport(
                `SELECT COUNT(*) AS count FROM (SELECT line_item_id FROM ${table} WHERE ${where} GROUP BY ${groups})`,
                params,
                types,
                'hyperlocal-daily',
              ),
            )[0]?.count || 0;
          totalPages = Math.ceil(total / input.pageSize);
          page = all || input.page > totalPages ? 1 : input.page;
          if (all && total > 70000)
            throw new AppError(
              422,
              'REPORT_TOO_LARGE',
              'Select a smaller store/date range for export.',
            );
          if (!total)
            return {
              reader: bounds.reader,
              data: [] as HyperlocalDailyRow[],
              total,
              page,
              totalPages,
            };
          rows = z
            .array(reportRow)
            .parse(
              await warehouse.queryReport(
                `SELECT order_id,user_id,line_item_id,ANY_VALUE(sku_id) AS sku_id,customer_name,SUM(quantity) AS qty,ROUND(SUM(COALESCE(pre_gst_amount,0)*(1+COALESCE(gst_rate,0)/100)),2) AS amount,order_status,line_item_status,express_line_item_status,order_date,location_code,store_name,MIN(allocation_date) AS allocation_date,MIN(pack_date) AS pack_date,MIN(pickup_date) AS pickup_date,MIN(delivery_date) AS delivery_date FROM ${table} WHERE ${where} GROUP BY ${groups} ORDER BY order_date ${input.direction},order_id DESC,line_item_id DESC,store_id ASC,express_line_item_status ASC LIMIT @limit OFFSET @offset`,
                { ...params, limit, offset: all ? 0 : (page - 1) * input.pageSize },
                { ...types, limit: 'INT64', offset: 'INT64' },
                'hyperlocal-daily',
              ),
            );
        } else {
          const reader = db.get('data'),
            where = and(
              sql`${ExpressLineItem.pending_expires_at}>=${bounds.from}`,
              sql`${ExpressLineItem.pending_expires_at}<=${bounds.to}`,
              scope.global
                ? undefined
                : sql`${ExpressLineItem.store_id} IN (${sql.join(
                    scope.ids.map((id) => sql`${id}`),
                    sql`,`,
                  )})`,
            ),
            base = sql`FROM ${ExpressLineItem} JOIN ${Order} ON ${Order.id}=${ExpressLineItem.order} JOIN ${HasProduct} ON ${HasProduct.id}=${ExpressLineItem.has_product} JOIN ${Store} ON ${Store.id}=${ExpressLineItem.store_id} LEFT JOIN ${OrderStatus} ON ${OrderStatus.id}=${Order.order_statuses} WHERE ${where} GROUP BY ${Order.id},${Order.user},${HasProduct.id},${Order.first_name},${Order.last_name},${Order.created_at},${Order.order_statuses},${HasProduct.status},${ExpressLineItem.status},${Store.id},${Store.location_code},${Store.store_name}`,
            counted = await reader.execute(
              sql`SELECT COUNT(*) AS count FROM (SELECT ${HasProduct.id} ${base}) AS report_rows`,
            );
          total = counts.parse(counted[0])[0]?.count || 0;
          totalPages = Math.ceil(total / input.pageSize);
          page = all || input.page > totalPages ? 1 : input.page;
          if (all && total > 70000)
            throw new AppError(
              422,
              'REPORT_TOO_LARGE',
              'Select a smaller store/date range for export.',
            );
          if (!total)
            return {
              reader: bounds.reader,
              data: [] as HyperlocalDailyRow[],
              total,
              page,
              totalPages,
            };
          const result = await reader.execute(
              sql`SELECT ${Order.id} AS order_id,${Order.user} AS user_id,${HasProduct.id} AS line_item_id,ANY_VALUE(${HasProduct.product}) AS sku_id,CONCAT(${Order.first_name},' ',${Order.last_name}) AS customer_name,SUM(${HasProduct.qty}) AS qty,ROUND(SUM(COALESCE(${HasProduct.pre_gst_amt},0)*(1+COALESCE(${HasProduct.gst},0)/100)),2) AS amount,ANY_VALUE(${OrderStatus.display_name}) AS order_status,${HasProduct.status} AS line_item_status,${ExpressLineItem.status} AS express_line_item_status,${Order.created_at} AS order_date,${Store.id} AS store_id,${Store.location_code} AS location_code,${Store.store_name} AS store_name ${base} ORDER BY order_date ${sql.raw(input.direction)},order_id DESC,line_item_id DESC,store_id ASC,express_line_item_status ASC LIMIT ${limit} OFFSET ${all ? 0 : (page - 1) * input.pageSize}`,
            ),
            partial = z.array(partialRow).parse(result[0]),
            pairs = [
              ...new Map(partial.map((row) => [`${row.order_id}:${row.store_id}`, row])).values(),
            ],
            timings = new Map<
              string,
              Pick<
                HyperlocalDailyRow,
                'allocation_date' | 'pack_date' | 'pickup_date' | 'delivery_date'
              >
            >();
          // Source joins one earliest lifecycle tuple per order/store. Query only displayed pairs.
          for (let offset = 0; offset < pairs.length; offset += 500) {
            const chunk = pairs.slice(offset, offset + 500),
              matched = or(
                ...chunk.map((pair) =>
                  and(
                    eq(ExpressOrderStatusLog.order_id, BigInt(pair.order_id)),
                    eq(ExpressOrderStatusLog.store_id, sql`${pair.store_id}`),
                  ),
                ),
              );
            const logs = await reader
              .select({
                orderId: ExpressOrderStatusLog.order_id,
                storeId: ExpressOrderStatusLog.store_id,
                allocation_date: sql<
                  string | null
                >`MIN(CASE WHEN ${ExpressOrderStatusLog.new_status}='ACCEPTED' THEN ${ExpressOrderStatusLog.changed_at} END)`,
                pack_date: sql<
                  string | null
                >`MIN(CASE WHEN ${ExpressOrderStatusLog.new_status}='PACKED' THEN ${ExpressOrderStatusLog.changed_at} END)`,
                pickup_date: sql<
                  string | null
                >`MIN(CASE WHEN ${ExpressOrderStatusLog.new_status}='OUT_FOR_DELIVERY' THEN ${ExpressOrderStatusLog.changed_at} END)`,
                delivery_date: sql<
                  string | null
                >`MIN(CASE WHEN ${ExpressOrderStatusLog.new_status}='DELIVERED' THEN ${ExpressOrderStatusLog.changed_at} END)`,
              })
              .from(ExpressOrderStatusLog)
              .where(matched)
              .groupBy(ExpressOrderStatusLog.order_id, ExpressOrderStatusLog.store_id);
            for (const log of logs) timings.set(`${log.orderId}:${log.storeId}`, log);
          }
          rows = partial.map((row) =>
            reportRow.parse({
              ...row,
              allocation_date: null,
              pack_date: null,
              pickup_date: null,
              delivery_date: null,
              ...timings.get(`${row.order_id}:${row.store_id}`),
            }),
          );
        }
        if (rows.length > 70000)
          throw new AppError(
            422,
            'REPORT_TOO_LARGE',
            'Select a smaller store/date range for export.',
          );
        return {
          reader: bounds.reader,
          data:
            user.userType === 2
              ? rows.map((row) => ({ ...row, customer_name: maskCustomerName(row.customer_name) }))
              : rows,
          total,
          page,
          totalPages,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          'REPORT_QUERY_FAILED',
          'The hyperlocal daily report could not be prepared.',
        );
      }
    },
  };
}
