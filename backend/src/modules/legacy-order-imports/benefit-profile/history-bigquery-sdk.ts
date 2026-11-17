import { BigQuery, type Query } from '@google-cloud/bigquery';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { normalizeWarehouseParameters } from '../../warehouse-parameters.js';
import { couponPublicationError } from './history-publication.js';
import {
  couponWarehouse,
  couponWarehouseDocumentBytes,
  type CouponBigQueryOptions,
} from './history-warehouse-contracts.js';
import {
  assertCouponWarehouseStatement,
  type CouponWarehouseStatement,
} from './history-warehouse-query.js';
export interface CouponHistoryQueryPort {
  estimate(input: CouponWarehouseStatement, signal?: AbortSignal): Promise<bigint>;
  execute(input: CouponWarehouseStatement, signal?: AbortSignal): Promise<unknown>;
}
export interface CouponHistoryJob {
  metadata: unknown;
  cancel(): Promise<unknown>;
  getQueryResults(options: {
    autoPaginate: false;
    maxResults: number;
    maxApiCalls: number;
    timeoutMs: number;
    wrapIntegers: true;
  }): Promise<readonly [unknown, unknown?, unknown?]>;
}
export interface CouponHistoryClient {
  createQueryJob(input: Query): Promise<readonly [CouponHistoryJob, ...unknown[]]>;
}
/** Google SDK and credentials are instantiated only on the first qualified
 * query. No destination/export/schema operation is exposed by this adapter. */
export function couponHistorySdk(
  options: CouponBigQueryOptions,
  clientFactory?: () => CouponHistoryClient,
): CouponHistoryQueryPort {
  let client: CouponHistoryClient | undefined;
  const approved = new WeakMap<CouponWarehouseStatement, bigint>();
  const factory =
    clientFactory ??
    (() => {
      const native = new BigQuery({
        projectId: couponWarehouse.project,
        location: couponWarehouse.location,
        autoRetry: false,
        maxRetries: 0,
      });
      native.timeout = options.CSV_COUPON_QUERY_TIMEOUT_MS;
      return {
        async createQueryJob(input: Query) {
          const [job] = await native.createQueryJob(input);
          return [
            {
              metadata: job.metadata,
              cancel: () => job.cancel(),
              async getQueryResults(settings) {
                const [rows, next, response] = await job.getQueryResults(settings);
                return [rows, next, response] as const;
              },
            },
          ] as const;
        },
      };
    });
  async function run(input: CouponWarehouseStatement, dryRun: boolean, signal?: AbortSignal) {
    assertCouponWarehouseStatement(input);
    if (
      !/^WITH\b/.test(input.statement) ||
      /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL)\b/i.test(input.statement) ||
      signal?.aborted
    )
      throw couponPublicationError('QUERY_DEFINITION', 503);
    if (!dryRun) {
      const estimate = approved.get(input);
      approved.delete(input);
      if (estimate === undefined || estimate > BigInt(options.CSV_COUPON_MAX_BYTES_BILLED))
        throw couponPublicationError('ESTIMATE_REQUIRED', 503);
    }
    let job: CouponHistoryJob | undefined,
      expired = false,
      cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      expired = true;
      if (job && !cancelled) {
        cancelled = true;
        void Promise.resolve()
          .then(() => job!.cancel())
          .catch(() => undefined);
      }
    };
    let abort: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancel();
        reject(couponPublicationError('WAREHOUSE_UNAVAILABLE', 503));
      };
      timer = setTimeout(abort, options.CSV_COUPON_QUERY_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    const work = (async () => {
      client ??= factory();
      [job] = await client.createQueryJob({
        query: input.statement,
        params: normalizeWarehouseParameters(input.params, input.types),
        types: input.types,
        useLegacySql: false,
        dryRun,
        useQueryCache: false,
        maximumBytesBilled: String(options.CSV_COUPON_MAX_BYTES_BILLED),
        jobTimeoutMs: options.CSV_COUPON_QUERY_TIMEOUT_MS,
        location: couponWarehouse.location,
        labels: {
          application: 'pos-rewrite',
          resource: input.purpose === 'candidate' ? 'csv-coupon-candidate' : 'csv-coupon-history',
        },
      });
      if (expired) {
        cancel();
        throw couponPublicationError('WAREHOUSE_UNAVAILABLE', 503);
      }
      if (dryRun) {
        const meta = z
          .object({
            statistics: z.object({
              query: z.object({
                totalBytesProcessed: z.string().regex(/^(?:0|[1-9]\d{0,18})$/),
                statementType: z.literal('SELECT').optional(),
                referencedTables: z
                  .array(
                    z.object({
                      projectId: z.literal(couponWarehouse.project),
                      datasetId: z.literal(couponWarehouse.dataset),
                      tableId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
                    }),
                  )
                  .min(1)
                  .max(100),
                referencedRoutines: z.array(z.unknown()).max(0).optional(),
                schema: z
                  .object({
                    fields: z
                      .array(z.object({ name: z.literal('document'), type: z.literal('STRING') }))
                      .length(1),
                  })
                  .optional(),
              }),
            }),
          })
          .safeParse(job.metadata);
        if (!meta.success) throw couponPublicationError('ESTIMATE_INVALID', 503);
        const bytes = BigInt(meta.data.statistics.query.totalBytesProcessed);
        if (bytes > BigInt(options.CSV_COUPON_MAX_BYTES_BILLED))
          throw couponPublicationError('WAREHOUSE_BUDGET', 503);
        return bytes;
      }
      const [rows, next, response] = await job.getQueryResults({
        autoPaginate: false,
        maxResults: 2,
        maxApiCalls: 1,
        timeoutMs: options.CSV_COUPON_QUERY_TIMEOUT_MS,
        wrapIntegers: true,
      });
      const completion = z
        .object({
          jobComplete: z.literal(true),
          pageToken: z.string().max(0).optional(),
          schema: z
            .object({
              fields: z
                .array(z.object({ name: z.literal('document'), type: z.literal('STRING') }))
                .length(1),
            })
            .optional(),
        })
        .safeParse(response);
      const bounded = z
        .array(z.object({ document: z.string().max(couponWarehouseDocumentBytes) }).strict())
        .length(1)
        .safeParse(rows);
      if (
        next ||
        !completion.success ||
        !bounded.success ||
        Buffer.byteLength(bounded.data[0]!.document) > couponWarehouseDocumentBytes
      )
        throw couponPublicationError('WAREHOUSE_INCOMPLETE');
      if (expired || signal?.aborted) throw couponPublicationError('WAREHOUSE_UNAVAILABLE', 503);
      return bounded.data;
    })();
    try {
      return await Promise.race([deadline, work]);
    } catch (error) {
      cancel();
      if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_COUPON_PUBLICATION_'))
        throw error;
      throw couponPublicationError('WAREHOUSE_UNAVAILABLE', 503);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async estimate(input, signal) {
      approved.delete(input);
      const result = await run(input, true, signal);
      if (typeof result !== 'bigint') throw couponPublicationError('ESTIMATE_INVALID', 503);
      approved.set(input, result);
      return result;
    },
    execute: (input, signal) => run(input, false, signal),
  };
}
