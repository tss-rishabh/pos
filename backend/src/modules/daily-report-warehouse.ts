import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError, unavailable } from '../domain/errors.js';
import { identifier } from '../domain/validation.js';

export const dailyOfflineWarehouseContract = 'pos-daily-store-sales-offline-v1';
const dailyRowColumns = [
  'generation_id',
  'offline_projection_contract',
  'store_id',
  'store_name',
  'location_code',
  'order_date',
  'order_source',
  'order_count',
  'qty',
  'revenue',
  'membership_purchase_orders',
  'membership_orders_total',
  'membership_revenue',
  'tss_money_used_total',
  'tss_points_used_total',
  'pg_discount_total',
  'gift_voucher_total',
  'district_total',
  'cash_total',
  'total_online',
  'pending_offline_orders',
  'banking_amount',
  'footfall',
  'target',
] as const;
/** Publisher and reader use this native expression, without JS float serialization. */
export const dailyWarehouseRowHashExpression = `LOWER(TO_HEX(SHA256(TO_JSON_STRING(STRUCT(${dailyRowColumns.map((column) => `CAST(${column} AS STRING) AS ${column}`).join(',')})))))`;
const sourceBaseline = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
  sourceSqlHash = '6ef32f5c50ca710f32aefeb5f0ecd92462e10a0687f78ad71da1d90e5220cd20';
const view = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function dailyWarehouseOptions(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z
    .object({
      BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE: optional(view),
      BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT: optional(z.literal(dailyOfflineWarehouseContract)),
      BIGQUERY_DAILY_REPORT_MAX_CDC_AGE_SECONDS: z.coerce
        .number()
        .int()
        .min(30)
        .max(86400)
        .default(300),
      BIGQUERY_DAILY_REPORT_MAX_PUBLICATION_AGE_SECONDS: z.coerce
        .number()
        .int()
        .min(30)
        .max(86400)
        .default(900),
      BIGQUERY_DAILY_REPORT_MAX_CLOCK_SKEW_SECONDS: z.coerce
        .number()
        .int()
        .min(0)
        .max(300)
        .default(30),
    })
    .safeParse(env);
  if (!parsed.success)
    throw new AppError(
      503,
      'DAILY_WAREHOUSE_CONFIGURATION_INVALID',
      'Historical daily report configuration is invalid.',
    );
  return parsed.data;
}
export type DailyWarehouseOptions = ReturnType<typeof dailyWarehouseOptions>;
export type DailyWarehouseQuery = (
  statement: string,
  params: Record<string, unknown>,
  types: Record<string, string | string[]>,
  resource?: string,
) => Promise<Record<string, unknown>[]>;
export interface DailyWarehousePublication {
  generationId: string;
  publishedAt: string;
  cdcWatermark: string;
}
export interface DailyWarehouseResult {
  rows: Record<string, unknown>[];
  publication: DailyWarehousePublication;
}
const generation = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const integer = z.union([
  z.number().int().safe(),
  z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
]);
const timestamp = z.string().transform((value, context) => {
  try {
    return Temporal.Instant.from(
      value.includes('T') ? value : value.replace(' ', 'T').replace(/ UTC$/, 'Z'),
    );
  } catch {
    context.addIssue({ code: 'custom', message: 'Use a valid publication timestamp.' });
    return z.NEVER;
  }
});
const partitionSchema = z.object({
  generation_id: generation,
  store_id: identifier,
  business_date: z.iso.date(),
  row_count: integer.refine((value) => value >= 0 && value <= 2),
  row_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
  published_at: timestamp,
  cdc_watermark: timestamp,
  source_position: z.string().regex(/^[A-Za-z0-9:._,-]{1,4096}$/),
  publication_state: z.literal('COMPLETE'),
  offline_projection_contract: z.literal(dailyOfflineWarehouseContract),
  business_timezone: z.string(),
  source_baseline: z.literal(sourceBaseline),
  source_sql_sha256: z.literal(sourceSqlHash),
});
const invalidPublication = () =>
  new AppError(
    503,
    'DAILY_WAREHOUSE_PUBLICATION_INVALID',
    'A complete consistent daily report publication could not be verified.',
  );

/** Publication manifests make an empty partition distinguishable from missing CDC data. */
export async function readDailyWarehouseRollups(
  config: Config,
  options: DailyWarehouseOptions,
  query: DailyWarehouseQuery,
  requestedStores: readonly string[],
  from: string,
  to: string,
  now: Temporal.Instant,
): Promise<DailyWarehouseResult> {
  if (
    !config.BIGQUERY_DAILY_ROLLUP_TABLE ||
    !options.BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE ||
    !options.BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT
  )
    return unavailable('BigQuery daily report publication contract');
  const rollup = view.safeParse(config.BIGQUERY_DAILY_ROLLUP_TABLE);
  if (!rollup.success)
    throw new AppError(
      503,
      'DAILY_WAREHOUSE_CONFIGURATION_INVALID',
      'Historical daily report configuration is invalid.',
    );
  const stores = [...new Set(requestedStores.map((store) => identifier.parse(store)))].sort();
  z.iso.date().parse(from);
  z.iso.date().parse(to);
  const dates: string[] = [];
  for (
    let day = Temporal.PlainDate.from(from);
    Temporal.PlainDate.compare(day, to) <= 0;
    day = day.add({ days: 1 })
  ) {
    dates.push(day.toString());
    if (dates.length > 63)
      throw new AppError(400, 'INVALID_DATE_RANGE', 'Select a range of 62 calendar days or less.');
  }
  const expected = new Set(stores.flatMap((store) => dates.map((date) => store + '\0' + date)));
  if (!expected.size || expected.size > 70000)
    throw new AppError(400, 'INVALID_REPORT_SCOPE', 'Select a valid store and date scope.');
  const publicationTable = '`' + options.BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE + '`',
    scopeParams = { stores, start: from, end: to },
    scopeTypes = { stores: ['STRING'], start: 'DATE', end: 'DATE' };
  const generations = await query(
    `SELECT generation_id,CAST(MAX(published_at) AS STRING) AS published_at FROM ${publicationTable} WHERE CAST(store_id AS STRING) IN UNNEST(@stores) AND business_date BETWEEN @start AND @end AND publication_state='COMPLETE' AND offline_projection_contract=@contract GROUP BY generation_id HAVING COUNT(*)=@expected_partitions ORDER BY MAX(published_at) DESC,generation_id DESC LIMIT 1`,
    { ...scopeParams, contract: dailyOfflineWarehouseContract, expected_partitions: expected.size },
    { ...scopeTypes, contract: 'STRING', expected_partitions: 'INT64' },
    'daily-store-report-publication',
  );
  if (generations.length !== 1) throw invalidPublication();
  const selected = z
    .object({ generation_id: generation, published_at: timestamp })
    .safeParse(generations[0]);
  if (!selected.success) throw invalidPublication();
  const params = { ...scopeParams, generation: selected.data.generation_id },
    types = { ...scopeTypes, generation: 'STRING' };
  const publicationRows = await query(
    `SELECT generation_id,CAST(store_id AS STRING) AS store_id,CAST(business_date AS STRING) AS business_date,row_count,row_hashes,CAST(published_at AS STRING) AS published_at,CAST(cdc_watermark AS STRING) AS cdc_watermark,source_position,publication_state,offline_projection_contract,business_timezone,source_baseline,source_sql_sha256 FROM ${publicationTable} WHERE generation_id=@generation AND CAST(store_id AS STRING) IN UNNEST(@stores) AND business_date BETWEEN @start AND @end LIMIT 70001`,
    params,
    types,
    'daily-store-report-publication',
  );
  const parsed = z.array(partitionSchema).safeParse(publicationRows);
  if (!parsed.success || parsed.data.length !== expected.size) throw invalidPublication();
  const partitions = new Map<string, z.infer<typeof partitionSchema>>();
  let watermark: Temporal.Instant | undefined, position: string | undefined;
  for (const partition of parsed.data) {
    const key = partition.store_id + '\0' + partition.business_date;
    if (
      !expected.has(key) ||
      partitions.has(key) ||
      partition.generation_id !== selected.data.generation_id ||
      partition.business_timezone !== config.BUSINESS_TIMEZONE ||
      Temporal.Instant.compare(partition.published_at, selected.data.published_at) !== 0
    )
      throw invalidPublication();
    if (
      (watermark && Temporal.Instant.compare(watermark, partition.cdc_watermark) !== 0) ||
      (position !== undefined && position !== partition.source_position)
    )
      throw invalidPublication();
    watermark = partition.cdc_watermark;
    if (
      partition.row_hashes.length !== partition.row_count ||
      new Set(partition.row_hashes).size !== partition.row_hashes.length
    )
      throw invalidPublication();
    position = partition.source_position;
    partitions.set(key, partition);
  }
  if (!watermark) throw invalidPublication();
  const skew = options.BIGQUERY_DAILY_REPORT_MAX_CLOCK_SKEW_SECONDS * 1000,
    publicationAge = now.epochMilliseconds - selected.data.published_at.epochMilliseconds,
    cdcAge = now.epochMilliseconds - watermark.epochMilliseconds;
  if (
    publicationAge > options.BIGQUERY_DAILY_REPORT_MAX_PUBLICATION_AGE_SECONDS * 1000 ||
    cdcAge > options.BIGQUERY_DAILY_REPORT_MAX_CDC_AGE_SECONDS * 1000 ||
    publicationAge < -skew ||
    cdcAge < -skew ||
    selected.data.published_at.epochMilliseconds + skew < watermark.epochMilliseconds
  )
    throw new AppError(
      503,
      'DAILY_WAREHOUSE_PUBLICATION_STALE',
      'A fresh complete daily report publication is not available.',
    );
  const rows = await query(
    `SELECT ${dailyRowColumns.join(',')},${dailyWarehouseRowHashExpression} AS row_hash FROM \`${rollup.data}\` WHERE generation_id=@generation AND CAST(store_id AS STRING) IN UNNEST(@stores) AND order_date BETWEEN @start AND @end LIMIT 70001`,
    params,
    types,
    'daily-store-report',
  );
  const rowIdentity = z.object({
      generation_id: generation,
      store_id: identifier,
      order_date: z.iso.date(),
      order_source: z.enum(['store_orders', 'online_orders']),
      offline_projection_contract: z.literal(dailyOfflineWarehouseContract),
      row_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    counts = new Map<string, number>(),
    identities = new Set<string>(),
    hashes = new Map<string, Set<string>>();
  for (const row of rows) {
    const identity = rowIdentity.safeParse({
      ...row,
      store_id:
        typeof row.store_id === 'number' && Number.isSafeInteger(row.store_id)
          ? String(row.store_id)
          : row.store_id,
    });
    if (!identity.success || identity.data.generation_id !== selected.data.generation_id)
      throw invalidPublication();
    const key = identity.data.store_id + '\0' + identity.data.order_date,
      unique = key + '\0' + identity.data.order_source;
    if (!partitions.has(key) || identities.has(unique)) throw invalidPublication();
    if (!partitions.get(key)?.row_hashes.includes(identity.data.row_hash))
      throw invalidPublication();
    const partitionHashes = hashes.get(key) || new Set<string>();
    if (partitionHashes.has(identity.data.row_hash)) throw invalidPublication();
    partitionHashes.add(identity.data.row_hash);
    hashes.set(key, partitionHashes);
    identities.add(unique);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, partition] of partitions)
    if ((counts.get(key) || 0) !== partition.row_count) throw invalidPublication();
  return {
    rows,
    publication: {
      generationId: selected.data.generation_id,
      publishedAt: selected.data.published_at.toString(),
      cdcWatermark: watermark.toString(),
    },
  };
}
