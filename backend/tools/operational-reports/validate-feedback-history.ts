import { BigQuery } from '@google-cloud/bigquery';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import { feedbackHistoryOptions } from '../../src/modules/operational-reports/feedback-history-options.js';
import { feedbackHistorySql } from '../../src/modules/operational-reports/feedback-history-sql.js';

const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFilename || !isAbsolute(keyFilename)) throw new Error('READ_ONLY_KEY_PATH_REQUIRED');
const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1', keyFilename }),
  options = feedbackHistoryOptions({}),
  query = feedbackHistorySql(options),
  nativeBytes = await readFile('parity/evidence/feedback-history/native-fixtures.json', 'utf8'),
  native = z
    .object({
      source: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
      scope: z.literal('generated-local-fixtures-only'),
      dataset: z.record(
        z.string(),
        z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
      ),
      cases: z.array(
        z.object({
          name: z.string(),
          params: z.record(z.string(), z.unknown()),
          expected: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .parse(JSON.parse(nativeBytes) as unknown),
  types: Record<string, string | string[]> = {
    start: 'DATETIME',
    end: 'DATETIME',
    stores: ['STRING'],
    allStores: 'BOOL',
    orders: ['STRING'],
    allOrders: 'BOOL',
    customers: ['STRING'],
    allCustomers: 'BOOL',
    page: 'INT64',
    pageSize: 'INT64',
  },
  columns = {
    orders: { id: 'INT64', user_id: 'INT64', created_at: 'DATETIME' },
    order_stores: { id: 'INT64', order_id: 'INT64', store_id: 'INT64' },
    nps_feedback: {
      id: 'INT64',
      order_id: 'INT64',
      question_id: 'INT64',
      feedback_answer: 'STRING',
      created_at: 'DATETIME',
    },
  };
const ctes = Object.entries(columns)
  .map(([name, fields]) => {
    const rows = native.dataset[name];
    if (!rows?.length) throw new Error('GENERATED_SOURCE_FIXTURE_MISSING');
    return (
      name +
      ' AS (SELECT * FROM UNNEST([' +
      rows
        .map(
          (row) =>
            'STRUCT(' +
            Object.entries(fields)
              .map(
                ([column, type]) =>
                  `CAST(${row[column] === null ? 'NULL' : JSON.stringify(String(row[column]))} AS ${type}) AS ${column}`,
              )
              .join(',') +
            ')',
        )
        .join(',') +
      ']))'
    );
  })
  .join(',');
let literalQuery = query
  .replaceAll('`' + options.BQ_CUSTOMER_FEEDBACK_TABLE + '`', 'nps_feedback')
  .replaceAll('`' + options.BQ_CUSTOMER_FEEDBACK_ORDERS_TABLE + '`', 'orders')
  .replaceAll('`' + options.BQ_CUSTOMER_FEEDBACK_ORDER_STORES_TABLE + '`', 'order_stores');
literalQuery = 'WITH ' + ctes + ',' + literalQuery.replace(/^WITH\s+/, '');
if (literalQuery.includes('`') || literalQuery.includes(';'))
  throw new Error('SOURCE_REFERENCE_IN_SYNTHETIC_QUERY');
const result: {
  checkedAt: string;
  source: string;
  nativeSha256: string;
  scope: string;
  dryRun: { estimatedBytes: string; overConfiguredBudget: boolean; statementSha256: string } | null;
  cases: { name: string; matched: boolean; errorCode: string | null }[];
  sourceRowsRead: number;
  cloudWrites: number;
  errors: string[];
  limitations: string[];
} = {
  checkedAt: new Date().toISOString(),
  source: native.source,
  nativeSha256: createHash('sha256').update(nativeBytes).digest('hex'),
  scope: 'raw-dry-run-and-generated-literal-select-only',
  dryRun: null,
  cases: [],
  sourceRowsRead: 0,
  cloudWrites: 0,
  errors: [],
  limitations: [
    'Raw source query is dry-run metadata only. Executed SELECTs use generated fixture literals exclusively.',
    'MySQL native tests verify current collation/dimension enrichment and writer authorization separately.',
    'Raw CDC does not establish a transaction-consistent snapshot or financial publication.',
    'Production activation still requires source replication/ownership/DATETIME contracts and estimates within the unchanged configured byte budget.',
  ],
};
try {
  const params = native.cases[0]!.params,
    [job] = await client.createQueryJob({
      query,
      params: normalizeWarehouseParameters(params, types),
      types,
      dryRun: true,
      useLegacySql: false,
      maximumBytesBilled: '1000000000',
      jobTimeoutMs: 10000,
      labels: { application: 'pos-rewrite', resource: 'customer-feedback-schema' },
    }),
    metadata = z
      .object({
        statistics: z.object({
          query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
        }),
      })
      .parse(job.metadata);
  result.dryRun = {
    estimatedBytes: metadata.statistics.query.totalBytesProcessed,
    overConfiguredBudget: BigInt(metadata.statistics.query.totalBytesProcessed) > 1000000000n,
    statementSha256: createHash('sha256').update(query).digest('hex'),
  };
} catch {
  result.errors.push('CUSTOMER_FEEDBACK_DRY_RUN_FAILED');
}
for (const item of native.cases) {
  const entry = { name: item.name, matched: false, errorCode: null as string | null };
  try {
    const [rows]: [unknown, ...unknown[]] = await client.query({
      query: literalQuery,
      params: normalizeWarehouseParameters(item.params, types),
      types,
      useLegacySql: false,
      maximumBytesBilled: '10485760',
      jobTimeoutMs: 10000,
      labels: { application: 'pos-rewrite', resource: 'customer-feedback-synthetic' },
    });
    entry.matched = isDeepStrictEqual(rows, [item.expected]);
    if (!entry.matched) entry.errorCode = 'GENERATED_FIXTURE_DIFFERENCE';
  } catch {
    entry.errorCode = 'GENERATED_FIXTURE_QUERY_FAILED';
  }
  result.cases.push(entry);
}
const file = 'parity/evidence/feedback-history/bigquery-fixtures.json',
  temporary = file + '.' + randomUUID() + '.tmp';
await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
await rename(temporary, file);
process.stdout.write(
  JSON.stringify({
    evidence: file,
    dryRun: result.dryRun,
    cases: result.cases.length,
    matched: result.cases.filter((item) => item.matched).length,
    errors: result.errors,
    failedIndices: result.cases.flatMap((item, index) => (item.errorCode ? [index] : [])),
  }) + '\n',
);
if (result.errors.length || result.cases.some((item) => !item.matched)) process.exitCode = 1;
