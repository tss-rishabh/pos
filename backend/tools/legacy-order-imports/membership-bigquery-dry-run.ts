/** Optional user-authorized compile-only check. Literal fixtures, no source
 * data/DDL/DML/exports, no credential-file reads outside the Google SDK. */
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import {
  csvMembershipHistorySql,
  csvMembershipWarehouse,
} from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import {
  membershipBigQueryFixture,
  membershipFixtureOrder,
  membershipHistoryOptions,
  membershipHistoryScope,
} from '../../tests/legacy-order-imports/membership-bigquery-fixtures.js';

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const text = (value: string) => quote(value);
const wall = (value: string) => 'DATETIME ' + quote(value);
const stamp = (value: string) => 'TIMESTAMP ' + quote(value);
function select(fields: Record<string, string>) {
  return (
    'SELECT ' +
    Object.entries(fields)
      .map(([name, value]) => value + ' AS ' + name)
      .join(',') +
    ' FROM UNNEST([1]) AS fixture_singleton'
  );
}
export function membershipHistoryLiteralSql(empty = false) {
  const fixture = membershipBigQueryFixture(empty ? [] : undefined),
    pub = fixture.envelope.publications[0]!;
  const publication = select({
    contract: text(pub.contract),
    generation_id: text(pub.generationId),
    customer_id: text(pub.customerId),
    as_of: wall(pub.asOf),
    cutoff: wall(pub.cutoff),
    source_time_zone: text(pub.sourceTimeZone),
    source_snapshot_id: text(pub.sourceSnapshotId),
    source_snapshot_at: stamp(pub.sourceSnapshotAt),
    source_cdc_through: stamp(pub.sourceCdcThrough),
    published_at: stamp(pub.publishedAt),
    source_complete: 'TRUE',
    source_order_count: pub.sourceOrderCount,
    warehouse_order_count: pub.warehouseOrderCount,
    source_selected_order_count: pub.sourceSelectedOrderCount,
    warehouse_selected_order_count: pub.warehouseSelectedOrderCount,
    source_line_count: pub.sourceLineCount,
    warehouse_line_count: pub.warehouseLineCount,
    source_history_hash: text(pub.sourceHistoryHash),
    warehouse_history_hash: text(pub.warehouseHistoryHash),
    signature: text(pub.signature),
  });
  const orders = (empty ? [membershipFixtureOrder()] : fixture.all)
    .map(
      (row) =>
        select({
          generation_id: text(pub.generationId),
          customer_id: text(row.customerId),
          order_id: text(row.id),
          payment_method: String(row.paymentMethod),
          order_status: String(row.orderStatus),
          created_at: wall(row.createdAt),
        }) + (empty ? ' WHERE FALSE' : ''),
    )
    .join(' UNION ALL ');
  const sourceLines = (empty ? [membershipFixtureOrder()] : fixture.all).flatMap((row) =>
    row.lines.map((line) => ({ customerId: row.customerId, orderId: row.id, ...line })),
  );
  const lines = sourceLines
    .map(
      (row) =>
        select({
          generation_id: text(pub.generationId),
          customer_id: text(row.customerId),
          order_id: text(row.orderId),
          line_id: text(row.lineId),
          product_id: text(row.productId),
          is_exclusive_order: String(row.isExclusiveOrder),
        }) + (empty ? ' WHERE FALSE' : ''),
    )
    .join(' UNION ALL ');
  let statement = csvMembershipHistorySql(
    membershipHistoryOptions,
    membershipHistoryScope,
  ).statement.replace(
    'WITH publications AS',
    `WITH fixture_publications AS(${publication}),fixture_orders AS(${orders}),fixture_lines AS(${lines}),publications AS`,
  );
  for (const [view, replacement] of [
    [membershipHistoryOptions.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW!, 'fixture_publications'],
    [membershipHistoryOptions.BQ_CSV_MEMBERSHIP_ORDERS_VIEW!, 'fixture_orders'],
    [membershipHistoryOptions.BQ_CSV_MEMBERSHIP_LINES_VIEW!, 'fixture_lines'],
  ])
    statement = statement.replaceAll('`' + view + '`', replacement!);
  if (
    statement.includes('`') ||
    /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL)\b/i.test(statement)
  )
    throw new Error('Unsafe qualification statement');
  return statement;
}
function classification(error: unknown) {
  const parsed = z.object({ code: z.number().int().optional() }).safeParse(error);
  const code = parsed.success ? parsed.data.code : undefined;
  if (code === 401 || code === 403) return 'authorization';
  if (code === 400) return 'query-definition';
  if (code === 429) return 'budget-or-quota';
  return 'unavailable';
}
function diagnostic(error: unknown) {
  const parsed = z.object({ message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? (parsed.data.message ?? '') : '';
  const location = /\[(\d{1,5}):(\d{1,5})\]/.exec(message);
  return {
    line: location ? Number(location[1]) : null,
    column: location ? Number(location[2]) : null,
    terms: [
      'syntax',
      'unrecognized',
      'correlated',
      'subquery',
      'parameter',
      'type',
      'array',
      'struct',
      'reserved',
      'group',
      'limit',
      'order',
      'datetime',
      'timestamp',
      'union',
      'column',
      'count',
      'select',
      'table',
      'duplicate',
      'ambiguous',
      'unsupported',
      'nested',
      'quantifier',
      'distinct',
      'value',
      'argument',
      'invalid',
      'missing',
      'conversion',
      'name',
      'found',
      'query',
      'requires',
      'incompatible',
      'allow',
      'from',
      'expression',
      'without',
      'expected',
      'got',
      'function',
      'aggregate',
      'alias',
    ].filter((term) => message.toLowerCase().includes(term)),
  };
}
if (process.argv[1]?.endsWith('membership-bigquery-dry-run.ts')) {
  const event = {
    module: 'administration',
    resource: 'csv-membership-history-qualification',
    requestId: null,
    userId: null,
  };
  if (!process.argv.includes('--live')) {
    process.stdout.write(
      JSON.stringify({
        ...event,
        eventId: 'administration.csv-membership-history-qualification.disabled',
      }) + '\n',
    );
  } else {
    try {
      // The SDK alone opens ADC. Never read, copy or print the file contents.
      const client = new BigQuery({
        projectId: csvMembershipWarehouse.project,
        location: csvMembershipWarehouse.location,
        autoRetry: false,
        maxRetries: 0,
      });
      client.timeout = 8000;
      const results: { name: string; estimatedBytes: string }[] = [];
      for (const empty of [false, true]) {
        const input = csvMembershipHistorySql(membershipHistoryOptions, membershipHistoryScope),
          query = membershipHistoryLiteralSql(empty);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Qualification deadline')), 10000);
        });
        try {
          const [job] = await Promise.race([
            client.createQueryJob({
              query,
              params: normalizeWarehouseParameters(input.params, input.types),
              types: input.types,
              dryRun: true,
              useLegacySql: false,
              useQueryCache: false,
              maximumBytesBilled: '1000000',
              jobTimeoutMs: 8000,
              labels: { application: 'pos-rewrite', resource: 'csv-membership-history-fixture' },
            }),
            deadline,
          ]);
          const parsed = z
            .object({
              statistics: z.object({
                query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
              }),
            })
            .parse(job.metadata);
          if (BigInt(parsed.statistics.query.totalBytesProcessed) > 1000000n)
            throw new Error('Qualification budget');
          results.push({
            name: empty ? 'signed-empty-snapshot' : 'signed-complete-snapshot',
            estimatedBytes: parsed.statistics.query.totalBytesProcessed,
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      process.stdout.write(
        JSON.stringify({
          ...event,
          eventId: 'administration.csv-membership-history-qualification.completed',
          mode: 'dry-run-only',
          checks: results,
        }) + '\n',
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          ...event,
          eventId: 'administration.csv-membership-history-qualification.failed',
          classification: classification(error),
          diagnostic: diagnostic(error),
        }) + '\n',
      );
      process.exitCode = 1;
    }
  }
}
