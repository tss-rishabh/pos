import { BigQuery } from '@google-cloud/bigquery';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  customerHistorySql,
  customerHistoryLinesSql,
  observedHistoryTables,
  type HistoryLayout,
} from '../../src/modules/customer-history/sql.js';
import { customerHistoryFixtures, type HistoryFixture } from './fixtures.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';

const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFilename || !isAbsolute(keyFilename)) throw new Error('READ_ONLY_KEY_PATH_REQUIRED');
const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1', keyFilename });
const artifact = z
  .object({
    scope: z.literal('generated-local-fixtures-only'),
    source: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    vectors: z.array(z.object({ name: z.string(), expected: z.record(z.string(), z.unknown()) })),
  })
  .parse(
    JSON.parse(
      await readFile('parity/evidence/customer-history/native-fixtures.json', 'utf8'),
    ) as unknown,
  );
const projectionReview = await readFile('parity/customer-history-projection-review.sql', 'utf8'),
  npsProjection = projectionReview
    .slice(projectionReview.lastIndexOf('\nSELECT MOD('))
    .trim()
    .replace(/;$/, '');
if (
  !npsProjection.startsWith('SELECT MOD(o.user_id,1024) AS customer_bucket,nf.id,nf.order_id,') ||
  npsProjection.includes(';')
)
  throw new Error('REVIEW_NPS_PROJECTION_INVALID');
const fields = {
  orders: {
    id: 'INT64',
    user_id: 'INT64',
    order_amt: 'FLOAT64',
    created_at: 'DATETIME',
    order_status: 'INT64',
  },
  order_stores: { id: 'INT64', order_id: 'INT64' },
  has_products: {
    id: 'INT64',
    order_id: 'INT64',
    prod_id: 'INT64',
    sub_prod_id: 'INT64',
    qty: 'INT64',
    price: 'FLOAT64',
  },
  products: { id: 'INT64', parent_prod_id: 'INT64', product: 'STRING', price: 'FLOAT64' },
  nps_feedback: { id: 'INT64', order_id: 'INT64', feedback_answer: 'STRING' },
} as const;
type FixtureRow = Readonly<Record<string, string | number | null>>;
const rows = (data: HistoryFixture, table: keyof typeof fields) => data[table] as FixtureRow[];
function ctes(data: HistoryFixture, layout: HistoryLayout) {
  return Object.entries(fields)
    .map(([name, sourceColumns]) => {
      const table = name as keyof typeof fields,
        bucketed = layout === 'customer-bucket-v1' && table !== 'products',
        columns = bucketed ? { ...sourceColumns, customer_bucket: 'INT64' } : sourceColumns;
      const selected = rows(data, table).map((record) => {
          if (!bucketed) return record;
          const owner =
            table === 'orders'
              ? record.user_id
              : data.orders.find((order) => order.id === record.order_id)?.user_id;
          return {
            ...record,
            customer_bucket:
              owner === null || owner === undefined ? null : (BigInt(owner) % 1024n).toString(),
          };
        }),
        columnEntries = Object.entries(columns),
        row = (record: FixtureRow) =>
          'STRUCT(' +
          columnEntries
            .map(
              ([key, type]) =>
                `CAST(${record[key] === null ? 'NULL' : JSON.stringify(String(record[key]))} AS ${type}) AS ${key}`,
            )
            .join(',') +
          ')',
        empty =
          'SELECT ' +
          columnEntries.map(([key, type]) => `CAST(NULL AS ${type}) AS ${key}`).join(',') +
          ' FROM UNNEST([1]) AS _fixture WHERE FALSE';
      const source =
        name +
        ' AS (' +
        (selected.length ? 'SELECT * FROM UNNEST([' + selected.map(row).join(',') + '])' : empty) +
        ')';
      if (layout !== 'customer-bucket-v1' || table !== 'nps_feedback') return source;
      const projection = npsProjection
        .replaceAll('`' + observedHistoryTables.orders + '`', 'orders')
        .replaceAll('`' + observedHistoryTables.feedback + '`', 'fixture_source_feedback');
      return (
        source.replace(/^nps_feedback AS/, 'fixture_source_feedback AS') +
        ',nps_feedback AS (' +
        projection +
        ')'
      );
    })
    .join(',');
}
function fixtureSql(query: string, data: HistoryFixture, layout: HistoryLayout) {
  let statement = query;
  for (const [key, table] of Object.entries(observedHistoryTables)) {
    const mapped = {
      orderStores: 'order_stores',
      lines: 'has_products',
      feedback: 'nps_feedback',
      orders: 'orders',
      products: 'products',
    }[key];
    if (!mapped) throw new Error('UNKNOWN_FIXTURE_RELATION');
    statement = statement.replaceAll('`' + table + '`', mapped);
  }
  const synthetic = 'WITH ' + ctes(data, layout) + ',' + statement.replace(/^WITH\s+/, '');
  if (synthetic.includes('`') || synthetic.includes(';'))
    throw new Error('SOURCE_TABLE_REFERENCE_FORBIDDEN');
  return synthetic;
}
function differencePaths(actual: unknown, expected: unknown, path = ''): string[] {
  if (isDeepStrictEqual(actual, expected)) return [];
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return [path + '.length'];
    return actual
      .flatMap((value, index) => differencePaths(value, expected[index], path + '[' + index + ']'))
      .slice(0, 30);
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>,
      b = expected as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .flatMap((key) => differencePaths(a[key], b[key], path + '.' + key))
      .slice(0, 30);
  }
  return [path];
}
const results: {
  index: number;
  name: string;
  layout: HistoryLayout;
  historyMatched: boolean;
  linesMatched: boolean;
  paginationMatched: boolean | null;
  statementSha256: string;
  errorCode: string | null;
  errorPhase: string | null;
  errorLocation: string | null;
  differences: string[];
  scalarDiagnostics: Record<string, unknown>;
}[] = [];
for (const layout of ['raw', 'customer-bucket-v1'] as const)
  for (const [index, data] of customerHistoryFixtures().entries()) {
    const native = artifact.vectors.find((vector) => vector.name === data.name);
    if (!native) throw new Error('NATIVE_FIXTURE_MISSING');
    const statement = fixtureSql(customerHistorySql(observedHistoryTables, layout), data, layout),
      result = {
        index,
        name: data.name,
        layout,
        historyMatched: false,
        linesMatched: false,
        paginationMatched: null as boolean | null,
        statementSha256: createHash('sha256').update(statement).digest('hex'),
        errorCode: null as string | null,
        errorPhase: null as string | null,
        errorLocation: null as string | null,
        differences: [] as string[],
        scalarDiagnostics: {} as Record<string, unknown>,
      };
    let phase = 'history';
    try {
      const [response]: [unknown, ...unknown[]] = await client.query({
        query: statement,
        params: normalizeWarehouseParameters(
          { customer: '7', sourceNow: data.sourceNow, returnBefore: '', pageSize: 101 },
          { customer: 'STRING', sourceNow: 'DATETIME', returnBefore: 'STRING', pageSize: 'INT64' },
        ),
        types: {
          customer: 'STRING',
          sourceNow: 'DATETIME',
          returnBefore: 'STRING',
          pageSize: 'INT64',
        },
        useLegacySql: false,
        maximumBytesBilled: '10485760',
        jobTimeoutMs: 10000,
        labels: { application: 'pos-rewrite', resource: 'customer-history-synthetic' },
      });
      const actual = z.array(z.record(z.string(), z.unknown())).parse(response);
      result.historyMatched = actual.length === 1 && isDeepStrictEqual(actual[0], native.expected);
      result.differences = differencePaths(actual[0], native.expected);
      const a = z
          .object({
            summary: z.object({ last30DaysOrders: z.string(), npsScore: z.number().nullable() }),
          })
          .parse(actual[0]),
        e = z
          .object({
            summary: z.object({ last30DaysOrders: z.string(), npsScore: z.number().nullable() }),
          })
          .parse(native.expected);
      result.scalarDiagnostics = {
        last30Days: [a.summary.last30DaysOrders, e.summary.last30DaysOrders],
        nps: [a.summary.npsScore, e.summary.npsScore],
      };
      phase = 'lines';
      const selected = data.orders
          .filter((row) => row.user_id === '7')
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))[0],
        orderId = selected?.id || '1',
        lineStatement = fixtureSql(
          customerHistoryLinesSql(observedHistoryTables, layout),
          data,
          layout,
        ),
        [lineResponse]: [unknown, ...unknown[]] = await client.query({
          query: lineStatement,
          params: normalizeWarehouseParameters(
            { customer: '7', order: orderId, before: '', pageSize: 101 },
            { customer: 'STRING', order: 'STRING', before: 'STRING', pageSize: 'INT64' },
          ),
          types: { customer: 'STRING', order: 'STRING', before: 'STRING', pageSize: 'INT64' },
          useLegacySql: false,
          maximumBytesBilled: '10485760',
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'customer-history-lines-synthetic' },
        });
      const lineActual = z.array(z.record(z.string(), z.unknown())).parse(lineResponse),
        expected = {
          orderFound: !!selected,
          items: data.has_products
            .filter(
              (row) =>
                row.order_id === orderId &&
                data.products.some((product) => product.id === row.prod_id),
            )
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
            .slice(0, 101)
            .map((row) => ({
              id: row.id,
              productId: row.prod_id,
              name: data.products.find((product) => product.id === row.prod_id)!.product,
            })),
        };
      result.linesMatched = lineActual.length === 1 && isDeepStrictEqual(lineActual[0], expected);
      if (data.name === 'return-pagination-and-same-day-ties') {
        phase = 'pagination';
        const ordered = z
            .array(z.object({ id: z.string() }).passthrough())
            .parse(native.expected.returnedRows),
          anchor = ordered[2]!.id,
          historyParams = {
            customer: '7',
            sourceNow: data.sourceNow,
            returnBefore: anchor,
            pageSize: 3,
          },
          historyTypes = {
            customer: 'STRING',
            sourceNow: 'DATETIME',
            returnBefore: 'STRING',
            pageSize: 'INT64',
          };
        const [historyPage]: [unknown, ...unknown[]] = await client.query({
          query: statement,
          params: normalizeWarehouseParameters(historyParams, historyTypes),
          types: historyTypes,
          useLegacySql: false,
          maximumBytesBilled: '10485760',
          jobTimeoutMs: 10000,
          labels: { application: 'pos-rewrite', resource: 'customer-history-page-synthetic' },
        });
        const lineAnchor = expected.items[4]!.id,
          lineParams = { customer: '7', order: orderId, before: lineAnchor, pageSize: 3 },
          lineTypes = { customer: 'STRING', order: 'STRING', before: 'STRING', pageSize: 'INT64' },
          [linePage]: [unknown, ...unknown[]] = await client.query({
            query: lineStatement,
            params: normalizeWarehouseParameters(lineParams, lineTypes),
            types: lineTypes,
            useLegacySql: false,
            maximumBytesBilled: '10485760',
            jobTimeoutMs: 10000,
            labels: {
              application: 'pos-rewrite',
              resource: 'customer-history-lines-page-synthetic',
            },
          });
        result.paginationMatched =
          isDeepStrictEqual(historyPage, [
            {
              ...native.expected,
              returnedRows: ordered.filter((row) => BigInt(row.id) < BigInt(anchor)).slice(0, 3),
            },
          ]) &&
          isDeepStrictEqual(linePage, [
            {
              orderFound: true,
              items: expected.items
                .filter((row) => BigInt(row.id) < BigInt(lineAnchor))
                .slice(0, 3),
            },
          ]);
      }
      if (!result.historyMatched || !result.linesMatched || result.paginationMatched === false)
        result.errorCode = 'GENERATED_FIXTURE_DIFFERENCE';
    } catch (error) {
      result.errorCode = 'GENERATED_FIXTURE_QUERY_FAILED';
      result.errorPhase = phase;
      const diag = z
        .object({
          errors: z
            .array(
              z.object({
                location: z
                  .string()
                  .regex(/^\[?\d+:\d+\]?$/)
                  .optional(),
              }),
            )
            .optional(),
        })
        .safeParse(error);
      if (diag.success) result.errorLocation = diag.data.errors?.[0]?.location || null;
      if (error instanceof Error) {
        const classes: [RegExp, string][] = [
          [/Array cannot have a null element/i, 'NULL_ARRAY_ELEMENT'],
          [/too many subqueries|query is too complex/i, 'QUERY_COMPLEXITY_LIMIT'],
          [/Unrecognized name/i, 'INVALID_COLUMN_REFERENCE'],
          [/Syntax error/i, 'INVALID_QUERY_SYNTAX'],
          [/Could not cast|Invalid cast|Bad int64 value/i, 'INVALID_FIXTURE_CAST'],
          [/Cannot read properties/i, 'SDK_RESULT_DECODE_FAILED'],
          [/Resources exceeded/i, 'QUERY_RESOURCE_LIMIT'],
          [/timeout|deadline/i, 'QUERY_TIMEOUT'],
        ];
        result.errorCode =
          classes.find(([pattern]) => pattern.test(error.message))?.[1] || result.errorCode;
        result.errorLocation = /\[(\d+:\d+)\]/.exec(error.message)?.[1] || result.errorLocation;
      }
    }
    results.push(result);
  }
const file = 'parity/evidence/customer-history/bigquery-fixtures.json',
  temporary = file + '.' + randomUUID() + '.tmp';
await writeFile(
  temporary,
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      scope: 'executed-generated-literal-select-only',
      sourceRowsRead: 0,
      cloudWrites: 0,
      reviewProjectionSha256: createHash('sha256').update(projectionReview).digest('hex'),
      results,
      limitations: [
        'Actual BigQuery execution uses only generated fixture CTE literals, never source tables.',
        'Partitioned NPS input executes the exact review-file numeric-prefix SELECT against generated CTE rows.',
        'Same-day recent-order ties use the documented ID-desc candidate policy, not a claim of deterministic source tie ordering.',
        'This does not certify live CDC completeness, source float encoding, deployment cost or financial as-of consistency.',
      ],
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
await rename(temporary, file);
process.stdout.write(
  JSON.stringify({
    evidence: file,
    cases: results.length,
    matched: results.filter((result) => !result.errorCode).length,
    failedIndices: results.filter((result) => result.errorCode).map((result) => result.index),
  }) + '\n',
);
if (results.some((result) => result.errorCode)) process.exitCode = 1;
