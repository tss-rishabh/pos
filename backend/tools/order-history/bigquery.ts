/** Execute ONLY generated synthetic SELECT fixtures. Never reads a source table or key bytes. */
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { AppError } from '../../src/domain/errors.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import { publicOrderHistory } from '../../src/modules/order-history/reader.js';
import {
  historyListRowHash,
  historyRowsHash,
  historyOrderHash,
  historyCopyHash,
} from '../../src/modules/order-history/hashes.js';
import {
  config,
  options,
  now,
  range,
  header,
  stores,
  lines,
  manifest,
} from '../../tests/order-history/fixtures.js';
let stage = 'configuration';
async function main() {
  if (process.env.ORDER_HISTORY_DIAGNOSTIC_FIXTURE === 'credential-error') {
    stage = 'synthetic-private-error';
    throw Object.assign(new Error('synthetic-secret-error-message'), {
      code: 400,
      request: { headers: { authorization: 'Bearer synthetic-secret-bearer' } },
      response: {
        headers: { 'x-private': 'synthetic-secret-header' },
        body: { secret: 'synthetic-secret-body' },
      },
      cause: new Error('synthetic-secret-cause'),
      toJSON() {
        throw new Error('SDK errors must not be serialized.');
      },
    });
  }
  const keyFilename = process.env.BQ_ORDER_HISTORY_VALIDATION_KEY_FILE;
  if (!keyFilename)
    throw new Error(
      'Provide the authorized read-only BigQuery key filename to run synthetic fixtures.',
    );
  const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1', keyFilename });
  if (process.env.ORDER_HISTORY_VALIDATION_GROUP === 'source-order-search') {
    const { validateSourceOrderSearch } = await import('../order-search/bigquery-fixtures.js');
    await validateSourceOrderSearch(client, (value) => {
      stage = value;
    });
    return;
  }
  const quote = (value: string) => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  function cte(
    name: string,
    rows: Record<string, string | boolean | null>[],
    types: Record<string, string> = {},
  ) {
    return (
      name +
      ' AS (' +
      rows
        .map(
          (row) =>
            'SELECT ' +
            Object.entries(row)
              .map(([key, value]) => {
                const type = types[key] ?? (typeof value === 'boolean' ? 'BOOL' : 'STRING');
                const literal =
                  value === null
                    ? 'NULL'
                    : typeof value === 'boolean'
                      ? value
                        ? 'TRUE'
                        : 'FALSE'
                      : quote(value);
                return `CAST(${literal} AS ${type}) AS \`${key}\``;
              })
              .join(','),
        )
        .join(' UNION ALL ') +
      ')'
    );
  }
  const sampleHeader = { ...header, first: 'Synthetic π', reference: "SYNTHETIC-quote'\\-é" };
  const sampleStores = [
    ...stores,
    ...Array.from({ length: 101 }, (_, index) => ({ ...stores[0]!, id: String(1000 + index) })),
  ].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  function fixtures(corrupt = false) {
    const listRows = [...sampleStores]
      .reverse()
      .map((store) => historyListRowHash(sampleHeader, store));
    const publications = [
      manifest(
        'store-day',
        '2026-11-15',
        { rows: '0', orders: '0', stores: '0', lines: '0' },
        historyRowsHash([]),
      ),
      manifest(
        'store-day',
        '2026-11-16',
        {
          rows: String(sampleStores.length),
          orders: '1',
          stores: String(sampleStores.length),
          lines: '0',
        },
        historyRowsHash(listRows),
      ),
      manifest(
        'order',
        '2026-11-16',
        {
          rows: String(1 + sampleStores.length + lines.length),
          orders: '1',
          stores: String(sampleStores.length),
          lines: String(lines.length),
        },
        historyOrderHash([sampleHeader], sampleStores, lines),
      ),
    ];
    publications[2]!.source_copy_hash = publications[2]!.warehouse_copy_hash = historyCopyHash(
      [sampleHeader],
      sampleStores,
      lines,
    );
    if (corrupt)
      for (const pub of publications) {
        pub.source_hash = pub.warehouse_hash = '0'.repeat(64);
        if (pub.kind === 'order') pub.source_copy_hash = pub.warehouse_copy_hash = '0'.repeat(64);
      }
    const countTypes = Object.fromEntries(
      [
        'source_rows',
        'warehouse_rows',
        'source_orders',
        'warehouse_orders',
        'source_stores',
        'warehouse_stores',
        'source_lines',
        'warehouse_lines',
      ].map((key) => [key, 'INT64']),
    );
    return [
      cte(
        'fixture_headers',
        [
          {
            generation_id: publications[0]!.generation_id,
            order_id: sampleHeader.id,
            customer_id: sampleHeader.customerId,
            reference: sampleHeader.reference,
            first_name: sampleHeader.first,
            last_name: sampleHeader.last,
            amount: sampleHeader.amount,
            status: sampleHeader.status,
            payment_status: sampleHeader.paymentStatus,
            payment_status_id: sampleHeader.paymentStatusId,
            created_at: sampleHeader.createdAt,
          },
        ],
        { created_at: 'DATETIME' },
      ),
      cte(
        'fixture_stores',
        sampleStores.map((store) => ({
          generation_id: publications[0]!.generation_id,
          business_date: '2026-11-16',
          order_store_id: store.id,
          order_id: store.orderId,
          store_id: store.storeId,
          counter_id: store.counterId,
        })),
        { business_date: 'DATE' },
      ),
      cte(
        'fixture_lines',
        lines.map((line) => ({
          generation_id: publications[0]!.generation_id,
          line_id: line.id,
          order_id: line.orderId,
          product_id: line.productId,
          name: line.name,
          quantity: line.quantity,
          amount: line.amount,
          gst: line.gst,
          status: line.status,
          business_date: '2026-11-16',
        })),
        { business_date: 'DATE' },
      ),
      cte(
        'fixture_publications',
        publications.map((pub) => ({ ...pub, scope_shard: String(BigInt(pub.scope_id) % 1024n) })),
        {
          ...countTypes,
          scope_shard: 'INT64',
          business_date: 'DATE',
          source_snapshot_at: 'TIMESTAMP',
          source_cdc_watermark: 'TIMESTAMP',
          published_at: 'TIMESTAMP',
        },
      ),
    ].join(',\n');
  }
  function statement(sql: string, corrupt: boolean) {
    const mapped = sql
      .replaceAll('`' + options.BQ_ORDER_HISTORY_HEADERS_VIEW + '`', 'fixture_headers')
      .replaceAll('`' + options.BQ_ORDER_HISTORY_STORES_VIEW + '`', 'fixture_stores')
      .replaceAll('`' + options.BQ_ORDER_HISTORY_LINES_VIEW + '`', 'fixture_lines')
      .replaceAll('`' + options.BQ_ORDER_HISTORY_PUBLICATIONS_VIEW + '`', 'fixture_publications');
    if (/`tssgcp2025\./.test(mapped))
      throw new Error('Synthetic validation must not reference a dataset table.');
    return mapped.replace(/^WITH /, 'WITH ' + fixtures(corrupt) + ',\n');
  }
  let passed = 0;
  const bytes: bigint[] = [];
  for (const corrupt of [false, true]) {
    const reader = publicOrderHistory(config, options, {
      clock: () => now,
      estimate: async (request) => {
        stage = 'synthetic-select-estimate';
        const [job] = await client.createQueryJob({
          query: statement(request.statement, corrupt),
          params: normalizeWarehouseParameters(request.params, request.types),
          types: request.types,
          dryRun: true,
          useLegacySql: false,
          maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'synthetic-order-history' },
        });
        const value = BigInt(
          z
            .object({
              statistics: z.object({
                query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
              }),
            })
            .parse(job.metadata).statistics.query.totalBytesProcessed,
        );
        bytes.push(value);
        return value;
      },
      query: async (sql, params, types) => {
        stage = 'synthetic-select-query';
        const response: unknown = await client.query({
          query: statement(sql, corrupt),
          params: normalizeWarehouseParameters(params, types),
          types,
          useLegacySql: false,
          maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'synthetic-order-history' },
        });
        return z
          .array(z.record(z.string(), z.unknown()))
          .parse(z.array(z.unknown()).parse(response)[0]);
      },
    });
    for (const kind of ['list', 'order', 'copy'] as const) {
      try {
        const result =
          kind === 'list'
            ? await reader.list({ storeId: '1', range, limit: 30 })
            : kind === 'order'
              ? await reader.order({
                  source: { kind: 'store', storeId: '1' },
                  orderId: header.id,
                  cutoff: '2026-11-17 00:00:00',
                })
              : await reader.copyFacts({
                  source: { kind: 'customer', customerId: '7' },
                  orderId: header.id,
                  cutoff: '2026-11-17 00:00:00',
                });
        if (corrupt) throw new Error('Corrupted publication unexpectedly passed.');
        if (kind === 'copy' && (!('lines' in result) || result.lines.length !== 3))
          throw new Error('Synthetic copy cardinality changed.');
      } catch (error) {
        if (
          !corrupt ||
          !(error instanceof AppError && error.code === 'ORDER_HISTORY_PUBLICATION_INVALID')
        )
          throw error;
      }
      passed++;
    }
  }
  process.stdout.write(
    JSON.stringify({
      resource: 'public-order-history',
      passed,
      syntheticOnly: true,
      sourceRowsRead: 0,
      maxEstimatedBytes: bytes.reduce((a, b) => (a > b ? a : b), 0n).toString(),
    }) + '\n',
  );
}
void main().catch((_error: unknown) => {
  // SDK errors can contain Authorization headers. Never print the object,
  // stack, response, request or message, even for synthetic SELECT fixtures.
  process.stderr.write(
    JSON.stringify({ resource: 'public-order-history', stage, code: 'VALIDATION_FAILED' }) + '\n',
  );
  process.exitCode = 1;
});
