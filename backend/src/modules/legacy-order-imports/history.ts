import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { warehouseService, warehouseScalar } from '../warehouse.js';
import { warehouseView } from '../operational-reports/report-inputs.js';
import type { LegacyImportJob } from './schema.js';

export const orderImportHistoryContract = 'pos-order-import-history-v1';
const optionalView = z.preprocess((value) => (value === '' ? undefined : value), warehouseView);
export function readLegacyOrderImportHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ORDER_IMPORT_HISTORY_CONTRACT: z.string().optional(),
      BQ_ORDER_IMPORT_JOBS_VIEW: optionalView,
      BQ_ORDER_IMPORT_RESULTS_VIEW: optionalView,
      BQ_ORDER_IMPORT_PUBLICATIONS_VIEW: optionalView,
    })
    .parse(env);
}
export type LegacyOrderImportHistoryOptions = ReturnType<
  typeof readLegacyOrderImportHistoryOptions
>;
export type LegacyOrderImportHistoryAnchor = {
  job: Pick<
    LegacyImportJob,
    | 'sequence'
    | 'id'
    | 'actorId'
    | 'requestHash'
    | 'kind'
    | 'state'
    | 'totalOrders'
    | 'importedOrders'
    | 'failedOrders'
    | 'cancelledOrders'
    | 'errorCode'
    | 'createdAt'
    | 'updatedAt'
    | 'completedAt'
  >;
  scopes: readonly { storeId: string; counterId: string }[];
};
type Warehouse = Pick<ReturnType<typeof warehouseService>, 'queryReport'>;
const id = identifier.refine((value) => BigInt(value) <= 9223372036854775807n),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  code = z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable();
const sqlTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/)
  .refine((value) => {
    try {
      return (
        Temporal.Instant.from(value.replace(' ', 'T') + 'Z').epochMilliseconds >= -30610224000000
      );
    } catch {
      return false;
    }
  });
const businessDate = z.iso.date().refine((value) => {
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
});
const publicationTimestamp = z.iso.datetime({ offset: true }).refine((value) => {
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
});
const count = z.number().int().min(0).max(50000),
  scopeSchema = z.object({ storeId: id, counterId: id }).strict();
const jobDtoSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    state: z.enum(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']),
    totalOrders: count.min(1),
    importedOrders: count,
    failedOrders: count,
    cancelledOrders: count,
    errorCode: code,
    createdAt: sqlTimestamp,
    updatedAt: sqlTimestamp,
    completedAt: sqlTimestamp,
  })
  .strict();
export const legacyOrderImportHistoricalResult = z
  .object({
    sequence: z.number().int().min(1).max(50000),
    firstRow: z.number().int().min(2).max(50001),
    operationId: z.uuid(),
    storeId: id,
    counterId: id,
    state: z.enum(['IMPORTED', 'FAILED', 'CANCELLED']),
    orderId: id.nullable(),
    receiptId: z.uuid().nullable(),
    businessDate: businessDate.nullable(),
    errorCode: code,
    updatedAt: sqlTimestamp,
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.state === 'IMPORTED'
        ? row.orderId === null ||
          row.receiptId === null ||
          row.businessDate === null ||
          row.errorCode !== null
        : row.orderId !== null ||
          row.receiptId !== null ||
          row.businessDate !== null ||
          (row.state === 'FAILED'
            ? !/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/.test(row.errorCode ?? '')
            : row.errorCode !== null)
    )
      context.addIssue({ code: 'custom', message: 'Terminal import result is inconsistent.' });
  });
export type LegacyOrderImportHistoricalResult = z.infer<typeof legacyOrderImportHistoricalResult>;
export type LegacyOrderImportHistoricalJob = z.infer<typeof jobDtoSchema>;
const anchorSchema = z
  .object({
    job: jobDtoSchema
      .extend({
        sequence: z.bigint().min(1n).max(18446744073709551615n),
        actorId: id,
        requestHash: digest,
      })
      .strip(),
    scopes: z.array(scopeSchema).min(1).max(100),
  })
  .strict();
const invalid = () =>
  new AppError(
    503,
    'ORDER_IMPORT_HISTORY_INVALID',
    'The historical import publication is incomplete or inconsistent.',
  );
const required = () =>
  new AppError(
    503,
    'ORDER_IMPORT_HISTORY_REQUIRED',
    'Historical import results require the complete published BigQuery reader.',
  );
function time(value: string) {
  return Temporal.Instant.from(value.replace(' ', 'T') + 'Z');
}
function canonicalTime(value: string) {
  return time(value).toString({ fractionalSecondDigits: 3 }).replace('T', ' ').slice(0, -1);
}
function scopesSorted(scopes: readonly z.infer<typeof scopeSchema>[]) {
  return [...scopes].sort((a, b) =>
    BigInt(a.storeId) < BigInt(b.storeId)
      ? -1
      : BigInt(a.storeId) > BigInt(b.storeId)
        ? 1
        : BigInt(a.counterId) < BigInt(b.counterId)
          ? -1
          : BigInt(a.counterId) > BigInt(b.counterId)
            ? 1
            : 0,
  );
}
function parseAnchor(raw: LegacyOrderImportHistoryAnchor) {
  const parsed = anchorSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const value = parsed.data,
    j = value.job;
  if (
    new Set(value.scopes.map((scope) => scope.storeId)).size !== value.scopes.length ||
    j.importedOrders + j.failedOrders + j.cancelledOrders !== j.totalOrders ||
    Temporal.Instant.compare(time(j.createdAt), time(j.completedAt)) > 0 ||
    canonicalTime(j.updatedAt) !== canonicalTime(j.completedAt) ||
    (j.state === 'COMPLETED' &&
      (j.importedOrders !== j.totalOrders || j.failedOrders !== 0 || j.cancelledOrders !== 0)) ||
    (j.state === 'FAILED' &&
      (j.failedOrders !== j.totalOrders || j.importedOrders !== 0 || j.cancelledOrders !== 0)) ||
    (j.state === 'PARTIAL' &&
      (j.failedOrders === 0 || j.importedOrders === 0 || j.cancelledOrders !== 0)) ||
    (j.state === 'CANCELLED' && j.cancelledOrders === 0)
  )
    throw invalid();
  return {
    ...value,
    scopes: scopesSorted(value.scopes),
    job: {
      ...j,
      createdAt: canonicalTime(j.createdAt),
      updatedAt: canonicalTime(j.updatedAt),
      completedAt: canonicalTime(j.completedAt),
    },
  };
}
type Anchor = ReturnType<typeof parseAnchor>;
function jobTuple(j: Anchor['job']) {
  return [
    'pos-order-import-job-v1',
    j.id,
    j.sequence.toString(),
    j.actorId,
    j.requestHash,
    j.kind,
    j.state,
    String(j.totalOrders),
    String(j.importedOrders),
    String(j.failedOrders),
    String(j.cancelledOrders),
    j.errorCode,
    j.createdAt,
    j.updatedAt,
    j.completedAt,
  ];
}
function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function rowTuple(anchor: Anchor, row: LegacyOrderImportHistoricalResult) {
  const j = anchor.job;
  return [
    'pos-order-import-result-v1',
    j.id,
    j.actorId,
    j.requestHash,
    j.createdAt,
    j.updatedAt,
    String(row.sequence),
    String(row.firstRow),
    row.operationId,
    row.storeId,
    row.counterId,
    row.state,
    row.orderId,
    row.receiptId,
    row.businessDate,
    row.errorCode,
    canonicalTime(row.updatedAt),
  ];
}
/** Canonical public-only publisher/test digest; never accepts encrypted payloads. */
export function legacyOrderImportHistoryHashes(
  raw: LegacyOrderImportHistoryAnchor,
  rows: readonly LegacyOrderImportHistoricalResult[],
) {
  const anchor = parseAnchor(raw);
  if (rows.length > 50000) throw invalid();
  const values = rows
    .map((row) => legacyOrderImportHistoricalResult.parse(row))
    .sort((a, b) => a.sequence - b.sequence);
  const rowHashes = values.map((row) => sha(JSON.stringify(rowTuple(anchor, row))));
  return {
    jobHash: sha(JSON.stringify(jobTuple(anchor.job))),
    resultHash: sha(rowHashes.join('\n')),
    rowHashes,
  };
}
const stamp = (column: string) => `FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%E3S',${column},'UTC')`;
const rowFields = (alias: string) =>
  `${alias}.sequence,${alias}.first_row AS firstRow,${alias}.operation_id AS operationId,${alias}.store_id AS storeId,${alias}.counter_id AS counterId,${alias}.state,${alias}.order_id AS orderId,${alias}.receipt_id AS receiptId,${alias}.business_date AS businessDate,${alias}.error_code AS errorCode,${stamp(alias + '.updated_at')} AS updatedAt`;
function canonicalJobSql(a: string) {
  return `TO_JSON_STRING(ARRAY<STRING>['pos-order-import-job-v1',${a}.job_id,${a}.job_sequence,${a}.actor_id,${a}.request_hash,${a}.kind,${a}.state,CAST(${a}.total_orders AS STRING),CAST(${a}.imported_orders AS STRING),CAST(${a}.failed_orders AS STRING),CAST(${a}.cancelled_orders AS STRING),${a}.error_code,${stamp(a + '.created_at')},${stamp(a + '.updated_at')},${stamp(a + '.completed_at')}])`;
}
function canonicalRowSql(a: string) {
  return `TO_JSON_STRING(ARRAY<STRING>['pos-order-import-result-v1',${a}.job_id,${a}.actor_id,${a}.request_hash,${stamp(a + '.job_created_at')},${stamp(a + '.job_updated_at')},CAST(${a}.sequence AS STRING),CAST(${a}.first_row AS STRING),${a}.operation_id,${a}.store_id,${a}.counter_id,${a}.state,${a}.order_id,${a}.receipt_id,${a}.business_date,${a}.error_code,${stamp(a + '.updated_at')}])`;
}
const uuidSql = (column: string) =>
  `(REGEXP_CONTAINS(LOWER(${column}),r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') OR LOWER(${column}) IN('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff'))`;
const idSql = (column: string) =>
  `(${column}=CAST(SAFE_CAST(${column} AS INT64) AS STRING) AND SAFE_CAST(${column} AS INT64)>0)`;
/** Only configured curated views. Generation/identity values always stay bound. */
export function legacyOrderImportHistorySql(options: LegacyOrderImportHistoryOptions) {
  const jobs = warehouseView.parse(options.BQ_ORDER_IMPORT_JOBS_VIEW),
    rows = warehouseView.parse(options.BQ_ORDER_IMPORT_RESULTS_VIEW),
    publications = warehouseView.parse(options.BQ_ORDER_IMPORT_PUBLICATIONS_VIEW);
  if (!jobs || !rows || !publications) throw required();
  const valid = `r.actor_id=@actorId AND r.request_hash=@requestHash AND r.job_created_at=@createdAt AND r.job_updated_at=@updatedAt AND r.sequence BETWEEN 1 AND @total AND r.first_row BETWEEN 2 AND 50001 AND ${uuidSql('r.operation_id')} AND ${idSql('r.store_id')} AND ${idSql('r.counter_id')} AND r.updated_at>=@createdAt AND r.updated_at<=@completedAt AND ((r.state='IMPORTED' AND ${idSql('r.order_id')} AND ${uuidSql('r.receipt_id')} AND r.business_date=CAST(SAFE_CAST(r.business_date AS DATE) AS STRING) AND r.error_code IS NULL) OR (r.state='FAILED' AND r.order_id IS NULL AND r.receipt_id IS NULL AND r.business_date IS NULL AND REGEXP_CONTAINS(r.error_code,r'^ORDER_IMPORT_[A-Z0-9_]{1,45}$')) OR (r.state='CANCELLED' AND r.order_id IS NULL AND r.receipt_id IS NULL AND r.business_date IS NULL AND r.error_code IS NULL))`;
  return `WITH publications AS (
 SELECT generation_id,contract_version,job_id,actor_id,request_hash,source_complete,source_snapshot_id,source_snapshot_at,source_cdc_watermark,published_at,source_rows,warehouse_rows,source_job_hash,warehouse_job_hash,source_result_hash,warehouse_result_hash FROM \`${publications}\` WHERE contract_version=@contract AND job_id=@jobId LIMIT 2
), job_versions AS (
 SELECT j.generation_id,j.job_id,j.job_sequence,j.actor_id,j.request_hash,j.kind,j.state,j.total_orders,j.imported_orders,j.failed_orders,j.cancelled_orders,j.error_code,j.created_at,j.updated_at,j.completed_at,LOWER(TO_HEX(SHA256(${canonicalJobSql('j')}))) AS computed_hash FROM \`${jobs}\` j WHERE j.job_id=@jobId AND j.generation_id IN(SELECT generation_id FROM publications)
), result_versions AS (
 SELECT r.generation_id,r.job_id,r.actor_id,r.request_hash,r.job_created_at,r.job_updated_at,r.sequence,r.first_row,r.operation_id,r.store_id,r.counter_id,r.state,r.order_id,r.receipt_id,r.business_date,r.error_code,r.updated_at,LOWER(TO_HEX(SHA256(${canonicalRowSql('r')}))) AS row_hash FROM \`${rows}\` r WHERE r.job_id=@jobId AND r.generation_id IN(SELECT generation_id FROM publications)
), stats AS (
 SELECT CAST(COUNT(*) AS STRING) AS recordCount,CAST(COUNT(DISTINCT sequence) AS STRING) AS distinctSequences,
 CAST(COUNT(DISTINCT first_row) AS STRING) AS distinctFirstRows,CAST(COUNT(DISTINCT operation_id) AS STRING) AS distinctOperations,
 CAST(COUNT(DISTINCT order_id) AS STRING) AS distinctOrders,CAST(COUNT(DISTINCT receipt_id) AS STRING) AS distinctReceipts,
 CAST(MIN(sequence) AS STRING) AS minimumSequence,CAST(MAX(sequence) AS STRING) AS maximumSequence,
 CAST(COUNTIF(state='IMPORTED') AS STRING) AS importedCount,CAST(COUNTIF(state='FAILED') AS STRING) AS failedCount,CAST(COUNTIF(state='CANCELLED') AS STRING) AS cancelledCount,
 CAST(COUNTIF(NOT IFNULL(${valid},FALSE)) AS STRING) AS invalidCount,
 LOWER(TO_HEX(SHA256(IFNULL(STRING_AGG(row_hash,'\\n' ORDER BY sequence),'')))) AS computedHash FROM result_versions r
) SELECT TO_JSON_STRING(STRUCT(
 ARRAY(SELECT AS STRUCT generation_id AS generationId,contract_version AS contract,job_id AS jobId,actor_id AS actorId,request_hash AS requestHash,source_complete AS sourceComplete,source_snapshot_id AS sourceSnapshotId,
 FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_snapshot_at,'UTC') AS sourceSnapshotAt,FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_cdc_watermark,'UTC') AS sourceCdcWatermark,FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',published_at,'UTC') AS publishedAt,
 CAST(source_rows AS STRING) AS sourceRows,CAST(warehouse_rows AS STRING) AS warehouseRows,source_job_hash AS sourceJobHash,warehouse_job_hash AS warehouseJobHash,source_result_hash AS sourceResultHash,warehouse_result_hash AS warehouseResultHash FROM publications) AS publications,
 ARRAY(SELECT AS STRUCT generation_id AS generationId,job_id AS id,job_sequence AS sequence,actor_id AS actorId,request_hash AS requestHash,kind,state,total_orders AS totalOrders,imported_orders AS importedOrders,failed_orders AS failedOrders,cancelled_orders AS cancelledOrders,error_code AS errorCode,
 ${stamp('created_at')} AS createdAt,${stamp('updated_at')} AS updatedAt,${stamp('completed_at')} AS completedAt,computed_hash AS computedHash FROM job_versions LIMIT 2) AS jobs,
 (SELECT AS STRUCT * FROM stats) AS stats,
 ARRAY(SELECT DISTINCT AS STRUCT store_id AS storeId,counter_id AS counterId FROM result_versions ORDER BY storeId,counterId LIMIT 101) AS scopes,
 ARRAY(SELECT AS STRUCT ${rowFields('r')},r.row_hash AS rowHash FROM result_versions r WHERE r.sequence>@after ORDER BY r.sequence ASC LIMIT @limit) AS page
 )) AS snapshot`;
}
const numeric = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(100000));
const publicationSchema = z
  .object({
    generationId: z.uuid(),
    contract: z.literal(orderImportHistoryContract),
    jobId: z.uuid(),
    actorId: id,
    requestHash: digest,
    sourceComplete: z.literal(true),
    sourceSnapshotId: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    sourceSnapshotAt: publicationTimestamp,
    sourceCdcWatermark: publicationTimestamp,
    publishedAt: publicationTimestamp,
    sourceRows: numeric,
    warehouseRows: numeric,
    sourceJobHash: digest,
    warehouseJobHash: digest,
    sourceResultHash: digest,
    warehouseResultHash: digest,
  })
  .strict();
const snapshotSchema = z
  .object({
    publications: z.array(publicationSchema).length(1),
    jobs: z
      .array(
        jobDtoSchema.extend({
          generationId: z.uuid(),
          sequence: z.string().regex(/^[1-9]\d{0,19}$/),
          actorId: id,
          requestHash: digest,
          computedHash: digest,
        }),
      )
      .length(1),
    stats: z
      .object({
        recordCount: numeric,
        distinctSequences: numeric,
        distinctFirstRows: numeric,
        distinctOperations: numeric,
        distinctOrders: numeric,
        distinctReceipts: numeric,
        minimumSequence: numeric.nullable(),
        maximumSequence: numeric.nullable(),
        importedCount: numeric,
        failedCount: numeric,
        cancelledCount: numeric,
        invalidCount: numeric,
        computedHash: digest,
      })
      .strict(),
    scopes: z.array(scopeSchema).min(1).max(100),
    page: z.array(legacyOrderImportHistoricalResult.safeExtend({ rowHash: digest })).max(100),
  })
  .strict();
function readSnapshot(raw: unknown) {
  try {
    const rows = z
      .array(z.object({ snapshot: z.preprocess(warehouseScalar, z.string().max(150000)) }).strict())
      .length(1)
      .parse(raw);
    return snapshotSchema.parse(JSON.parse(rows[0]!.snapshot) as unknown);
  } catch {
    throw invalid();
  }
}
export function legacyOrderImportHistory(
  config: Config,
  options: LegacyOrderImportHistoryOptions = readLegacyOrderImportHistoryOptions(),
  warehouse: Warehouse = warehouseService(config),
  clock: () => number = Date.now,
) {
  async function read(raw: LegacyOrderImportHistoryAnchor, after: number, limit: number) {
    const anchor = parseAnchor(raw),
      j = anchor.job;
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      after > 50000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new AppError(400, 'ORDER_IMPORT_PAGE_INVALID', 'Use a valid import result page.');
    if (time(j.completedAt).epochMilliseconds >= clock() - 86400000) throw invalid();
    if (
      options.ORDER_IMPORT_HISTORY_CONTRACT !== orderImportHistoryContract ||
      !options.BQ_ORDER_IMPORT_JOBS_VIEW ||
      !options.BQ_ORDER_IMPORT_RESULTS_VIEW ||
      !options.BQ_ORDER_IMPORT_PUBLICATIONS_VIEW
    )
      throw required();
    let rawResult: unknown;
    try {
      rawResult = await warehouse.queryReport(
        legacyOrderImportHistorySql(options),
        {
          contract: orderImportHistoryContract,
          jobId: j.id,
          actorId: j.actorId,
          requestHash: j.requestHash,
          createdAt: j.createdAt.replace(' ', 'T') + 'Z',
          updatedAt: j.updatedAt.replace(' ', 'T') + 'Z',
          completedAt: j.completedAt.replace(' ', 'T') + 'Z',
          total: j.totalOrders,
          after,
          limit,
        },
        {
          contract: 'STRING',
          jobId: 'STRING',
          actorId: 'STRING',
          requestHash: 'STRING',
          createdAt: 'TIMESTAMP',
          updatedAt: 'TIMESTAMP',
          completedAt: 'TIMESTAMP',
          total: 'INT64',
          after: 'INT64',
          limit: 'INT64',
        },
        'order-import-history',
      );
    } catch {
      throw new AppError(
        503,
        'ORDER_IMPORT_HISTORY_UNAVAILABLE',
        'Historical import results are temporarily unavailable.',
      );
    }
    const value = readSnapshot(rawResult),
      p = value.publications[0]!,
      v = value.jobs[0]!,
      s = value.stats,
      jobHash = sha(JSON.stringify(jobTuple(j))),
      now = Temporal.Instant.fromEpochMilliseconds(clock()),
      snapshotAt = Temporal.Instant.from(p.sourceSnapshotAt),
      watermark = Temporal.Instant.from(p.sourceCdcWatermark),
      published = Temporal.Instant.from(p.publishedAt);
    const {
      generationId: _generation,
      sequence: _sequence,
      actorId: _actor,
      requestHash: _request,
      computedHash: _hash,
      ...job
    } = v;
    if (
      p.jobId !== j.id ||
      p.actorId !== j.actorId ||
      p.requestHash !== j.requestHash ||
      p.sourceRows !== j.totalOrders ||
      p.warehouseRows !== j.totalOrders ||
      p.sourceJobHash !== jobHash ||
      p.warehouseJobHash !== jobHash ||
      v.computedHash !== jobHash ||
      v.generationId !== p.generationId ||
      v.sequence !== j.sequence.toString() ||
      v.actorId !== j.actorId ||
      v.requestHash !== j.requestHash ||
      JSON.stringify(jobTuple({ ...j, ...job })) !== JSON.stringify(jobTuple(j)) ||
      p.sourceResultHash !== p.warehouseResultHash ||
      p.sourceResultHash !== s.computedHash ||
      s.recordCount !== j.totalOrders ||
      s.distinctSequences !== j.totalOrders ||
      s.distinctFirstRows !== j.totalOrders ||
      s.distinctOperations !== j.totalOrders ||
      s.distinctOrders !== j.importedOrders ||
      s.distinctReceipts !== j.importedOrders ||
      s.minimumSequence !== 1 ||
      s.maximumSequence !== j.totalOrders ||
      s.importedCount !== j.importedOrders ||
      s.failedCount !== j.failedOrders ||
      s.cancelledCount !== j.cancelledOrders ||
      s.invalidCount !== 0 ||
      JSON.stringify(scopesSorted(value.scopes)) !== JSON.stringify(anchor.scopes) ||
      new Set(value.scopes.map((scope) => scope.storeId)).size !== value.scopes.length ||
      Temporal.Instant.compare(snapshotAt, time(j.completedAt)) < 0 ||
      Temporal.Instant.compare(watermark, snapshotAt) < 0 ||
      Temporal.Instant.compare(published, watermark) < 0 ||
      Temporal.Instant.compare(published, now.add({ seconds: 5 })) > 0 ||
      value.page.length !== Math.max(0, Math.min(limit, j.totalOrders - after))
    )
      throw invalid();
    for (let index = 0; index < value.page.length; index++) {
      const row = value.page[index]!;
      if (
        row.rowHash !== sha(JSON.stringify(rowTuple(anchor, row))) ||
        row.sequence !== after + index + 1 ||
        !anchor.scopes.some(
          (scope) => scope.storeId === row.storeId && scope.counterId === row.counterId,
        ) ||
        Temporal.Instant.compare(time(row.updatedAt), time(j.createdAt)) < 0 ||
        Temporal.Instant.compare(time(row.updatedAt), time(j.completedAt)) > 0
      )
        throw invalid();
    }
    return {
      job: jobDtoSchema.parse(job),
      page: value.page.map(({ rowHash: _rowHash, ...row }) => row),
    };
  }
  return {
    async detail(anchor: LegacyOrderImportHistoryAnchor) {
      return (await read(anchor, 50000, 1)).job;
    },
    async results(anchor: LegacyOrderImportHistoryAnchor, after = 0, limit = 50) {
      return (await read(anchor, after, limit)).page;
    },
  };
}
