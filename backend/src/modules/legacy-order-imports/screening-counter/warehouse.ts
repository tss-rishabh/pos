import { z } from 'zod';
import type { Config } from '../../../config.js';
import { warehouseService } from '../../warehouse.js';
import {
  counterCaptureSchema,
  counterCount,
  counterError,
  counterHash,
  counterRowSchema,
  counterRowsHash,
  type CounterCapture,
} from './contracts.js';
import type { ScreeningCounterWarehouse } from './publisher.js';
const table = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/);
const contract = 'pos-screening-counter-bq-candidate-v1';
export interface ScreeningCounterWarehouseOptions {
  contract?: typeof contract;
  publicationsView?: string;
  rowsView?: string;
}
export function readScreeningCounterWarehouseOptions(
  env: NodeJS.ProcessEnv = process.env,
): ScreeningCounterWarehouseOptions {
  if (env.POS_SCREENING_COUNTER_BQ_CONTRACT && env.POS_SCREENING_COUNTER_BQ_CONTRACT !== contract)
    throw counterError('WAREHOUSE_CONFIGURATION');
  const publicationsView = env.BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW,
    rowsView = env.BQ_SCREENING_COUNTER_ROWS_VIEW;
  for (const value of [publicationsView, rowsView])
    if (value && !table.safeParse(value).success) throw counterError('WAREHOUSE_CONFIGURATION');
  return {
    ...(env.POS_SCREENING_COUNTER_BQ_CONTRACT === contract ? { contract } : {}),
    ...(publicationsView ? { publicationsView } : {}),
    ...(rowsView ? { rowsView } : {}),
  };
}
/** Customer-sharded, generation-bound independently published BQ marker rows.
 * Runtime has no native source connection; only the independent publisher may
 * initialize the operational projection after comparing the complete cohort. */
export function screeningCounterWarehouse(
  config: Config,
  options: ScreeningCounterWarehouseOptions,
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = Date.now,
): ScreeningCounterWarehouse {
  return {
    async read(input, signal) {
      const capture = counterCaptureSchema.parse(input);
      if (
        !Number.isSafeInteger(config.BIGQUERY_MAX_BYTES_BILLED) ||
        config.BIGQUERY_MAX_BYTES_BILLED < 1 ||
        config.BIGQUERY_MAX_BYTES_BILLED > 1000000000
      )
        throw counterError('WAREHOUSE_BUDGET_CONFIGURATION');
      if (
        options.contract !== contract ||
        !options.publicationsView ||
        !options.rowsView ||
        !table.safeParse(options.publicationsView).success ||
        !table.safeParse(options.rowsView).success
      )
        throw counterError('WAREHOUSE_REQUIRED');
      if (signal?.aborted) throw counterError('WAREHOUSE_UNAVAILABLE');
      const now = clock();
      if (now < capture.finishedAt || now - capture.capturedAt > 60000)
        throw counterError('SOURCE_CHANGED');
      const from = new Date(capture.capturedAt).toISOString().slice(0, 10),
        to = new Date(now).toISOString().slice(0, 10);
      const raw = await warehouse.queryReport(
        screeningCounterWarehouseStatement(options),
        {
          customerId: capture.scope.customerId,
          shard: String(BigInt(capture.scope.customerId) % 1024n),
          snapshotId: capture.snapshotId,
          sourceCaptureHash: capture.signature,
          from,
          to,
        },
        {
          customerId: 'STRING',
          shard: 'INT64',
          snapshotId: 'STRING',
          sourceCaptureHash: 'STRING',
          from: 'DATE',
          to: 'DATE',
        },
        'screening-counter-publication',
      );
      if (signal?.aborted) throw counterError('WAREHOUSE_UNAVAILABLE');
      return parseScreeningCounterWarehouseRows(raw, capture, clock());
    },
  };
}
export function screeningCounterWarehouseStatement(options: ScreeningCounterWarehouseOptions) {
  const publications = table.parse(options.publicationsView),
    rows = table.parse(options.rowsView);
  return `WITH publications AS (
 SELECT contract,generation_id AS generationId,snapshot_id AS snapshotId,source_capture_hash AS sourceCaptureHash,
 CAST(source_cdc_through_ms AS STRING) AS sourceCdcThrough,source_complete AS complete,
 CAST(marker_rows AS STRING) AS expectedRows,rows_hash AS rowsHash
 FROM \`${publications}\` WHERE publication_date BETWEEN @from AND @to AND scope_shard=@shard
 AND customer_id=@customerId AND snapshot_id=@snapshotId AND source_capture_hash=@sourceCaptureHash
), facts AS (
 SELECT marker_id,order_id,line_id,included FROM \`${rows}\`
 WHERE publication_date BETWEEN @from AND @to AND scope_shard=@shard AND customer_id=@customerId
 AND generation_id IN(SELECT generationId FROM publications)
)
SELECT TO_JSON_STRING(STRUCT(
 ARRAY(SELECT AS STRUCT * FROM publications LIMIT 2) AS publications,
 (SELECT AS STRUCT CAST(COUNT(*) AS STRING) AS rows,CAST(COUNT(DISTINCT marker_id) AS STRING) AS uniqueRows,
 CAST(COUNTIF(marker_id IS NULL OR order_id IS NULL OR line_id IS NULL OR included IS NULL) AS STRING) AS invalidRows FROM facts) AS actual,
 ARRAY(SELECT AS STRUCT CAST(marker_id AS STRING) AS markerId,CAST(order_id AS STRING) AS orderId,CAST(line_id AS STRING) AS lineId,included FROM facts ORDER BY marker_id LIMIT 10001) AS rows
)) AS document`;
}
export function parseScreeningCounterWarehouseRows(
  input: unknown,
  capture: CounterCapture,
  now: number,
) {
  const encoded = z
    .array(z.object({ document: z.string().max(2000000) }).strict())
    .length(1)
    .safeParse(input);
  if (!encoded.success || Buffer.byteLength(encoded.data[0]!.document) > 2000000)
    throw counterError('WAREHOUSE_INCOMPLETE');
  let raw: unknown;
  try {
    raw = JSON.parse(encoded.data[0]!.document) as unknown;
  } catch {
    throw counterError('WAREHOUSE_INCOMPLETE');
  }
  const value = z
    .object({
      publications: z
        .array(
          z
            .object({
              contract: z.literal(contract),
              generationId: counterHash,
              snapshotId: z.uuid(),
              sourceCaptureHash: counterHash,
              sourceCdcThrough: counterCount,
              complete: z.literal(true),
              expectedRows: counterCount,
              rowsHash: counterHash,
            })
            .strict(),
        )
        .length(1),
      actual: z
        .object({ rows: counterCount, uniqueRows: counterCount, invalidRows: z.literal('0') })
        .strict(),
      rows: z.array(counterRowSchema).max(10000),
    })
    .strict()
    .safeParse(raw);
  if (!value.success) throw counterError('WAREHOUSE_INCOMPLETE');
  const result = value.data,
    pub = result.publications[0]!,
    sourceCdcThrough = Number(pub.sourceCdcThrough);
  if (
    pub.snapshotId !== capture.snapshotId ||
    pub.sourceCaptureHash !== capture.signature ||
    pub.expectedRows !== capture.rows ||
    pub.expectedRows !== result.actual.rows ||
    result.actual.rows !== result.actual.uniqueRows ||
    result.actual.rows !== String(result.rows.length) ||
    pub.rowsHash !== capture.rowsHash ||
    counterRowsHash(result.rows) !== capture.rowsHash ||
    !Number.isSafeInteger(sourceCdcThrough) ||
    sourceCdcThrough < capture.finishedAt ||
    sourceCdcThrough > now
  )
    throw counterError('WAREHOUSE_INCOMPLETE');
  return {
    generationId: pub.generationId,
    snapshotId: pub.snapshotId,
    sourceCaptureHash: pub.sourceCaptureHash,
    sourceCdcThrough,
    complete: true as const,
    rows: result.rows,
  };
}
