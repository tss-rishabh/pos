import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { normalizeWarehouseParameters } from '../warehouse-parameters.js';
import type { InvoiceAuthority } from './authority.js';
import type { InvoiceDocumentScope } from './contracts.js';
import type { InvoiceDocumentOptions } from './options.js';

export const invoiceHistoryPublicationContract = 'pos-invoice-orders-publication-v1';
const table = z.string().regex(/^[a-z][a-z0-9-]{4,62}\.[A-Za-z_]\w{0,1023}\.[A-Za-z_]\w{0,1023}$/),
  count = z
    .string()
    .regex(/^(0|[1-9]\d{0,18})$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  timestamp = z.iso.datetime({ offset: true });
export const invoiceHistoryEvidence = z
  .object({
    generationId: z.uuid(),
    sourceSnapshotId: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    sourceSnapshotAt: timestamp,
    sourceCdcWatermark: timestamp,
    publishedAt: timestamp,
    customerSourceRows: count,
    customerOrdersHash: digest,
  })
  .strict();
export const invoiceHistoryResult = z.object({ count, evidence: invoiceHistoryEvidence }).strict();
export type InvoiceHistory = z.infer<typeof invoiceHistoryResult>;
export type InvoiceHistoryReader = (
  scope: InvoiceDocumentScope,
  authority: InvoiceAuthority,
) => Promise<InvoiceHistory>;
export interface InvoiceHistoryStatement {
  statement: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
}
export type InvoiceHistoryEstimator = (query: InvoiceHistoryStatement) => Promise<bigint>;
const missing = () =>
  new AppError(
    503,
    'INVOICE_HISTORY_PUBLICATION_REQUIRED',
    'A complete historical order-count publication is required before this invoice can be rendered.',
  );
const invalid = () =>
  new AppError(
    503,
    'INVOICE_HISTORY_PUBLICATION_INVALID',
    'The historical order-count publication could not be verified.',
  );
export function invoiceHistorySql(options: InvoiceDocumentOptions) {
  const publications = table.parse(options.historyPublicationsView),
    customers = table.parse(options.historyCustomersView),
    orders = table.parse(options.historyOrdersView);
  return `WITH latest AS (
    SELECT * FROM \`${publications}\` WHERE contract_version=@contract AND source_table='orders'
    QUALIFY DENSE_RANK() OVER(ORDER BY published_at DESC)=1
  ) SELECT
    ARRAY(SELECT AS STRUCT generation_id,contract_version,source_table,source_complete,source_snapshot_id,
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_snapshot_at,'UTC') AS source_snapshot_at,
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_cdc_watermark,'UTC') AS source_cdc_watermark,
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',published_at,'UTC') AS published_at,
      CAST(source_rows AS STRING) AS source_rows,CAST(warehouse_rows AS STRING) AS warehouse_rows,source_hash,warehouse_hash
      FROM latest LIMIT 2) AS publication,
    ARRAY(SELECT AS STRUCT generation_id,customer_id,CAST(source_rows AS STRING) AS source_rows,
      CAST(warehouse_rows AS STRING) AS warehouse_rows,source_hash,warehouse_hash,
      CAST(source_eligible_count AS STRING) AS source_eligible_count,CAST(warehouse_eligible_count AS STRING) AS warehouse_eligible_count
      FROM \`${customers}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND customer_id=@customer LIMIT 2) AS customers,
    ARRAY(SELECT AS STRUCT generation_id,order_id,customer_id,order_status,payment_status,
      FORMAT_DATETIME('%Y-%m-%d %H:%M:%E6S',updated_at) AS updated_at
      FROM \`${orders}\` WHERE generation_id IN(SELECT generation_id FROM latest) AND customer_id=@customer AND order_id=@order LIMIT 2) AS selected`;
}
export function invoiceHistorySdkEstimator(config: Config): InvoiceHistoryEstimator {
  let client: BigQuery | undefined;
  return async (query) => {
    if (!config.BIGQUERY_PROJECT_ID) throw missing();
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
        labels: { application: 'pos-rewrite', resource: 'invoice-order-count' },
      });
      return BigInt(
        z
          .object({ statistics: z.object({ query: z.object({ totalBytesProcessed: count }) }) })
          .parse(job.metadata).statistics.query.totalBytesProcessed,
      );
    } catch {
      throw new AppError(
        503,
        'INVOICE_HISTORY_ESTIMATE_UNAVAILABLE',
        'The historical order-count query budget could not be verified.',
      );
    }
  };
}
function normalizedSourceDate(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw invalid();
  return match[1] + '.' + (match[2] ?? '').padEnd(6, '0');
}
export function invoiceHistoryReader(
  config: Config,
  options: InvoiceDocumentOptions,
  estimate: InvoiceHistoryEstimator = invoiceHistorySdkEstimator(config),
  queryReport = warehouseService(config).queryReport,
  clock: () => number = Date.now,
): InvoiceHistoryReader {
  return async (scope, authority) => {
    if (
      options.historyPublicationContract !== invoiceHistoryPublicationContract ||
      !options.historyOrdersView ||
      !options.historyCustomersView ||
      !options.historyPublicationsView ||
      options.historyMaxLagSeconds === undefined
    )
      throw missing();
    const query = {
      statement: invoiceHistorySql(options),
      params: {
        contract: invoiceHistoryPublicationContract,
        customer: authority.customerId,
        order: scope.orderId,
      },
      types: { contract: 'STRING', customer: 'STRING', order: 'STRING' },
    };
    const bytes = await estimate(query);
    if (bytes < 0n || bytes > BigInt(config.BIGQUERY_MAX_BYTES_BILLED))
      throw new AppError(
        503,
        'INVOICE_HISTORY_PROJECTION_REQUIRED',
        'The historical invoice count needs a projection within its configured query budget.',
      );
    const raw = await queryReport(
      query.statement,
      query.params,
      query.types,
      'invoice-order-count',
    );
    const publication = z.object({
      generation_id: z.uuid(),
      contract_version: z.literal(invoiceHistoryPublicationContract),
      source_table: z.literal('orders'),
      source_complete: z.literal(true),
      source_snapshot_id: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
      source_snapshot_at: timestamp,
      source_cdc_watermark: timestamp,
      published_at: timestamp,
      source_rows: count,
      warehouse_rows: count,
      source_hash: digest,
      warehouse_hash: digest,
    });
    const customer = z.object({
      generation_id: z.uuid(),
      customer_id: z.string(),
      source_rows: count,
      warehouse_rows: count,
      source_hash: digest,
      warehouse_hash: digest,
      source_eligible_count: count,
      warehouse_eligible_count: count,
    });
    const selected = z.object({
      generation_id: z.uuid(),
      order_id: z.string(),
      customer_id: z.string(),
      order_status: z.string(),
      payment_status: z.string(),
      updated_at: z.string(),
    });
    const parsed = z
      .array(
        z.object({
          publication: z.array(publication).length(1),
          customers: z.array(customer).length(1),
          selected: z.array(selected).length(1),
        }),
      )
      .length(1)
      .safeParse(raw);
    if (!parsed.success) throw invalid();
    const value = parsed.data[0]!,
      p = value.publication[0]!,
      c = value.customers[0]!,
      o = value.selected[0]!,
      now = clock(),
      snapshotAt = Date.parse(p.source_snapshot_at),
      watermark = Date.parse(p.source_cdc_watermark),
      published = Date.parse(p.published_at);
    if (
      p.source_rows !== p.warehouse_rows ||
      p.source_hash !== p.warehouse_hash ||
      BigInt(p.source_rows) < 1n ||
      c.generation_id !== p.generation_id ||
      o.generation_id !== p.generation_id ||
      c.customer_id !== authority.customerId ||
      o.customer_id !== authority.customerId ||
      o.order_id !== scope.orderId ||
      o.payment_status !== '4' ||
      o.order_status !== authority.orderStatus ||
      o.updated_at !== normalizedSourceDate(authority.updatedAt) ||
      c.source_rows !== c.warehouse_rows ||
      c.source_hash !== c.warehouse_hash ||
      c.source_eligible_count !== c.warehouse_eligible_count ||
      BigInt(c.source_rows) < 1n ||
      BigInt(c.source_eligible_count) > BigInt(c.source_rows) ||
      BigInt(c.source_rows) > BigInt(p.source_rows) ||
      snapshotAt > now + 5000 ||
      published > now + 5000 ||
      watermark > now + 5000 ||
      published < snapshotAt ||
      watermark < snapshotAt ||
      published + 5000 < watermark ||
      (!['0', '4', '7', '10', '15', '17', '22', '24', '36'].includes(authority.orderStatus) &&
        BigInt(c.source_eligible_count) < 1n) ||
      now - snapshotAt > options.historyMaxLagSeconds * 1000
    )
      throw invalid();
    return invoiceHistoryResult.parse({
      count: c.source_eligible_count,
      evidence: {
        generationId: p.generation_id,
        sourceSnapshotId: p.source_snapshot_id,
        sourceSnapshotAt: p.source_snapshot_at,
        sourceCdcWatermark: p.source_cdc_watermark,
        publishedAt: p.published_at,
        customerSourceRows: c.source_rows,
        customerOrdersHash: c.source_hash,
      },
    });
  };
}
