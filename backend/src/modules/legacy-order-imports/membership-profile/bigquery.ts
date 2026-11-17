import { createHash } from 'node:crypto';
import { BigQuery, type Job, type Query } from '@google-cloud/bigquery';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { operationHash } from '../../checkout/crypto.js';
import { normalizeWarehouseParameters } from '../../warehouse-parameters.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import {
  assertQualifiedCsvMembershipHistory,
  csvMembershipHistoryHash,
  csvMembershipHistoryRequestSchema,
  type CsvMembershipHistoryPort,
  type CsvMembershipHistoryRequest,
  type QualifiedCsvMembershipHistory,
} from './history.js';

export const csvMembershipBigQueryContract = 'pos-csv-membership-bigquery-v1';
export const csvMembershipPublicationContract = 'pos-csv-membership-publication-v1';
export const csvMembershipWarehouse = Object.freeze({
  project: 'tssgcp2025',
  dataset: 'tss_mysql_raw_layer',
  location: 'asia-south1',
});
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.string().regex(/^(0|[1-9]\d{0,18})$/),
  sourceId = z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n),
  wall = csvMembershipHistoryRequestSchema.shape.asOf,
  instant = z.iso.datetime({ offset: true }),
  view = z.string().regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
  zone = z
    .string()
    .max(128)
    .refine((value) => {
      if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(value) && value !== 'UTC') return false;
      try {
        Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);
        return true;
      } catch {
        return false;
      }
    });
const optional = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export const csvMembershipBigQueryOptionsSchema = z.object({
  CSV_MEMBERSHIP_BIGQUERY_CONTRACT: optional(z.literal(csvMembershipBigQueryContract)),
  BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW: optional(view),
  BQ_CSV_MEMBERSHIP_ORDERS_VIEW: optional(view),
  BQ_CSV_MEMBERSHIP_LINES_VIEW: optional(view),
  CSV_MEMBERSHIP_SOURCE_TIMEZONE: optional(zone),
  CSV_MEMBERSHIP_MAX_BYTES_BILLED: z.coerce.number().int().min(1).max(1000000000).default(50000000),
  CSV_MEMBERSHIP_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(8000),
  CSV_MEMBERSHIP_MAX_ORDERS: z.coerce.number().int().min(1).max(5000).default(1000),
  CSV_MEMBERSHIP_MAX_LINES: z.coerce.number().int().min(1).max(10000).default(10000),
  CSV_MEMBERSHIP_MAX_LAG_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
});
export type CsvMembershipBigQueryOptions = z.infer<typeof csvMembershipBigQueryOptionsSchema>;
export function readCsvMembershipBigQueryOptions(env: NodeJS.ProcessEnv = process.env) {
  const parsed = csvMembershipBigQueryOptionsSchema.safeParse(env);
  if (!parsed.success) throw historyError('CONFIGURATION', 503);
  return parsed.data;
}
export function csvMembershipSourceInstant(asOf: string, sourceTimeZone: string): number {
  try {
    return Temporal.PlainDateTime.from(wall.parse(asOf).replace(' ', 'T'))
      .toZonedDateTime(zone.parse(sourceTimeZone), { disambiguation: 'reject' })
      .toInstant().epochMilliseconds;
  } catch {
    throw historyError('CLOCK');
  }
}
const order = z
  .object({
    id: sourceId,
    paymentMethod: z.number().int().min(0).max(32767),
    createdAt: wall,
  })
  .strict();
const line = z
  .object({
    orderId: sourceId,
    lineId: sourceId,
    productId: sourceId,
    isExclusiveOrder: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
/** A trusted source publisher signs independent source facts. A CDC watermark
 * or two copies of a warehouse-derived hash is not this completeness proof. */
export const csvMembershipPublicationSchema = z
  .object({
    contract: z.literal(csvMembershipPublicationContract),
    generationId: hash,
    customerId: sourceId,
    asOf: wall,
    cutoff: wall,
    sourceTimeZone: zone,
    sourceSnapshotId: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    sourceSnapshotAt: instant,
    sourceCdcThrough: instant,
    publishedAt: instant,
    sourceComplete: z.literal(true),
    sourceOrderCount: count,
    warehouseOrderCount: count,
    sourceSelectedOrderCount: count,
    warehouseSelectedOrderCount: count,
    sourceLineCount: count,
    warehouseLineCount: count,
    sourceHistoryHash: hash,
    warehouseHistoryHash: hash,
    signature: hash,
  })
  .strict();
export type CsvMembershipPublication = z.infer<typeof csvMembershipPublicationSchema>;
export type CsvMembershipSelection = Pick<
  QualifiedCsvMembershipHistory,
  'lastDeliveredOrder' | 'recentDeliveredOrders'
>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
/** Independent source and warehouse reducers use these exact, minimal bytes.
 * Operation/plan binding belongs to the private response HMAC, not a raw table. */
export function csvMembershipSelectionHash(
  input: Pick<CsvMembershipHistoryRequest, 'customerId' | 'asOf' | 'cutoff'>,
  selection: CsvMembershipSelection,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'legacy-order-imports.membership-selection.v1',
        input: canonical({
          customerId: input.customerId,
          asOf: input.asOf,
          cutoff: input.cutoff,
          ...selection,
        }),
      }),
    )
    .digest('hex');
}
export function csvMembershipPublicationHash(
  value: Omit<CsvMembershipPublication, 'signature'>,
  key: string,
) {
  validKeys(key);
  return operationHash('legacy-order-imports.membership-publication.v1', value, key);
}
export interface CsvMembershipHistoryStatement {
  statement: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
}
export function csvMembershipHistorySql(
  options: CsvMembershipBigQueryOptions,
  input: CsvMembershipHistoryRequest,
): CsvMembershipHistoryStatement {
  qualified(options);
  const publications = options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW!,
    orders = options.BQ_CSV_MEMBERSHIP_ORDERS_VIEW!,
    lines = options.BQ_CSV_MEMBERSHIP_LINES_VIEW!;
  // One statement sees one immutable generation. No raw table or current MySQL
  // fallback. Null/subsecond source dates are diagnosed. The literal source
  // includes future-dated delivered rows; no upper date predicate is invented.
  const statement = `WITH publications AS (
SELECT * FROM \`${publications}\`
WHERE scope_shard=@scopeShard AND contract=@contract AND customer_id=@customer AND as_of=@asOf AND cutoff=@cutoff
AND source_time_zone=@zone LIMIT 2
), delivered AS (
SELECT o.* FROM \`${orders}\` o
WHERE o.scope_shard=@scopeShard AND o.customer_id=@customer AND o.order_status=3
AND o.generation_id IN (SELECT generation_id FROM publications)
), selected AS (
SELECT * FROM delivered
WHERE created_at>@cutoff OR created_at=(SELECT MAX(created_at) FROM delivered)
), bounded_orders AS (
SELECT * FROM selected ORDER BY created_at DESC,SAFE_CAST(order_id AS INT64) DESC LIMIT @orderTake
), selected_lines AS (
SELECT l.* FROM \`${lines}\` l
WHERE l.scope_shard=@scopeShard AND l.generation_id IN (SELECT generation_id FROM publications)
AND l.order_id IN (SELECT order_id FROM bounded_orders)
)
SELECT TO_JSON_STRING(STRUCT(
ARRAY(SELECT AS STRUCT SUBSTR(contract,1,64) AS contract,SUBSTR(generation_id,1,65) AS generationId,SUBSTR(customer_id,1,20) AS customerId,
FORMAT_DATETIME('%F %T',as_of) AS asOf,FORMAT_DATETIME('%F %T',cutoff) AS cutoff,
SUBSTR(source_time_zone,1,129) AS sourceTimeZone,SUBSTR(source_snapshot_id,1,129) AS sourceSnapshotId,
FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_snapshot_at,'UTC') AS sourceSnapshotAt,
FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_cdc_through,'UTC') AS sourceCdcThrough,
FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',published_at,'UTC') AS publishedAt,
source_complete AS sourceComplete,CAST(source_order_count AS STRING) AS sourceOrderCount,
CAST(warehouse_order_count AS STRING) AS warehouseOrderCount,
CAST(source_selected_order_count AS STRING) AS sourceSelectedOrderCount,
CAST(warehouse_selected_order_count AS STRING) AS warehouseSelectedOrderCount,
CAST(source_line_count AS STRING) AS sourceLineCount,CAST(warehouse_line_count AS STRING) AS warehouseLineCount,
SUBSTR(source_history_hash,1,65) AS sourceHistoryHash,SUBSTR(warehouse_history_hash,1,65) AS warehouseHistoryHash,SUBSTR(signature,1,65) AS signature
FROM publications) AS publications,
STRUCT(
CAST((SELECT COUNT(*) FROM delivered) AS STRING) AS orders,
CAST((SELECT COUNT(DISTINCT order_id) FROM delivered) AS STRING) AS uniqueOrders,
CAST((SELECT COUNT(*) FROM selected) AS STRING) AS selectedOrders,
CAST((SELECT COUNT(DISTINCT order_id) FROM selected) AS STRING) AS uniqueSelectedOrders,
CAST((SELECT COUNT(*) FROM selected_lines) AS STRING) AS lines,
CAST((SELECT COUNT(DISTINCT line_id) FROM selected_lines) AS STRING) AS uniqueLines,
CAST((SELECT COUNT(*) FROM delivered WHERE created_at IS NULL
OR created_at!=DATETIME_TRUNC(created_at,SECOND)
OR SAFE_CAST(order_id AS INT64) IS NULL OR SAFE_CAST(order_id AS INT64)<=0
OR payment_method IS NULL OR payment_method<0 OR payment_method>32767) AS STRING) AS invalidOrders,
CAST((SELECT COUNT(*) FROM delivered WHERE created_at=(SELECT MAX(created_at) FROM delivered)) AS STRING) AS latestTies,
CAST((SELECT COUNT(*) FROM selected_lines WHERE customer_id IS NULL OR customer_id!=@customer) AS STRING) AS foreignLines
) AS actual,
ARRAY(SELECT AS STRUCT SUBSTR(order_id,1,20) AS id,payment_method AS paymentMethod,
FORMAT_DATETIME('%F %T',created_at) AS createdAt FROM bounded_orders
ORDER BY created_at DESC,SAFE_CAST(order_id AS INT64) DESC) AS orders,
ARRAY(SELECT AS STRUCT SUBSTR(order_id,1,20) AS orderId,SUBSTR(line_id,1,20) AS lineId,SUBSTR(product_id,1,20) AS productId,
is_exclusive_order AS isExclusiveOrder FROM selected_lines
ORDER BY SAFE_CAST(order_id AS INT64),SAFE_CAST(line_id AS INT64) LIMIT @lineTake) AS lines
)) AS document`;
  return {
    statement,
    params: {
      contract: csvMembershipPublicationContract,
      customer: input.customerId,
      scopeShard: Number(BigInt(input.customerId) % 1024n),
      asOf: input.asOf,
      cutoff: input.cutoff,
      zone: options.CSV_MEMBERSHIP_SOURCE_TIMEZONE!,
      orderTake: options.CSV_MEMBERSHIP_MAX_ORDERS + 1,
      lineTake: options.CSV_MEMBERSHIP_MAX_LINES + 1,
    },
    types: {
      contract: 'STRING',
      customer: 'STRING',
      scopeShard: 'INT64',
      asOf: 'DATETIME',
      cutoff: 'DATETIME',
      zone: 'STRING',
      orderTake: 'INT64',
      lineTake: 'INT64',
    },
  };
}
function historyError(kind: string, status = 409) {
  return importFinancialError('ORDER_IMPORT_MEMBERSHIP_HISTORY_' + kind, status);
}
function validatedScope(value: unknown) {
  try {
    return csvMembershipHistoryRequestSchema.parse(value);
  } catch {
    throw historyError('INVALID');
  }
}
function validKeys(...values: string[]) {
  if (values.some((value) => !/^[!-~]{32,4096}$/.test(value)))
    throw historyError('KEY_REQUIRED', 503);
}
function qualified(options: CsvMembershipBigQueryOptions) {
  const parsed = csvMembershipBigQueryOptionsSchema.safeParse(options);
  if (!parsed.success) throw historyError('CONFIGURATION', 503);
  if (
    options.CSV_MEMBERSHIP_BIGQUERY_CONTRACT !== csvMembershipBigQueryContract ||
    !options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW ||
    !options.BQ_CSV_MEMBERSHIP_ORDERS_VIEW ||
    !options.BQ_CSV_MEMBERSHIP_LINES_VIEW ||
    !options.CSV_MEMBERSHIP_SOURCE_TIMEZONE
  )
    throw historyError('REQUIRED', 503);
  if (
    new Set([
      options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW,
      options.BQ_CSV_MEMBERSHIP_ORDERS_VIEW,
      options.BQ_CSV_MEMBERSHIP_LINES_VIEW,
    ]).size !== 3
  )
    throw historyError('CONFIGURATION', 503);
}
export interface CsvMembershipHistoryQueryPort {
  estimate(input: CsvMembershipHistoryStatement, signal?: AbortSignal): Promise<bigint>;
  execute(input: CsvMembershipHistoryStatement, signal?: AbortSignal): Promise<unknown>;
}
function exactStatement(
  options: CsvMembershipBigQueryOptions,
  input: CsvMembershipHistoryStatement,
) {
  const params = z
    .object({
      contract: z.literal(csvMembershipPublicationContract),
      customer: sourceId,
      scopeShard: z.number().int().min(0).max(1023),
      asOf: wall,
      cutoff: wall,
      zone,
      orderTake: z.literal(options.CSV_MEMBERSHIP_MAX_ORDERS + 1),
      lineTake: z.literal(options.CSV_MEMBERSHIP_MAX_LINES + 1),
    })
    .strict()
    .safeParse(input.params);
  if (!params.success || params.data.zone !== options.CSV_MEMBERSHIP_SOURCE_TIMEZONE)
    throw historyError('DEFINITION', 503);
  const request = validatedScope({
    contract: 'pos-csv-membership-history-v1',
    operationId: '00000000-0000-4000-8000-000000000000',
    requestHash: '0'.repeat(64),
    planHash: '0'.repeat(64),
    customerId: params.data.customer,
    asOf: params.data.asOf,
    cutoff: params.data.cutoff,
  });
  const expected = csvMembershipHistorySql(options, request);
  if (
    input.statement !== expected.statement ||
    JSON.stringify(canonical(input.params)) !== JSON.stringify(canonical(expected.params)) ||
    JSON.stringify(canonical(input.types)) !== JSON.stringify(canonical(expected.types))
  )
    throw historyError('DEFINITION', 503);
  return expected;
}
/** Small purpose-scoped SDK driver; no caller-supplied SQL, destinations,
 * exports, schemas, DML or unbounded SDK auto-pagination. */
export function csvMembershipHistorySdk(
  options: CsvMembershipBigQueryOptions,
  clientFactory = () => {
    const client = new BigQuery({
      projectId: csvMembershipWarehouse.project,
      location: csvMembershipWarehouse.location,
      autoRetry: false,
      maxRetries: 0,
    });
    client.timeout = options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS;
    return client;
  },
  definition?: (input: CsvMembershipHistoryStatement) => CsvMembershipHistoryStatement,
): CsvMembershipHistoryQueryPort {
  let client: BigQuery | undefined;
  async function run(input: CsvMembershipHistoryStatement, dryRun: boolean, signal?: AbortSignal) {
    qualified(options);
    input = definition ? definition(input) : exactStatement(options, input);
    if (
      !/^WITH\b/.test(input.statement) ||
      /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL)\b/i.test(input.statement)
    )
      throw historyError('DEFINITION', 503);
    if (signal?.aborted) throw historyError('UNAVAILABLE', 503);
    let job: Job | undefined,
      expired = false,
      cancelRequested = false;
    const cancel = () => {
      expired = true;
      if (job && !cancelRequested) {
        cancelRequested = true;
        void job.cancel().catch(() => undefined);
      }
    };
    const request: Query = {
      query: input.statement,
      params: normalizeWarehouseParameters(input.params, input.types),
      types: input.types,
      useLegacySql: false,
      dryRun,
      useQueryCache: false,
      maximumBytesBilled: String(options.CSV_MEMBERSHIP_MAX_BYTES_BILLED),
      jobTimeoutMs: options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS,
      location: csvMembershipWarehouse.location,
      labels: {
        application: 'pos-rewrite',
        resource: definition ? 'csv-membership-publication' : 'csv-membership-history',
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancel();
        reject(historyError('UNAVAILABLE', 503));
      };
      timer = setTimeout(abort, options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const work = (async () => {
      client ??= clientFactory();
      [job] = await client.createQueryJob(request);
      if (expired) {
        cancel();
        throw historyError('UNAVAILABLE', 503);
      }
      if (dryRun) {
        const metadata = z
          .object({
            statistics: z.object({
              query: z.object({
                totalBytesProcessed: count,
                referencedTables: z
                  .array(
                    z.object({
                      projectId: z.literal(csvMembershipWarehouse.project),
                      datasetId: z.literal(csvMembershipWarehouse.dataset),
                      tableId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
                    }),
                  )
                  .min(1)
                  .max(100),
                referencedRoutines: z.array(z.unknown()).max(0).optional(),
              }),
            }),
          })
          .safeParse(job.metadata);
        if (!metadata.success) throw historyError('ESTIMATE_UNAVAILABLE', 503);
        return BigInt(metadata.data.statistics.query.totalBytesProcessed);
      }
      const [rows, next, response] = await job.getQueryResults({
        autoPaginate: false,
        maxResults: 2,
        maxApiCalls: 1,
        timeoutMs: options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS,
        wrapIntegers: true,
      });
      if (
        next ||
        (response &&
          (('pageToken' in response && response.pageToken) || response.jobComplete === false))
      )
        throw historyError('INCOMPLETE');
      return rows as unknown;
    })();
    try {
      return await Promise.race([deadline, work]);
    } catch {
      cancel();
      throw historyError('UNAVAILABLE', 503);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async estimate(input, signal) {
      const result = await run(input, true, signal);
      if (typeof result !== 'bigint') throw historyError('ESTIMATE_UNAVAILABLE', 503);
      return result;
    },
    execute(input, signal) {
      return run(input, false, signal);
    },
  };
}
const actual = z
  .object({
    orders: count,
    uniqueOrders: count,
    selectedOrders: count,
    uniqueSelectedOrders: count,
    lines: count,
    uniqueLines: count,
    invalidOrders: count,
    latestTies: count,
    foreignLines: count,
  })
  .strict();
/** No async reader belongs inside a writer transaction. Call read/prefetch
 * BEFORE source dispatch; bridge.ts supplies the replay-only handoff. */
export function csvMembershipBigQueryHistory(
  suppliedOptions: CsvMembershipBigQueryOptions,
  authority: { historyKey: string; publicationKey: string; memberProductIds: readonly string[] },
  dependencies: {
    query?: CsvMembershipHistoryQueryPort;
    clientFactory?: () => BigQuery;
    clock?: () => number;
  } = {},
): CsvMembershipHistoryPort {
  const parsedOptions = csvMembershipBigQueryOptionsSchema.safeParse(suppliedOptions);
  if (!parsedOptions.success) throw historyError('CONFIGURATION', 503);
  const options = Object.freeze(parsedOptions.data),
    clock = dependencies.clock ?? Date.now;
  const memberIds = [...authority.memberProductIds],
    { historyKey, publicationKey } = authority;
  validKeys(historyKey, publicationKey);
  if (
    historyKey === publicationKey ||
    !memberIds.length ||
    memberIds.length > 100 ||
    !z.array(sourceId).safeParse(memberIds).success ||
    new Set(memberIds).size !== memberIds.length
  )
    throw historyError('CONFIGURATION', 503);
  const query = dependencies.query ?? csvMembershipHistorySdk(options, dependencies.clientFactory);
  return {
    async read(input) {
      qualified(options);
      const scope = validatedScope(input);
      if (!sourceId.safeParse(scope.customerId).success) throw historyError('INVALID');
      const started = clock(),
        sourceAt = csvMembershipSourceInstant(scope.asOf, options.CSV_MEMBERSHIP_SOURCE_TIMEZONE!);
      if (
        !Number.isSafeInteger(started) ||
        sourceAt > started ||
        started - sourceAt > options.CSV_MEMBERSHIP_MAX_LAG_SECONDS * 1000
      )
        throw historyError('STALE');
      const request = csvMembershipHistorySql(options, scope),
        abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(historyError('UNAVAILABLE', 503));
        }, options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS);
      });
      let raw: unknown;
      try {
        raw = await Promise.race([
          deadline,
          (async () => {
            const estimate = await query.estimate(request, abort.signal);
            if (estimate < 0n || estimate > BigInt(options.CSV_MEMBERSHIP_MAX_BYTES_BILLED))
              throw historyError('BUDGET', 503);
            if (abort.signal.aborted) throw historyError('UNAVAILABLE', 503);
            const result = await query.execute(request, abort.signal);
            if (abort.signal.aborted) throw historyError('UNAVAILABLE', 503);
            return result;
          })(),
        ]);
      } catch (error) {
        if (
          error instanceof AppError &&
          /^ORDER_IMPORT_MEMBERSHIP_HISTORY_[A-Z_]+$/.test(error.code)
        )
          throw error;
        throw historyError('UNAVAILABLE', 503);
      } finally {
        clearTimeout(timer);
      }
      return qualifyCsvMembershipWarehouseSnapshot(
        raw,
        scope,
        options,
        { historyKey, publicationKey, memberProductIds: memberIds },
        { started, now: clock() },
      );
    },
  };
}

/** Pure verifier shared by the production reader and source publication sealer.
 * Every warehouse row remains independently checked; this performs no I/O. */
export function qualifyCsvMembershipWarehouseSnapshot(
  raw: unknown,
  input: CsvMembershipHistoryRequest,
  suppliedOptions: CsvMembershipBigQueryOptions,
  authority: { historyKey: string; publicationKey: string; memberProductIds: readonly string[] },
  timing: { started: number; now: number },
): QualifiedCsvMembershipHistory {
  const parsedOptions = csvMembershipBigQueryOptionsSchema.safeParse(suppliedOptions);
  if (!parsedOptions.success) throw historyError('CONFIGURATION', 503);
  const options = parsedOptions.data,
    scope = validatedScope(input),
    started = timing.started,
    sourceAt = csvMembershipSourceInstant(scope.asOf, options.CSV_MEMBERSHIP_SOURCE_TIMEZONE ?? ''),
    { historyKey, publicationKey } = authority,
    memberIds = [...authority.memberProductIds];
  validKeys(historyKey, publicationKey);
  if (
    historyKey === publicationKey ||
    !sourceId.safeParse(scope.customerId).success ||
    !memberIds.length ||
    !z.array(sourceId).max(100).safeParse(memberIds).success ||
    new Set(memberIds).size !== memberIds.length ||
    !Number.isSafeInteger(started)
  )
    throw historyError('CONFIGURATION', 503);
  const envelope = z
    .object({
      publications: z.array(csvMembershipPublicationSchema).max(2),
      actual,
      orders: z.array(order).max(options.CSV_MEMBERSHIP_MAX_ORDERS),
      lines: z.array(line).max(options.CSV_MEMBERSHIP_MAX_LINES),
    })
    .strict();
  const wire = z
    .array(z.object({ document: z.string().max(2000000) }).strict())
    .length(1)
    .safeParse(raw);
  if (!wire.success || Buffer.byteLength(wire.data[0]!.document) > 2000000)
    throw historyError('INVALID');
  let decoded: unknown;
  try {
    decoded = JSON.parse(wire.data[0]!.document) as unknown;
  } catch {
    throw historyError('INVALID');
  }
  const shallow = z
    .object({ publications: z.unknown(), orders: z.unknown(), lines: z.unknown() })
    .safeParse(decoded);
  if (
    !shallow.success ||
    !Array.isArray(shallow.data.publications) ||
    shallow.data.publications.length > 2 ||
    !Array.isArray(shallow.data.orders) ||
    shallow.data.orders.length > options.CSV_MEMBERSHIP_MAX_ORDERS ||
    !Array.isArray(shallow.data.lines) ||
    shallow.data.lines.length > options.CSV_MEMBERSHIP_MAX_LINES
  )
    throw historyError('INVALID');
  const parsed = envelope.safeParse(decoded);
  if (!parsed.success) throw historyError('INVALID');
  const result = parsed.data;
  if (result.publications.length === 0) throw historyError('PUBLICATION_REQUIRED', 503);
  if (result.publications.length !== 1) throw historyError('INVALID');
  const p = result.publications[0]!,
    { signature, ...publicationBody } = p,
    now = timing.now,
    a = result.actual;
  if (!Number.isSafeInteger(now) || now <= 0) throw historyError('INVALID');
  const snapshot = Temporal.Instant.from(p.sourceSnapshotAt).epochNanoseconds,
    cdc = Temporal.Instant.from(p.sourceCdcThrough).epochNanoseconds,
    published = Temporal.Instant.from(p.publishedAt).epochNanoseconds;
  if (
    !equalImportHash(signature, csvMembershipPublicationHash(publicationBody, publicationKey)) ||
    p.customerId !== scope.customerId ||
    p.asOf !== scope.asOf ||
    p.cutoff !== scope.cutoff ||
    p.sourceTimeZone !== options.CSV_MEMBERSHIP_SOURCE_TIMEZONE ||
    snapshot !== BigInt(sourceAt) * 1000000n ||
    cdc < snapshot ||
    published < cdc ||
    published > BigInt(now) * 1000000n ||
    now < started ||
    now - started > options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS ||
    now - sourceAt > options.CSV_MEMBERSHIP_MAX_LAG_SECONDS * 1000
  )
    throw historyError('INVALID');
  if (
    p.sourceOrderCount !== p.warehouseOrderCount ||
    p.sourceOrderCount !== a.orders ||
    a.orders !== a.uniqueOrders ||
    p.sourceSelectedOrderCount !== p.warehouseSelectedOrderCount ||
    p.sourceSelectedOrderCount !== a.selectedOrders ||
    a.selectedOrders !== a.uniqueSelectedOrders ||
    BigInt(a.selectedOrders) !== BigInt(result.orders.length) ||
    p.sourceLineCount !== p.warehouseLineCount ||
    p.sourceLineCount !== a.lines ||
    a.lines !== a.uniqueLines ||
    BigInt(a.lines) !== BigInt(result.lines.length) ||
    BigInt(a.selectedOrders) > BigInt(a.orders) ||
    (a.orders === '0' ? a.selectedOrders !== '0' || a.lines !== '0' : result.orders.length === 0) ||
    a.invalidOrders !== '0' ||
    a.foreignLines !== '0' ||
    (a.orders === '0' ? a.latestTies !== '0' : a.latestTies !== '1')
  )
    throw historyError('INCOMPLETE');
  const headerIds = new Set(result.orders.map((entry) => entry.id)),
    lineIds = new Set(result.lines.map((entry) => entry.lineId));
  if (
    headerIds.size !== result.orders.length ||
    lineIds.size !== result.lines.length ||
    result.lines.some((entry) => !headerIds.has(entry.orderId))
  )
    throw historyError('INVALID');
  const linesByOrder = new Map<string, typeof result.lines>();
  for (const entry of result.lines) {
    const entries = linesByOrder.get(entry.orderId) ?? [];
    entries.push(entry);
    linesByOrder.set(entry.orderId, entries);
  }
  const orders = result.orders.map((entry) => ({
    ...entry,
    lines: (linesByOrder.get(entry.id) ?? [])
      .sort((left, right) => (BigInt(left.lineId) < BigInt(right.lineId) ? -1 : 1))
      .map(({ orderId: _orderId, ...row }) => row),
  }));
  if (
    orders.some((entry, index) => index > 0 && orders[index - 1]!.createdAt <= entry.createdAt) ||
    (orders.length > 1 && orders.some((entry) => entry.createdAt <= scope.cutoff))
  )
    throw historyError('AMBIGUOUS');
  const selection: CsvMembershipSelection = {
    lastDeliveredOrder: orders[0] ?? null,
    recentDeliveredOrders: orders.filter((entry) => entry.createdAt > scope.cutoff),
  };
  const digest = csvMembershipSelectionHash(scope, selection);
  if (p.sourceHistoryHash !== p.warehouseHistoryHash || p.sourceHistoryHash !== digest)
    throw historyError('INCOMPLETE');
  const body = {
    scope,
    reader: 'bigquery' as const,
    generationId: p.generationId,
    complete: true as const,
    fetchedAt: now,
    ...selection,
  };
  const document: QualifiedCsvMembershipHistory = {
    ...body,
    signature: csvMembershipHistoryHash(body, historyKey),
  };
  return assertQualifiedCsvMembershipHistory(document, scope, historyKey, memberIds, now);
}
