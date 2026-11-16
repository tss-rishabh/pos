import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { normalizeWarehouseParameters } from '../warehouse-parameters.js';
import {
  customerHistorySql,
  customerHistoryLinesSql,
  historyTablesSchema,
  observedHistoryTables,
  type HistoryTables,
  type HistoryLayout,
} from './sql.js';
export function customerHistoryLayout(env: NodeJS.ProcessEnv = process.env): HistoryLayout {
  return z.enum(['raw', 'customer-bucket-v1']).parse(env.BQ_CUSTOMER_HISTORY_LAYOUT || 'raw');
}
export function customerHistoryOptions(env: NodeJS.ProcessEnv = process.env): HistoryTables {
  return historyTablesSchema.parse({
    orders: env.BQ_CUSTOMER_HISTORY_ORDERS_TABLE || observedHistoryTables.orders,
    orderStores: env.BQ_CUSTOMER_HISTORY_ORDER_STORES_TABLE || observedHistoryTables.orderStores,
    lines: env.BQ_CUSTOMER_HISTORY_LINES_TABLE || observedHistoryTables.lines,
    products: env.BQ_CUSTOMER_HISTORY_PRODUCTS_TABLE || observedHistoryTables.products,
    feedback: env.BQ_CUSTOMER_HISTORY_FEEDBACK_TABLE || observedHistoryTables.feedback,
  });
}
export interface HistoryStatement {
  statement: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
  resource: 'customer-history' | 'customer-history-lines';
}
export interface HistoryGateway {
  read(customerId: string, sourceNow: string, before: string, limit: number): Promise<unknown>;
  lines(customerId: string, orderId: string, before: string, limit: number): Promise<unknown>;
}
export type HistoryEstimator = (query: HistoryStatement) => Promise<bigint>;
export function historySdkEstimator(config: Config): HistoryEstimator {
  let client: BigQuery | undefined;
  return async (query) => {
    if (!config.BIGQUERY_PROJECT_ID) return unavailable('BigQuery project');
    client ??= new BigQuery({
      projectId: config.BIGQUERY_PROJECT_ID,
      location: config.BIGQUERY_LOCATION,
    });
    try {
      const [job] = await client.createQueryJob({
        query: query.statement,
        params: normalizeWarehouseParameters(query.params, query.types),
        types: query.types,
        dryRun: true,
        useLegacySql: false,
        maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
        jobTimeoutMs: 10000,
        labels: { application: 'pos-rewrite', resource: query.resource },
      });
      const result = z
        .object({
          statistics: z.object({
            query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
          }),
        })
        .parse(job.metadata);
      return BigInt(result.statistics.query.totalBytesProcessed);
    } catch {
      throw new AppError(
        503,
        'CUSTOMER_HISTORY_ESTIMATE_UNAVAILABLE',
        'Historical customer data cannot be verified right now.',
      );
    }
  };
}
export function customerHistoryGateway(
  config: Config,
  tables: HistoryTables = customerHistoryOptions(),
  estimate: HistoryEstimator = historySdkEstimator(config),
  queryReport = warehouseService(config).queryReport,
  layout: HistoryLayout = customerHistoryLayout(),
): HistoryGateway {
  if (
    layout === 'customer-bucket-v1' &&
    (['orders', 'orderStores', 'lines', 'feedback'] as const).some(
      (key) => tables[key] === observedHistoryTables[key],
    )
  )
    throw new AppError(
      503,
      'CUSTOMER_HISTORY_CONFIGURATION_INVALID',
      'Configure the deployed customer history projections before selecting their layout.',
    );
  async function query(value: HistoryStatement) {
    const bytes = await estimate(value);
    if (bytes < 0n || bytes > BigInt(config.BIGQUERY_MAX_BYTES_BILLED))
      throw new AppError(
        503,
        'CUSTOMER_HISTORY_PROJECTION_REQUIRED',
        'Historical customer data needs a warehouse projection within the configured query budget.',
      );
    const rows = await queryReport(value.statement, value.params, value.types, value.resource);
    if (rows.length !== 1)
      throw new AppError(
        503,
        'CUSTOMER_HISTORY_DATA_INVALID',
        'Historical customer data does not match its projection contract.',
      );
    return rows[0];
  }
  return {
    read: (customerId, sourceNow, before, limit) =>
      query({
        statement: customerHistorySql(tables, layout),
        params: { customer: customerId, sourceNow, returnBefore: before, pageSize: limit + 1 },
        types: {
          customer: 'STRING',
          sourceNow: 'DATETIME',
          returnBefore: 'STRING',
          pageSize: 'INT64',
        },
        resource: 'customer-history',
      }),
    lines: (customerId, orderId, before, limit) =>
      query({
        statement: customerHistoryLinesSql(tables, layout),
        params: { customer: customerId, order: orderId, before, pageSize: limit + 1 },
        types: { customer: 'STRING', order: 'STRING', before: 'STRING', pageSize: 'INT64' },
        resource: 'customer-history-lines',
      }),
  };
}
