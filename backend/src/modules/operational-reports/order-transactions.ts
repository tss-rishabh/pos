import { Temporal } from '@js-temporal/polyfill';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { identifier } from '../../domain/validation.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import {
  businessTimestamp,
  orderReportScope,
  timestampReportBounds,
  warehouseView,
} from './report-inputs.js';
import {
  orderReportLineSchema,
  preparedOrderRecords,
  type OrderReportLine,
  type PreparedOrderRecord,
} from './order-report-domain.js';
import { combinedOrderQueries, orderReportProjection } from './order-report-query.js';
import { orderReportSql } from './order-report-sql.js';
export const orderTransactionsInputSchema = z
  .object({
    from: businessTimestamp,
    to: businessTimestamp,
    storeIds: z.array(identifier).max(500).default([]),
    source: z.enum(['store', 'online']).default('store'),
    dateType: z.enum(['order_date', 'return_date']).default('order_date'),
    page: z.number().int().min(1).max(1000000).default(1),
    pageSize: z.number().int().min(1).max(500).default(25),
  })
  .strict();
export type OrderTransactionsInput = z.infer<typeof orderTransactionsInputSchema>;
export function orderTransactionsOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_STORE_ORDER_SALES_VIEW: warehouseView,
      BQ_STORE_ORDER_RETURNS_VIEW: warehouseView,
      BQ_ONLINE_ORDER_SALES_VIEW: warehouseView,
      BQ_ONLINE_ORDER_RETURNS_VIEW: warehouseView,
    })
    .parse(env);
}
const countRows = z.array(
    z.object({ count: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  ),
  aliases = [
    ...new Set(
      orderReportProjection(orderReportSql.store.sales).fields.map((field) => field.alias),
    ),
  ];
function lines(value: unknown): OrderReportLine[] {
  const result = z.array(orderReportLineSchema).safeParse(value);
  if (!result.success)
    throw new AppError(
      503,
      'REPORT_VIEW_INVALID',
      'Some report values do not match the required data contract.',
    );
  return result.data;
}
export function orderTransactionsReportService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof orderTransactionsOptions> = orderTransactionsOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async read(user: Principal, value: OrderTransactionsInput, all = false) {
      const input = orderTransactionsInputSchema.parse(value),
        stores = orderReportScope(user, input.storeIds),
        bounds = timestampReportBounds(config, input.from, input.to, clock());
      if (!stores.length)
        return {
          reader: bounds.reader,
          data: [] as PreparedOrderRecord[],
          total: 0,
          page: 1,
          totalPages: 0,
        };
      try {
        let total: number, page: number, totalPages: number, records: OrderReportLine[];
        const limit = all ? 70001 : input.pageSize;
        if (bounds.reader === 'bigquery') {
          const sales =
              input.source === 'store'
                ? options.BQ_STORE_ORDER_SALES_VIEW
                : options.BQ_ONLINE_ORDER_SALES_VIEW,
            returns =
              input.source === 'store'
                ? options.BQ_STORE_ORDER_RETURNS_VIEW
                : options.BQ_ONLINE_ORDER_RETURNS_VIEW;
          if (!sales || !returns) return unavailable('BigQuery order transaction views');
          const params = { start: bounds.from, end: bounds.to, stores },
            types = { start: 'DATETIME', end: 'DATETIME', stores: ['STRING'] },
            key = 'line_item_id,refund_order_id,refund_product_id',
            where = (returned: boolean) =>
              `${returned && input.dateType === 'return_date' ? 'return_created_at' : 'sale_created_at'}>=@start AND ${returned && input.dateType === 'return_date' ? 'return_created_at' : 'sale_created_at'}<=@end AND CAST(source_store_id AS STRING) IN UNNEST(@stores)`,
            count = (view: string, returned: boolean) =>
              `SELECT COUNT(*) FROM (SELECT ${key} FROM \`${view}\` WHERE ${where(returned)} GROUP BY ${key})`;
          const counts = await warehouse.queryReport(
            `SELECT (${count(sales, false)})+(${count(returns, true)}) AS count`,
            params,
            types,
            'order-transactions',
          );
          total = countRows.parse(counts)[0]?.count || 0;
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
              data: [] as PreparedOrderRecord[],
              total,
              page,
              totalPages,
            };
          const select = (view: string, returned: boolean) =>
              `SELECT ${aliases.map((alias) => (alias === 'PayAmountRefunded' ? 'MAX' : 'ANY_VALUE') + '(\`' + alias + '\`) AS \`' + alias + '\`').join(',')} FROM \`${view}\` WHERE ${where(returned)} GROUP BY ${key}`,
            result = await warehouse.queryReport(
              `SELECT * FROM ((${select(sales, false)}) UNION ALL (${select(returns, true)})) AS transactions ORDER BY transaction_date DESC,id DESC LIMIT @limit OFFSET @offset`,
              { ...params, limit, offset: all ? 0 : (page - 1) * input.pageSize },
              { ...types, limit: 'INT64', offset: 'INT64' },
              'order-transactions',
            );
          records = lines(result);
        } else {
          const reader = db.get('data'),
            query = combinedOrderQueries(
              input.source,
              input.dateType,
              bounds.from,
              bounds.to,
              stores,
            ),
            counted = await reader.execute(
              sql`SELECT (${query.salesCount})+(${query.returnsCount}) AS count`,
            );
          total = countRows.parse(counted[0])[0]?.count || 0;
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
              data: [] as PreparedOrderRecord[],
              total,
              page,
              totalPages,
            };
          const result = await reader.execute(
            sql`(${query.sales}) UNION ALL (${query.returns}) ORDER BY transaction_date DESC,id DESC LIMIT ${limit} OFFSET ${all ? 0 : (page - 1) * input.pageSize}`,
          );
          records = lines(result[0]);
        }
        if (records.length > 70000)
          throw new AppError(
            422,
            'REPORT_TOO_LARGE',
            'Select a smaller store/date range for export.',
          );
        return {
          reader: bounds.reader,
          data: preparedOrderRecords(records),
          total,
          page,
          totalPages,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          'REPORT_QUERY_FAILED',
          'The order transaction report could not be prepared.',
        );
      }
    },
  };
}
