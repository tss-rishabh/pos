import type { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { AppError } from '../../src/domain/errors.js';
import { sourceHistoricalSearch } from '../../src/modules/order-history/search/warehouse.js';
import { orderRange } from '../../src/modules/order-history/contracts.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import { warehouseScalar } from '../../src/modules/warehouse.js';
import { config, options, now, scope, fixtures, fact } from '../../tests/order-search/fixtures.js';
/** Called only inside the committed order-history diagnostic's static private-error boundary. */
export async function validateSourceOrderSearch(
  client: BigQuery,
  setStage: (stage: string) => void,
) {
  const literal = (value: string) =>
    `CAST(FROM_BASE64('${Buffer.from(value, 'utf8').toString('base64')}') AS STRING)`;
  const bytes: bigint[] = [];
  let passed = 0;
  for (const mode of ['range', 'point', 'empty', 'corrupt'] as const) {
    const stage = (value: string) => setStage(value + '-' + mode);
    const sample = fixtures(fact, mode === 'point' ? 'order:' + fact.id : 'store:1');
    if (mode === 'empty') {
      sample.publication.source_rows = sample.publication.warehouse_rows = '0';
      const { searchIndexRowsHash } =
        await import('../../src/modules/order-history/search/warehouse.js');
      sample.publication.source_hash = sample.publication.warehouse_hash = searchIndexRowsHash([]);
    }
    if (mode === 'corrupt') sample.fact.fact_json += ' ';
    function table(name: string, row: Record<string, unknown>, types: Record<string, string> = {}) {
      return (
        name +
        ' AS (SELECT ' +
        Object.entries(row)
          .map(
            ([key, value]) =>
              `CAST(${value === null ? 'NULL' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : literal(String(value))} AS ${types[key] ?? 'STRING'}) AS \`${key}\``,
          )
          .join(',') +
        (mode === 'empty' && name === 'fixture_index'
          ? ' FROM UNNEST(ARRAY<INT64>[]) AS empty_fixture'
          : '') +
        ')'
      );
    }
    const ctes = [
      table(
        'fixture_publications',
        { ...sample.publication, scope_shard: String(BigInt(fact.id) % 1024n) },
        {
          business_date: 'DATE',
          source_complete: 'BOOL',
          source_rows: 'INT64',
          warehouse_rows: 'INT64',
          scope_shard: 'INT64',
          source_snapshot_at: 'TIMESTAMP',
          source_cdc_watermark: 'TIMESTAMP',
          published_at: 'TIMESTAMP',
        },
      ),
      table(
        'fixture_index',
        {
          ...sample.index,
          contract_version: sample.publication.contract_version,
          generation_id: sample.publication.generation_id,
        },
        { business_date: 'DATE' },
      ),
      table(
        'fixture_facts',
        {
          ...sample.fact,
          contract_version: sample.publication.contract_version,
          generation_id: sample.publication.generation_id,
          order_shard: String(BigInt(fact.id) % 8192n),
        },
        { business_date: 'DATE', order_shard: 'INT64' },
      ),
    ].join(',\n');
    function statement(sql: string) {
      const replaced = sql
        .replaceAll('`' + options.BQ_ORDER_SEARCH_INDEX_VIEW + '`', 'fixture_index')
        .replaceAll('`' + options.BQ_ORDER_SEARCH_FACTS_VIEW + '`', 'fixture_facts')
        .replaceAll('`' + options.BQ_ORDER_SEARCH_PUBLICATIONS_VIEW + '`', 'fixture_publications');
      if (/`tssgcp2025\./.test(replaced))
        throw new Error('Synthetic fixture referenced a dataset table.');
      return 'WITH ' + ctes + '\n' + replaced;
    }
    const reader = sourceHistoricalSearch(config, options, {
      clock: () => now,
      estimate: async (request) => {
        stage(
          request.statement.includes('fact_json,fact_hash')
            ? 'synthetic-order-search-facts-estimate'
            : request.statement.includes('index_json,index_hash')
              ? 'synthetic-order-search-index-estimate'
              : 'synthetic-order-search-publication-estimate',
        );
        const [job] = await client.createQueryJob({
          query: statement(request.statement),
          params: normalizeWarehouseParameters(request.params, request.types),
          types: request.types,
          dryRun: true,
          useLegacySql: false,
          maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'synthetic-order-search' },
        });
        stage('synthetic-order-search-estimate-metadata');
        const size = BigInt(
          z
            .object({
              statistics: z.object({
                query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
              }),
            })
            .parse(job.metadata).statistics.query.totalBytesProcessed,
        );
        bytes.push(size);
        return size;
      },
      query: async (sql, params, types) => {
        stage('synthetic-order-search-query');
        const response: unknown = await client.query({
          query: statement(sql),
          params: normalizeWarehouseParameters(params, types),
          types,
          useLegacySql: false,
          maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'synthetic-order-search' },
        });
        return z
          .array(z.record(z.string(), z.unknown()))
          .parse(z.array(z.unknown()).parse(response)[0])
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [key, warehouseScalar(value)]),
            ),
          );
      },
    });
    try {
      const indexes =
        mode === 'point'
          ? await reader.ids(scope, [fact.id], '2026-11-17 00:00:00')
          : await reader.range(
              scope,
              orderRange({ from: '2026-11-16', to: '2026-11-16' }, config.BUSINESS_TIMEZONE, now),
            );
      if (mode === 'empty') {
        if (indexes.indexes.length) throw new Error('Empty publication changed.');
      } else if ((await indexes.facts([fact.id]))[0]?.id !== fact.id)
        throw new Error('Synthetic fact disappeared.');
      if (mode === 'corrupt') throw new Error('Corrupted synthetic payload passed.');
    } catch (error: unknown) {
      if (
        mode !== 'corrupt' ||
        !(error instanceof AppError) ||
        error.code !== 'ORDER_SEARCH_PUBLICATION_INVALID'
      )
        throw error;
    }
    passed++;
  }
  process.stdout.write(
    JSON.stringify({
      resource: 'order-search',
      passed,
      syntheticOnly: true,
      sourceRowsRead: 0,
      maxEstimatedBytes: bytes.reduce((a, b) => (a > b ? a : b), 0n).toString(),
    }) + '\n',
  );
}
