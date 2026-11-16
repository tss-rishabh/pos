import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gt, gte, inArray, like, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  AmountToBeRefundedLog,
  HasProduct,
  Order,
  ReturnOrder,
  ReversePickupReason,
  Store,
  SubReason,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { warehouseService } from '../warehouse.js';
import { ReturnReportMoneyHistory } from './return-report-schema.js';
import {
  businessTimestamp,
  orderReportScope,
  scalarId,
  timestampReportBounds,
  warehouseView,
} from './report-inputs.js';
import { reportCsvCell } from './export-domain.js';
export const returnedOrdersInputSchema = z
  .object({
    from: businessTimestamp,
    to: businessTimestamp,
    storeIds: z.array(identifier).max(500).default([]),
    search: z.string().trim().max(100).default(''),
    sort: z
      .enum([
        'store_name',
        'order_id',
        'prod_id',
        'qty',
        'pay_amount_refunded',
        'reason',
        'sub_reason',
        'comment',
        'created_at',
        'order_date',
        'return_id',
      ])
      .default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.number().int().min(1).max(1000000).default(1),
    pageSize: z.number().int().min(1).max(500).default(25),
  })
  .strict();
export type ReturnedOrdersInput = z.infer<typeof returnedOrdersInputSchema>;
export function returnedOrdersOptions(env: NodeJS.ProcessEnv = process.env) {
  return z.object({ BQ_RETURNED_ORDERS_VIEW: warehouseView }).parse(env);
}
const dateTime = z.string().transform((value) => value.replace('T', ' ').slice(0, 19)),
  numeric = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]),
  record = z.object({
    id: scalarId,
    return_id: scalarId,
    store_name: z.string().nullable(),
    order_id: scalarId,
    prod_id: scalarId,
    qty: z.coerce.number().int(),
    pay_amount_refunded: numeric.nullable(),
    pay_amount_refunded_mode: z.string().nullable(),
    reason: z.string().nullable(),
    sub_reason: z.string().nullable(),
    comment: z.string().nullable(),
    order_date: dateTime,
    created_at: dateTime,
    original_order_id: scalarId.nullable(),
  });
export type ReturnedOrderRecord = z.infer<typeof record>;
const refunded = sql<
    number | null
  >`max(case when ${HasProduct.return_mode}=5 and ${HasProduct.status}='EXCHANGE_COMPLETED' then ${ReturnReportMoneyHistory.addedAmount} else ${AmountToBeRefundedLog.refunded_amt} end)`,
  mode = sql<
    string | null
  >`any_value(case when ${HasProduct.return_mode}=5 and ${HasProduct.status}='EXCHANGE_COMPLETED' then 'TSS_MONEY' else ${AmountToBeRefundedLog.refund_mode} end)`;
const selected = {
  id: HasProduct.id,
  return_id: sql<string>`any_value(${ReturnOrder.id})`,
  store_name: sql<string | null>`any_value(${Store.store_name})`,
  order_id: sql<string>`any_value(${ReturnOrder.order_id})`,
  prod_id: sql<string>`any_value(${ReturnOrder.prod_id})`,
  qty: sql<number>`any_value(${ReturnOrder.qty})`,
  pay_amount_refunded: refunded,
  pay_amount_refunded_mode: mode,
  reason: sql<string | null>`any_value(${ReversePickupReason.reason})`,
  sub_reason: sql<string | null>`any_value(${SubReason.sub_reason})`,
  comment: sql<string | null>`any_value(${ReturnOrder.comment})`,
  order_date: sql<string>`any_value(${HasProduct.created_at})`,
  created_at: sql<string>`any_value(${ReturnOrder.created_at})`,
  original_order_id: sql<string | null>`any_value(${Order.parent_order_id})`,
};
const headers = [
  ['store_name', 'Store Name'],
  ['order_id', 'Order ID'],
  ['prod_id', 'Product ID'],
  ['qty', 'Qty'],
  ['pay_amount_refunded', 'Pay Amount Refunded'],
  ['pay_amount_refunded_mode', 'Pay Amount Refunded Mode'],
  ['reason', 'Reason'],
  ['sub_reason', 'Sub Reason'],
  ['comment', 'Comment'],
  ['order_date', 'Order Date'],
  ['created_at', 'Return Date'],
  ['original_order_id', 'Original Order ID'],
] as const;
export function returnedOrdersCsv(rows: ReturnedOrderRecord[]) {
  return (
    '\uFEFF' +
    [headers.map(([, label]) => label), ...rows.map((row) => headers.map(([key]) => row[key]))]
      .map((row) => row.map(reportCsvCell).join(','))
      .join('\r\n')
  );
}
export function returnedOrdersReportService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof returnedOrdersOptions> = returnedOrdersOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async read(user: Principal, value: ReturnedOrdersInput, all = false) {
      const input = returnedOrdersInputSchema.parse(value),
        ids = orderReportScope(user, input.storeIds),
        bounds = timestampReportBounds(config, input.from, input.to, clock());
      if (!ids.length)
        return {
          reader: bounds.reader,
          data: [] as ReturnedOrderRecord[],
          total: 0,
          page: 1,
          totalPages: 0,
        };
      let total: number, page: number, totalPages: number, rows: ReturnedOrderRecord[];
      const limit = all ? 70001 : input.pageSize,
        sort = all ? 'return_id' : input.sort;
      if (bounds.reader === 'bigquery') {
        if (!options.BQ_RETURNED_ORDERS_VIEW) return unavailable('BigQuery returned-orders view');
        const view = '`' + options.BQ_RETURNED_ORDERS_VIEW + '`',
          params = {
            start: bounds.from,
            end: bounds.to,
            stores: ids,
            search: input.search.toLowerCase(),
          },
          types = { start: 'DATETIME', end: 'DATETIME', stores: ['STRING'], search: 'STRING' },
          where =
            "return_date>=@start AND return_date<=@end AND CAST(store_id AS STRING) IN UNNEST(@stores) AND (@search='' OR EXISTS (SELECT 1 FROM UNNEST([store_name,CAST(order_id AS STRING),CAST(product_id AS STRING),CAST(quantity AS STRING),reason,sub_reason,comment,CAST(return_date AS STRING)]) AS cell WHERE STRPOS(LOWER(COALESCE(cell,'')),@search)>0))";
        const counted = await warehouse.queryReport(
          `SELECT COUNT(DISTINCT line_item_id) AS count FROM ${view} WHERE ${where}`,
          params,
          types,
          'returned-orders',
        );
        total = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(counted[0]?.count ?? 0);
        totalPages = Math.ceil(total / input.pageSize);
        page = all || input.page > totalPages ? 1 : input.page;
        const sortAlias = {
          store_name: 'store_name',
          order_id: 'order_id',
          prod_id: 'prod_id',
          qty: 'qty',
          pay_amount_refunded: 'pay_amount_refunded',
          reason: 'reason',
          sub_reason: 'sub_reason',
          comment: 'comment',
          created_at: 'created_at',
          order_date: 'order_date',
          return_id: 'return_id',
        }[sort];
        const result = await warehouse.queryReport(
          `SELECT line_item_id AS id,ANY_VALUE(source_return_id) AS return_id,ANY_VALUE(store_name) AS store_name,ANY_VALUE(order_id) AS order_id,ANY_VALUE(product_id) AS prod_id,ANY_VALUE(quantity) AS qty,MAX(pay_amount_refunded) AS pay_amount_refunded,ANY_VALUE(pay_amount_refunded_mode) AS pay_amount_refunded_mode,ANY_VALUE(reason) AS reason,ANY_VALUE(sub_reason) AS sub_reason,ANY_VALUE(comment) AS comment,ANY_VALUE(order_date) AS order_date,ANY_VALUE(return_date) AS created_at,ANY_VALUE(original_order_id) AS original_order_id FROM ${view} WHERE ${where} GROUP BY line_item_id ORDER BY ${sortAlias} ${all ? 'desc' : input.direction},id ASC LIMIT @limit OFFSET @offset`,
          { ...params, limit, offset: all ? 0 : (page - 1) * input.pageSize },
          { ...types, limit: 'INT64', offset: 'INT64' },
          'returned-orders',
        );
        rows = z.array(record).parse(result);
      } else {
        const reader = db.get('data'),
          search = '%' + input.search.replace(/[\\%_]/g, (value) => '\\' + value) + '%',
          where = and(
            or(
              eq(HasProduct.return_mode, 3),
              and(eq(HasProduct.return_mode, 5), eq(HasProduct.status, 'EXCHANGE_COMPLETED')),
            ),
            gt(ReturnOrder.store_id, 0),
            inArray(
              ReturnOrder.store_id,
              sql`(${sql.join(
                ids.map((id) => sql`${id}`),
                sql`,`,
              )})`,
            ),
            gte(ReturnOrder.created_at, bounds.from),
            lte(ReturnOrder.created_at, bounds.to),
            input.search
              ? or(
                  like(Store.store_name, search),
                  sql`cast(${ReturnOrder.order_id} as char) like ${search}`,
                  sql`cast(${ReturnOrder.prod_id} as char) like ${search}`,
                  sql`cast(${ReturnOrder.qty} as char) like ${search}`,
                  like(ReversePickupReason.reason, search),
                  like(SubReason.sub_reason, search),
                  like(ReturnOrder.comment, search),
                  sql`cast(${ReturnOrder.created_at} as char) like ${search}`,
                )
              : undefined,
          ),
          returned = and(
            eq(ReturnOrder.order_id, HasProduct.order),
            eq(ReturnOrder.prod_id, HasProduct.product),
            eq(ReturnOrder.has_product_id, HasProduct.id),
          );
        const [counted] = await reader
          .select({ count: sql<number>`count(distinct ${HasProduct.id})` })
          .from(HasProduct)
          .leftJoin(ReturnOrder, returned)
          .leftJoin(ReversePickupReason, eq(ReversePickupReason.id, sql`${ReturnOrder.reason_id}`))
          .leftJoin(SubReason, eq(SubReason.id, sql`${ReturnOrder.sub_reason_id}`))
          .leftJoin(Store, eq(Store.id, sql`${ReturnOrder.store_id}`))
          .where(where);
        total = Number(counted?.count || 0);
        totalPages = Math.ceil(total / input.pageSize);
        page = all || input.page > totalPages ? 1 : input.page;
        const result = await reader
          .select(selected)
          .from(HasProduct)
          .leftJoin(ReturnOrder, returned)
          .leftJoin(
            AmountToBeRefundedLog,
            and(
              eq(AmountToBeRefundedLog.order_id, ReturnOrder.order_id),
              eq(AmountToBeRefundedLog.prod_id, ReturnOrder.prod_id),
              eq(AmountToBeRefundedLog.has_product_id, HasProduct.id),
            ),
          )
          .leftJoin(ReversePickupReason, eq(ReversePickupReason.id, sql`${ReturnOrder.reason_id}`))
          .leftJoin(SubReason, eq(SubReason.id, sql`${ReturnOrder.sub_reason_id}`))
          .leftJoin(Store, eq(Store.id, sql`${ReturnOrder.store_id}`))
          .leftJoin(Order, eq(Order.id, HasProduct.order))
          .leftJoin(
            ReturnReportMoneyHistory,
            and(
              eq(ReturnReportMoneyHistory.orderId, sql`${Order.id}`),
              eq(ReturnReportMoneyHistory.hasProductId, HasProduct.id),
              eq(ReturnReportMoneyHistory.platform, 'EXCHANGE'),
              gt(ReturnReportMoneyHistory.addedAmount, 0),
            ),
          )
          .where(where)
          .groupBy(HasProduct.id)
          .orderBy(
            all || input.direction === 'desc' ? desc(selected[sort]) : asc(selected[sort]),
            asc(HasProduct.id),
          )
          .limit(limit)
          .offset(all ? 0 : (page - 1) * input.pageSize);
        rows = z.array(record).parse(result);
      }
      if (rows.length > 70000)
        throw new AppError(
          422,
          'REPORT_TOO_LARGE',
          'Select a smaller store/date range for export.',
        );
      return {
        reader: bounds.reader,
        data: rows.map((row) => ({
          ...row,
          pay_amount_refunded_mode: row.pay_amount_refunded_mode || null,
        })),
        total,
        page,
        totalPages,
      };
    },
  };
}
