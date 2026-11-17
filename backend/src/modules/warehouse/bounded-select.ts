import { BigQuery, type Query } from '@google-cloud/bigquery';
import { z } from 'zod';
import { normalizeWarehouseParameters } from '../warehouse-parameters.js';
import { AppError } from '../../domain/errors.js';

export const boundedWarehouse = Object.freeze({
  project: 'tssgcp2025',
  dataset: 'tss_mysql_raw_layer',
  location: 'asia-south1',
});
export const qualifiedWarehouseTable = z
  .string()
  .regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/);
export interface BoundedSelect {
  sql: string;
  params: Record<string, string | number>;
  types: Record<string, string>;
}
export interface SelectJob {
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
export interface SelectClient {
  createQueryJob(query: Query): Promise<readonly [SelectJob, ...unknown[]]>;
}
export interface BoundedSelectPort {
  read(input: BoundedSelect, signal: AbortSignal): Promise<string>;
}
const failed = () =>
  new AppError(
    503,
    'BOUNDED_WAREHOUSE_SELECT_UNAVAILABLE',
    'The qualified warehouse result is unavailable.',
  );
/** Read-only, lazy SDK boundary. No destination, mutation, pagination or native
 * fallback is exposed. Every execution requires its own dry-run qualification. */
export function boundedWarehouseSelect(
  options: { maxBytes: number; timeoutMs: number; maxDocumentBytes: number; resource: string },
  factory?: () => SelectClient,
): BoundedSelectPort {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 1_000_000_000 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 25000 ||
    !Number.isSafeInteger(options.maxDocumentBytes) ||
    options.maxDocumentBytes < 1 ||
    options.maxDocumentBytes > 16_000_000 ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(options.resource)
  )
    throw failed();
  let client: SelectClient | undefined;
  const create =
    factory ??
    (() => {
      const native = new BigQuery({
        projectId: boundedWarehouse.project,
        location: boundedWarehouse.location,
        autoRetry: false,
        maxRetries: 0,
      });
      native.timeout = options.timeoutMs;
      return {
        async createQueryJob(query: Query) {
          const [job] = await native.createQueryJob(query);
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
  return {
    async read(input, signal) {
      if (
        !(signal instanceof AbortSignal) ||
        signal.aborted ||
        !/^WITH\b/.test(input.sql) ||
        input.sql.length > 40000 ||
        /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL|EXECUTE|DROP|GRANT|REVOKE)\b/i.test(
          input.sql,
        ) ||
        !Object.keys(input.params).every(
          (key) => /^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) && key in input.types,
        ) ||
        Object.keys(input.params).length !== Object.keys(input.types).length
      )
        throw failed();
      for (const match of input.sql.matchAll(/`([^`]+)`/g))
        if (!qualifiedWarehouseTable.safeParse(match[1]).success) throw failed();
      let expired = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      const jobs = new Set<SelectJob>(),
        cancelled = new WeakSet<SelectJob>();
      const cancel = () => {
        expired = true;
        for (const job of jobs)
          if (!cancelled.has(job)) {
            cancelled.add(job);
            void Promise.resolve()
              .then(() => job.cancel())
              .catch(() => undefined);
          }
      };
      let abort: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => {
          cancel();
          reject(failed());
        };
        timer = setTimeout(abort, options.timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const work = (async () => {
        client ??= create();
        const query: Query = {
          query: input.sql,
          params: normalizeWarehouseParameters(input.params, input.types),
          types: input.types,
          useLegacySql: false,
          useQueryCache: false,
          maximumBytesBilled: String(options.maxBytes),
          jobTimeoutMs: options.timeoutMs,
          location: boundedWarehouse.location,
          labels: { application: 'pos-rewrite', resource: options.resource },
        };
        const [estimate] = await client.createQueryJob({ ...query, dryRun: true });
        jobs.add(estimate);
        if (expired || signal.aborted) {
          cancel();
          throw failed();
        }
        const metadata = z
          .object({
            statistics: z.object({
              query: z.object({
                totalBytesProcessed: z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
                statementType: z.literal('SELECT').optional(),
                referencedTables: z
                  .array(
                    z.object({
                      projectId: z.literal(boundedWarehouse.project),
                      datasetId: z.literal(boundedWarehouse.dataset),
                      tableId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
                    }),
                  )
                  .min(1)
                  .max(100),
                referencedRoutines: z.array(z.unknown()).max(0).optional(),
              }),
            }),
          })
          .safeParse(estimate.metadata);
        if (
          !metadata.success ||
          BigInt(metadata.data.statistics.query.totalBytesProcessed) > BigInt(options.maxBytes)
        )
          throw failed();
        const [job] = await client.createQueryJob(query);
        jobs.add(job);
        if (expired || signal.aborted) {
          cancel();
          throw failed();
        }
        const [rows, next, response] = await job.getQueryResults({
          autoPaginate: false,
          maxResults: 2,
          maxApiCalls: 1,
          timeoutMs: options.timeoutMs,
          wrapIntegers: true,
        });
        const complete = z
          .object({
            jobComplete: z.literal(true),
            pageToken: z.string().max(0).optional(),
            errors: z.array(z.unknown()).max(0).optional(),
          })
          .safeParse(response);
        const parsed = z
          .array(z.object({ document: z.string().max(options.maxDocumentBytes) }).strict())
          .length(1)
          .safeParse(rows);
        if (
          next ||
          !complete.success ||
          !parsed.success ||
          Buffer.byteLength(parsed.data[0]!.document) > options.maxDocumentBytes ||
          expired ||
          signal.aborted
        )
          throw failed();
        return parsed.data[0]!.document;
      })();
      try {
        return await Promise.race([work, deadline]);
      } catch {
        cancel();
        throw failed();
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
      }
    },
  };
}
