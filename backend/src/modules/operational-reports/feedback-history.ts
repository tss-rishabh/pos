import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { normalizeWarehouseParameters } from '../warehouse-parameters.js';
import {
  currentFeedbackDimensions,
  type CurrentFeedbackDimensions,
} from './feedback-dimensions.js';
import { feedbackHistoryResult } from './feedback-history-contracts.js';
import { feedbackHistorySql } from './feedback-history-sql.js';
import type { FeedbackHistoryOptions } from './feedback-history-options.js';
import type { FeedbackInput } from './feedback.js';

export interface FeedbackHistoryStatement {
  statement: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
}
export type FeedbackHistoryEstimate = (statement: FeedbackHistoryStatement) => Promise<bigint>;
export interface FeedbackHistoryDependencies {
  dimensions?: CurrentFeedbackDimensions;
  estimate?: FeedbackHistoryEstimate;
}
function sdkEstimate(config: Config): FeedbackHistoryEstimate {
  let client: BigQuery | undefined;
  return async (input) => {
    if (!config.BIGQUERY_PROJECT_ID) return unavailable('BigQuery project');
    client ??= new BigQuery({
      projectId: config.BIGQUERY_PROJECT_ID,
      location: config.BIGQUERY_LOCATION,
    });
    try {
      const [job] = await client.createQueryJob({
          query: input.statement,
          params: normalizeWarehouseParameters(input.params, input.types),
          types: input.types,
          dryRun: true,
          useLegacySql: false,
          maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'customer-feedback' },
        }),
        metadata = z
          .object({
            statistics: z.object({
              query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
            }),
          })
          .parse(job.metadata);
      return BigInt(metadata.statistics.query.totalBytesProcessed);
    } catch {
      throw new AppError(
        503,
        'CUSTOMER_FEEDBACK_ESTIMATE_UNAVAILABLE',
        'Historical feedback cannot be verified right now.',
      );
    }
  };
}
function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    new Set(right).size === left.length &&
    left.every((id) => right.includes(id))
  );
}

/** Historical facts remain exclusively in BigQuery; all MySQL lookups are current dimensions/authority. */
export function feedbackHistoricalSearch(
  config: Config,
  db: Databases,
  options: FeedbackHistoryOptions,
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'>,
  dependencies: FeedbackHistoryDependencies = {},
) {
  const dimensions = dependencies.dimensions || currentFeedbackDimensions(db),
    estimate = dependencies.estimate || sdkEstimate(config),
    statement = feedbackHistorySql(options);
  return async (
    user: Principal,
    input: FeedbackInput,
    selection: readonly string[] | undefined,
    from: string,
    to: string,
  ) => {
    await dimensions.authorize(user, selection);
    const stores = selection === undefined ? undefined : await dimensions.knownStores(selection),
      customers = input.email ? await dimensions.emailCustomers(input.email) : undefined;
    const empty = { reader: 'bigquery' as const, data: [], total: 0, page: 1, totalPages: 0 };
    if (stores?.length === 0 || customers?.length === 0) {
      await dimensions.authorize(user, selection);
      return empty;
    }
    const params = {
        start: from,
        end: to,
        stores: stores || [],
        allStores: stores === undefined,
        orders: input.orderIds || [],
        allOrders: !input.orderIds?.length,
        customers: customers || [],
        allCustomers: customers === undefined,
        page: input.page,
        pageSize: input.pageSize,
      },
      types = {
        start: 'DATETIME',
        end: 'DATETIME',
        stores: ['STRING'],
        allStores: 'BOOL',
        orders: ['STRING'],
        allOrders: 'BOOL',
        customers: ['STRING'],
        allCustomers: 'BOOL',
        page: 'INT64',
        pageSize: 'INT64',
      },
      query = { statement, params, types },
      bytes = await estimate(query);
    if (bytes < 0n || bytes > BigInt(config.BIGQUERY_MAX_BYTES_BILLED))
      throw new AppError(
        503,
        'CUSTOMER_FEEDBACK_PROJECTION_REQUIRED',
        'Historical feedback needs a warehouse projection within the configured query budget.',
      );
    const response = await warehouse.queryReport(statement, params, types, 'customer-feedback');
    const parsed = z.array(feedbackHistoryResult).length(1).safeParse(response);
    if (!parsed.success)
      throw new AppError(
        503,
        'CUSTOMER_FEEDBACK_DATA_INVALID',
        'Historical feedback does not match its projection contract.',
      );
    const result = parsed.data[0]!,
      total = Number(result.total),
      totalPages = Math.ceil(total / input.pageSize),
      page = input.page > totalPages ? 1 : input.page;
    if (
      result.page !== page ||
      result.items.length > input.pageSize ||
      result.items.length !==
        Math.min(input.pageSize, Math.max(0, total - (page - 1) * input.pageSize))
    )
      throw new AppError(
        503,
        'CUSTOMER_FEEDBACK_DATA_INVALID',
        'Historical feedback does not match its projection contract.',
      );
    const allowedStores = stores === undefined ? undefined : new Set(stores),
      allowedCustomers = customers === undefined ? undefined : new Set(customers),
      allowedOrders = input.orderIds?.length ? new Set(input.orderIds) : undefined;
    if (
      result.items.some(
        (row, index) =>
          (allowedStores !== undefined &&
            (row.associatedStoreId === null || !allowedStores.has(row.associatedStoreId))) ||
          (allowedCustomers !== undefined &&
            (row.customerId === null || !allowedCustomers.has(row.customerId))) ||
          (allowedOrders !== undefined && !allowedOrders.has(row.orderId)) ||
          row.orderDate < from ||
          row.orderDate > to ||
          (index > 0 && BigInt(row.orderId) > BigInt(result.items[index - 1]!.orderId)),
      )
    )
      throw new AppError(
        503,
        'CUSTOMER_FEEDBACK_DATA_INVALID',
        'Historical feedback does not match its projection contract.',
      );
    await dimensions.authorize(user, selection);
    const data = await dimensions.enrich(result.items);
    if (data.length !== result.items.length)
      throw new AppError(
        503,
        'CUSTOMER_FEEDBACK_DATA_INVALID',
        'Historical feedback does not match its projection contract.',
      );
    if (
      customers !== undefined &&
      !sameIds(customers, await dimensions.emailCustomers(input.email!))
    )
      throw new AppError(
        409,
        'CUSTOMER_FEEDBACK_DIMENSION_CHANGED',
        'Customer details changed. Run the feedback search again.',
      );
    await dimensions.authorize(user, selection);
    return { reader: 'bigquery' as const, data, total, page, totalPages };
  };
}
