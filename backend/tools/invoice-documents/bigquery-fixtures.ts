import { BigQuery } from '@google-cloud/bigquery';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import {
  invoiceHistoryReader,
  invoiceHistoryPublicationContract,
  invoiceHistorySql,
  type InvoiceHistoryStatement,
} from '../../src/modules/invoice-documents/history.js';
import type { InvoiceDocumentOptions } from '../../src/modules/invoice-documents/options.js';
import type { InvoiceAuthority } from '../../src/modules/invoice-documents/authority.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';

const options: InvoiceDocumentOptions = {
  historyPublicationContract: invoiceHistoryPublicationContract,
  historyOrdersView: 'tssgcp2025.tss_mysql_raw_layer.pos_invoice_orders_v1',
  historyCustomersView: 'tssgcp2025.tss_mysql_raw_layer.pos_invoice_customer_counts_v1',
  historyPublicationsView: 'tssgcp2025.tss_mysql_raw_layer.pos_invoice_publications_v1',
  historyMaxLagSeconds: 600,
};
const scope = { storeId: '1', orderId: '9007199254740993' },
  authority: InvoiceAuthority = {
    binding: 'a'.repeat(64),
    number: null,
    customerId: '9007199254740994',
    orderStatus: '3',
    updatedAt: '2026-11-16 10:00:00',
  },
  generation = '123e4567-e89b-42d3-a456-426614174000';
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function synthetic(statement: string, eligible: string, status: string, incomplete = false) {
  const publication = `SELECT ${quote(generation)} AS generation_id,${quote(invoiceHistoryPublicationContract)} AS contract_version,'orders' AS source_table,${incomplete ? 'FALSE' : 'TRUE'} AS source_complete,'source-fixture-snapshot-1' AS source_snapshot_id,TIMESTAMP '2026-11-16 10:00:30+00' AS source_snapshot_at,TIMESTAMP '2026-11-16 10:00:31+00' AS source_cdc_watermark,TIMESTAMP '2026-11-16 10:00:32+00' AS published_at,10 AS source_rows,10 AS warehouse_rows,${quote('a'.repeat(64))} AS source_hash,${quote('a'.repeat(64))} AS warehouse_hash`;
  const customers = `SELECT ${quote(generation)} AS generation_id,${quote(authority.customerId)} AS customer_id,3 AS source_rows,3 AS warehouse_rows,${quote('b'.repeat(64))} AS source_hash,${quote('b'.repeat(64))} AS warehouse_hash,${eligible} AS source_eligible_count,${eligible} AS warehouse_eligible_count`;
  const selected = `SELECT ${quote(generation)} AS generation_id,${quote(scope.orderId)} AS order_id,${quote(authority.customerId)} AS customer_id,${quote(status)} AS order_status,'4' AS payment_status,DATETIME '2026-11-16 10:00:00' AS updated_at`;
  return statement
    .replace(
      'WITH latest AS',
      `WITH fixture_publications AS(${publication}),fixture_customers AS(${customers}),fixture_orders AS(${selected}),latest AS`,
    )
    .replaceAll('`' + options.historyPublicationsView + '`', 'fixture_publications')
    .replaceAll('`' + options.historyCustomersView + '`', 'fixture_customers')
    .replaceAll('`' + options.historyOrdersView + '`', 'fixture_orders');
}
let stage = 'setup';
async function main() {
  const config = readConfig({
      ...process.env,
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'invoice-synthetic-query-'.repeat(4),
      BIGQUERY_PROJECT_ID: 'tssgcp2025',
      BIGQUERY_LOCATION: 'asia-south1',
    }),
    client = new BigQuery({
      projectId: config.BIGQUERY_PROJECT_ID,
      location: config.BIGQUERY_LOCATION,
    }),
    results: unknown[] = [];
  for (const vector of [
    { name: 'complete-positive', count: '2', status: '3', incomplete: false, empty: false },
    { name: 'attested-zero', count: '0', status: '4', incomplete: false, empty: false },
    { name: 'incomplete-manifest', count: '2', status: '3', incomplete: true, empty: false },
    { name: 'empty-response', count: '2', status: '3', incomplete: false, empty: true },
  ]) {
    stage = vector.name;
    const run = async (
      statement: string,
      params: Record<string, unknown>,
      types: Record<string, string | string[]>,
    ) => {
      const literal = synthetic(statement, vector.count, vector.status, vector.incomplete),
        query = vector.empty
          ? `SELECT * FROM (${literal}) WHERE @contract='missing-generation'`
          : literal;
      assert(!query.includes('`tssgcp2025.'));
      const [rows]: unknown[] = await client.query({
        query,
        params: normalizeWarehouseParameters(params, types),
        types,
        useLegacySql: false,
        maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
        jobTimeoutMs: 10000,
        labels: { application: 'pos-rewrite', resource: 'invoice-count-synthetic' },
      });
      return z.array(z.record(z.string(), z.unknown())).parse(rows);
    };
    const reader = invoiceHistoryReader(
      config,
      options,
      async (_query: InvoiceHistoryStatement) => 0n,
      run,
      () => Date.parse('2026-11-16T10:01:00Z'),
    );
    if (vector.incomplete || vector.empty) {
      await assert.rejects(reader(scope, { ...authority, orderStatus: vector.status }), {
        code: 'INVOICE_HISTORY_PUBLICATION_INVALID',
      });
      results.push({ name: vector.name, rejected: true });
    } else {
      const value = await reader(scope, { ...authority, orderStatus: vector.status });
      assert.equal(value.count, vector.count);
      results.push({
        name: vector.name,
        count: value.count,
        generation: value.evidence.generationId,
      });
    }
  }
  // Metadata-only raw estimate. It does NOT establish source completeness and
  // this raw query is never executed by the runtime count reader.
  const rawSql =
    'SELECT COUNT(*) AS count FROM `tssgcp2025.tss_mysql_raw_layer.tss_orders` WHERE user_id=CAST(@customer AS INT64) AND order_status NOT IN(0,4,7,10,15,17,22,24,36)';
  stage = 'raw-dry-run';
  const [job] = await client.createQueryJob({
    query: rawSql,
    params: { customer: '0' },
    types: { customer: 'STRING' },
    dryRun: true,
    useLegacySql: false,
    maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'invoice-count-estimate' },
  });
  const bytes = z
    .object({
      statistics: z.object({ query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }) }),
    })
    .parse(job.metadata).statistics.query.totalBytesProcessed;
  const evidence = {
    checkedAt: new Date().toISOString(),
    scope:
      'Four generated-literal-only SELECT cases plus one metadata-only raw dry-run; no source rows read',
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    statementSha256: createHash('sha256').update(invoiceHistorySql(options)).digest('hex'),
    byteCap: config.BIGQUERY_MAX_BYTES_BILLED,
    rawEstimateBytes: bytes,
    rawActivated: false,
    completeness:
      'Raw CDC apply metadata is not a source-completeness attestation; explicit published generations remain required',
    results,
  };
  const directory = 'parity/evidence/invoice-documents';
  await mkdir(directory, { recursive: true });
  await writeFile(
    directory + '/bigquery-fixtures.json.tmp',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  await rename(directory + '/bigquery-fixtures.json.tmp', directory + '/bigquery-fixtures.json');
  console.log(
    JSON.stringify({
      syntheticCases: results.length,
      rawEstimateBytes: bytes,
      rawActivated: false,
    }),
  );
}
try {
  await main();
} catch {
  console.error(JSON.stringify({ eventId: 'INVOICE_BIGQUERY_SYNTHETIC_CHECK_FAILED', stage }));
  process.exitCode = 1;
}
