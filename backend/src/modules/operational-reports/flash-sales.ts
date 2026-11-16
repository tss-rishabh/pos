import { Temporal } from '@js-temporal/polyfill';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { pythonRound2 } from '../../domain/python-round.js';
import { warehouseService } from '../warehouse.js';
import { orderReportScope, timestampReportBounds, warehouseView } from './report-inputs.js';
import { pythonRoundInteger } from './number-format.js';
import { reportCsvCell } from './export-domain.js';
import { flashSalesSourceColumns } from './flash-sales-sql.js';
import {
  flashSalesMysqlQuery,
  flashSalesWarehouseQuery,
  type FlashSalesWarehouseTables,
} from './flash-sales-query.js';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid calendar date.');
export const flashSalesInputSchema = z
  .object({
    from: date,
    to: date,
    storeIds: z.array(identifier).max(500).default([]),
    sort: z.literal('store_date').default('store_date'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    page: z.number().int().min(1).max(1000000).default(1),
    pageSize: z.number().int().min(1).max(500).default(25),
  })
  .strict();
export type FlashSalesInput = z.infer<typeof flashSalesInputSchema>;
export function flashSalesOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_FLASH_SALES_ORDERS_VIEW: warehouseView,
      BQ_FLASH_SALES_ORDER_STORES_VIEW: warehouseView,
      BQ_FLASH_SALES_LINES_VIEW: warehouseView,
      BQ_FLASH_SALES_STORES_VIEW: warehouseView,
      BQ_FLASH_SALES_PAYTM_TRANSACTIONS_VIEW: warehouseView,
      BQ_FLASH_SALES_RETURN_ORDERS_VIEW: warehouseView,
      BQ_FLASH_SALES_REFUND_LOGS_VIEW: warehouseView,
      BQ_FLASH_SALES_AUTOMATED_REFUNDS_VIEW: warehouseView,
    })
    .parse(env);
}
const numeric = z.coerce.number().finite().nullable();
export const flashSalesSourceRowSchema = z.object({
  StoreName: z.string().nullable(),
  date,
  total_number_of_bills: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_order_qty: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_tss_money: numeric,
  total_tss_points: numeric,
  total_coupon: numeric,
  total_gift_voucher: numeric,
  total_pg_disc: numeric,
  total_cash: numeric,
  total_paytm_card_amount: numeric,
  total_paytm_upi_amount: numeric,
  total_online_other: numeric,
  total_online: numeric,
  district_transation_amt: numeric,
  credit_pincode_amt: numeric,
});
export const flashRefundRowSchema = z.object({
  StoreName: z.string().nullable(),
  date,
  refunded_mode: z.string().nullable(),
  total_refunded_amt: numeric,
});
export type FlashSalesSourceRow = z.infer<typeof flashSalesSourceRowSchema>;
export type FlashRefundRow = z.infer<typeof flashRefundRowSchema>;
const key = (name: string | null, date: string) => JSON.stringify([name, date]);
/** One pass over refunds replaces source per-sales-row list scans without changing rounding/order. */
export function prepareFlashSales(
  sales: readonly FlashSalesSourceRow[],
  refunds: readonly FlashRefundRow[],
) {
  const byStore = new Map<string, { cash: number; money: number; points: number; other: number }>();
  for (const item of refunds) {
    const id = key(item.StoreName, item.date),
      row = byStore.get(id) || { cash: 0, money: 0, points: 0, other: 0 },
      value = pythonRound2(item.total_refunded_amt || 0);
    if (item.refunded_mode === 'CASH') row.cash = value;
    else if (item.refunded_mode === 'TSS_POINTS') row.points = value;
    else if (
      ['TSS_MONEY', 'OG_AS_TSS_MONEY', 'GIFT_CARD_AS_TSS_MONEY'].includes(item.refunded_mode || '')
    )
      row.money += value;
    else row.other += value;
    byStore.set(id, row);
  }
  return sales.map((row) => {
    const returns = byStore.get(key(row.StoreName, row.date)) || {
        cash: 0,
        money: 0,
        points: 0,
        other: 0,
      },
      rounded = (value: number | null) => (value ? pythonRound2(value) : 0),
      cash = rounded(row.total_cash),
      card = rounded(row.total_paytm_card_amount),
      upi = rounded(row.total_paytm_upi_amount),
      onlineOther = rounded(row.total_online_other),
      district = rounded(row.district_transation_amt),
      credit = rounded(row.credit_pincode_amt);
    return {
      tss_money: rounded(row.total_tss_money),
      tss_points: rounded(row.total_tss_points),
      coupon: rounded(row.total_coupon),
      gift_voucher: rounded(row.total_gift_voucher),
      pg_disc: rounded(row.total_pg_disc),
      cash,
      online: rounded(row.total_online),
      online_others: onlineOther,
      district_transation_amt: district,
      credit_pincode_amt: credit,
      date: row.date,
      cash_return: returns.cash,
      tss_money_return: returns.money,
      tss_point_return: returns.points,
      other_online_return: returns.other,
      StoreName: row.StoreName,
      net_cash: pythonRoundInteger(cash - returns.cash),
      total_number_of_bills: row.total_number_of_bills,
      total_number_of_qty_sold: row.total_order_qty,
      total_paytm_card_amount: card,
      total_paytm_upi_amount: upi,
      total_sales: cash + card + upi + onlineOther + district + credit,
    };
  });
}
export type FlashSalesRow = ReturnType<typeof prepareFlashSales>[number];
export function flashSalesCsv(rows: readonly FlashSalesRow[]) {
  return (
    '\uFEFF' +
    [
      flashSalesSourceColumns.map(([label]) => label),
      ...rows.map((row) =>
        flashSalesSourceColumns.map(([, field]) =>
          field in row ? row[field as keyof FlashSalesRow] : null,
        ),
      ),
    ]
      .map((row) => row.map(reportCsvCell).join(','))
      .join('\r\n')
  );
}
function warehouseTables(options: ReturnType<typeof flashSalesOptions>): FlashSalesWarehouseTables {
  const mapping = {
    orders: options.BQ_FLASH_SALES_ORDERS_VIEW,
    order_stores: options.BQ_FLASH_SALES_ORDER_STORES_VIEW,
    has_products: options.BQ_FLASH_SALES_LINES_VIEW,
    stores: options.BQ_FLASH_SALES_STORES_VIEW,
    pos_paytm_transactions: options.BQ_FLASH_SALES_PAYTM_TRANSACTIONS_VIEW,
    return_orders: options.BQ_FLASH_SALES_RETURN_ORDERS_VIEW,
    amount_to_be_refunded_log: options.BQ_FLASH_SALES_REFUND_LOGS_VIEW,
    automated_refund_sic_logs: options.BQ_FLASH_SALES_AUTOMATED_REFUNDS_VIEW,
  };
  if (Object.values(mapping).some((value) => !value))
    return unavailable('BigQuery flash sales compatible views');
  return z
    .record(
      z.enum([
        'orders',
        'order_stores',
        'has_products',
        'stores',
        'pos_paytm_transactions',
        'return_orders',
        'amount_to_be_refunded_log',
        'automated_refund_sic_logs',
      ]),
      z.string(),
    )
    .parse(mapping);
}
export function flashSalesReportService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof flashSalesOptions> = flashSalesOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async read(user: Principal, value: FlashSalesInput, all = false) {
      const input = flashSalesInputSchema.parse(value),
        selected = orderReportScope(user, input.storeIds),
        stores = user.userType === 2 ? [...new Set(user.storeIds)] : selected,
        bounds = timestampReportBounds(
          config,
          input.from + 'T00:00:00',
          input.to + 'T23:59:59',
          clock(),
        );
      if (!stores.length)
        return {
          reader: bounds.reader,
          data: [] as FlashSalesRow[],
          total: 0,
          page: 1,
          totalPages: 0,
        };
      try {
        const kind = all ? 'export' : 'interactive',
          params = { start: bounds.from, end: bounds.to, stores },
          types = { start: 'DATETIME', end: 'DATETIME', stores: ['STRING'] };
        let sales: FlashSalesSourceRow[], refunds: FlashRefundRow[];
        if (bounds.reader === 'bigquery') {
          const tables = warehouseTables(options);
          sales = z
            .array(flashSalesSourceRowSchema)
            .parse(
              await warehouse.queryReport(
                flashSalesWarehouseQuery(kind, tables) + ' LIMIT 70001',
                params,
                types,
                'flash-sales',
              ),
            );
          if (sales.length > 70000)
            throw new AppError(
              422,
              'REPORT_TOO_LARGE',
              'Select a smaller store/date range for export.',
            );
          refunds = sales.length
            ? z
                .array(flashRefundRowSchema)
                .parse(
                  await warehouse.queryReport(
                    flashSalesWarehouseQuery('refunds', tables) + ' LIMIT 70001',
                    params,
                    types,
                    'flash-sales',
                  ),
                )
            : [];
        } else {
          const reader = db.get('data'),
            result = await reader.execute(
              sql`${flashSalesMysqlQuery(kind, bounds.from, bounds.to, stores)} LIMIT 70001`,
            );
          sales = z.array(flashSalesSourceRowSchema).parse(result[0]);
          if (sales.length > 70000)
            throw new AppError(
              422,
              'REPORT_TOO_LARGE',
              'Select a smaller store/date range for export.',
            );
          const returned = sales.length
            ? await reader.execute(
                sql`${flashSalesMysqlQuery('refunds', bounds.from, bounds.to, stores)} LIMIT 70001`,
              )
            : null;
          refunds = returned ? z.array(flashRefundRowSchema).parse(returned[0]) : [];
        }
        if (refunds.length > 70000)
          throw new AppError(
            422,
            'REPORT_TOO_LARGE',
            'Select a smaller store/date range for export.',
          );
        const total = sales.length,
          totalPages = Math.ceil(total / input.pageSize),
          page = all || input.page > totalPages ? 1 : input.page;
        if (input.direction === 'desc') sales.reverse();
        return {
          reader: bounds.reader,
          data: prepareFlashSales(
            all ? sales : sales.slice((page - 1) * input.pageSize, page * input.pageSize),
            refunds,
          ),
          total,
          page,
          totalPages,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          'REPORT_QUERY_FAILED',
          'The flash sales report could not be prepared.',
        );
      }
    },
  };
}
