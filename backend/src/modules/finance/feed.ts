import { Temporal } from '@js-temporal/polyfill';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Store } from '../../db/legacy-schema.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { businessRange, routeRead } from '../../domain/routing.js';
import { warehouseService } from '../warehouse.js';
import {
  feedLineSchema,
  feedSaleLineSchema,
  reconciliationPage,
  reconciliationRecords,
  type FeedLine,
} from './feed-domain.js';
import { feedQueries } from './feed-query.js';

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(16).max(1024).optional(),
);
const table = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  )
  .optional();
export function financeFeedOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      GLASSBOX_FINANCE_FEED_API_KEY: optionalSecret,
      GLASSBOX_FINANCE_FEED_MAX_DATE_RANGE_DAYS: z.coerce.number().int().min(0).max(62).default(1),
      GLASSBOX_FINANCE_FEED_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(10000).default(1000),
      BQ_FINANCE_RECONCILIATION_SALES: table,
      BQ_FINANCE_RECONCILIATION_RETURNS: table,
    })
    .parse(env);
}
export type FinanceFeedOptions = ReturnType<typeof financeFeedOptions>;
export interface FeedInput {
  from: string;
  to: string;
  page: number;
  pageSize: number;
  storeCode?: string;
}
export function financeFeedService(
  config: Config,
  db: Databases,
  options: FinanceFeedOptions = financeFeedOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async orders(input: FeedInput) {
      const from = Temporal.PlainDate.from(input.from),
        to = Temporal.PlainDate.from(input.to),
        span = to.since(from, { largestUnit: 'days' }).days;
      if (span < 0 || span > options.GLASSBOX_FINANCE_FEED_MAX_DATE_RANGE_DAYS)
        throw new AppError(
          400,
          'INVALID_DATE_RANGE',
          `Select a reconciliation range of ${options.GLASSBOX_FINANCE_FEED_MAX_DATE_RANGE_DAYS} days or less.`,
        );
      const range = {
          start: businessRange(input.from, config.BUSINESS_TIMEZONE).start,
          end: businessRange(input.to, config.BUSINESS_TIMEZONE).end,
        },
        reader = routeRead({ kind: 'report', range }, clock(), config.BUSINESS_TIMEZONE),
        end = to.add({ days: 1 }).toString();
      if (input.storeCode) {
        const [store] = await db
          .get('primary')
          .select({ id: Store.id })
          .from(Store)
          .where(eq(Store.location_code, input.storeCode))
          .limit(1);
        if (!store)
          throw new AppError(
            400,
            'UNKNOWN_STORE_CODE',
            'The store code does not match an existing store.',
          );
      }
      let sales: FeedLine[], returns: FeedLine[];
      const params = {
          start: input.from,
          end,
          ...(input.storeCode ? { storeCode: input.storeCode } : {}),
        },
        types = {
          start: 'DATE',
          end: 'DATE',
          ...(input.storeCode ? { storeCode: 'STRING' } : {}),
        };
      const read = async (tableName: string | undefined) => {
        if (!tableName) return unavailable('BigQuery finance reconciliation table');
        return warehouse.queryReport(
          `SELECT * FROM \`${tableName}\` WHERE transaction_date>=DATETIME(@start) AND transaction_date<DATETIME(@end)${input.storeCode ? ' AND LocationCode=@storeCode' : ''} ORDER BY line_item_id LIMIT 70001`,
          params,
          types,
          'finance-reconciliation',
        );
      };
      // Today's returns still use the original sale's tax/cost/header facts.
      // Require that complete historical part before starting a bounded DATA
      // sales read; a missing/failed warehouse never becomes a native fallback.
      if (!options.BQ_FINANCE_RECONCILIATION_RETURNS)
        return unavailable('BigQuery finance reconciliation returns table');
      if (reader === 'bigquery') {
        const [saleRows, returnRows] = await Promise.all([
          read(options.BQ_FINANCE_RECONCILIATION_SALES),
          read(options.BQ_FINANCE_RECONCILIATION_RETURNS),
        ]);
        sales = z.array(feedSaleLineSchema).parse(saleRows);
        returns = z.array(feedLineSchema).parse(returnRows);
      } else {
        const queries = feedQueries(input.from, end, input.storeCode),
          database = db.get('data'),
          [saleRows, returnRows] = await Promise.all([
            database.execute(queries.sales),
            read(options.BQ_FINANCE_RECONCILIATION_RETURNS),
          ]);
        sales = z.array(feedSaleLineSchema).parse(saleRows[0]);
        returns = z.array(feedLineSchema).parse(returnRows);
      }
      if (sales.length > 70000 || returns.length > 70000 || sales.length + returns.length > 70000)
        throw new AppError(
          422,
          'REPORT_TOO_LARGE',
          'Select a smaller store/date range for reconciliation.',
        );
      return reconciliationPage(
        reconciliationRecords(sales, returns),
        input.page,
        Math.min(Math.max(input.pageSize, 1), options.GLASSBOX_FINANCE_FEED_MAX_PAGE_SIZE),
      );
    },
  };
}
