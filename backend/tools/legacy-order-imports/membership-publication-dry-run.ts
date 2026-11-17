/** Optional compile-only candidate-control SQL check, with generated literals.
 * No table rows, writes, uploads, source connection or key-file byte access. */
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { csvMembershipWarehouse } from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import {
  csvMembershipCandidateSql,
  csvMembershipWarehouseCandidateContract,
} from '../../src/modules/legacy-order-imports/membership-profile/publication-warehouse.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import { membershipHistoryOptions } from '../../tests/legacy-order-imports/membership-bigquery-fixtures.js';
import {
  membershipCandidateView,
  sourceCaptureFixture,
} from '../../tests/legacy-order-imports/membership-publication-fixtures.js';
import { membershipHistoryLiteralSql } from './membership-bigquery-dry-run.js';

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export function membershipCandidateLiteralSql(empty = false) {
  const capture = sourceCaptureFixture(empty ? [] : undefined),
    definition = csvMembershipCandidateSql(
      membershipHistoryOptions,
      membershipCandidateView,
      capture,
    );
  const reader = membershipHistoryLiteralSql(empty),
    end = reader.indexOf(',publications AS');
  if (end < 0) throw new Error('Fixture definition changed');
  const control =
    'SELECT ' +
    Object.entries({
      scope_shard: String(Number(BigInt(capture.scope.customerId) % 1024n)),
      contract: quote(csvMembershipWarehouseCandidateContract),
      generation_id: quote(capture.generationId),
      customer_id: quote(capture.scope.customerId),
      as_of: 'DATETIME ' + quote(capture.scope.asOf),
      cutoff: 'DATETIME ' + quote(capture.scope.cutoff),
      source_time_zone: quote(capture.sourceTimeZone),
      source_snapshot_id: quote(capture.sourceSnapshotId),
      source_capture_hash: quote(capture.signature),
      source_cdc_through: "TIMESTAMP '2026-11-17T06:30:02.000000Z'",
      candidate_complete: 'TRUE',
    })
      .map(([name, value]) => value + ' AS ' + name)
      .join(',') +
    ' FROM UNNEST([1]) AS singleton';
  let statement =
    reader.slice(0, end) +
    ',fixture_candidates AS(' +
    control +
    '),' +
    definition.statement.slice('WITH '.length);
  for (const [name, value] of [
    [membershipCandidateView, 'fixture_candidates'],
    [membershipHistoryOptions.BQ_CSV_MEMBERSHIP_ORDERS_VIEW!, 'fixture_orders'],
    [membershipHistoryOptions.BQ_CSV_MEMBERSHIP_LINES_VIEW!, 'fixture_lines'],
  ])
    statement = statement.replaceAll('`' + name + '`', value!);
  if (
    statement.includes('`') ||
    /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL)\b/i.test(statement)
  )
    throw new Error('Unsafe fixture definition');
  return { ...definition, statement };
}
if (process.argv[1]?.endsWith('membership-publication-dry-run.ts')) {
  const event = {
    module: 'administration',
    resource: 'membership-publication-qualification',
    requestId: null,
    userId: null,
  };
  if (!process.argv.includes('--live'))
    process.stdout.write(
      JSON.stringify({
        ...event,
        eventId: 'administration.membership-publication-qualification.disabled',
      }) + '\n',
    );
  else {
    try {
      const client = new BigQuery({
        projectId: csvMembershipWarehouse.project,
        location: csvMembershipWarehouse.location,
        autoRetry: false,
        maxRetries: 0,
      });
      client.timeout = 8000;
      const checks: { name: string; estimatedBytes: string }[] = [];
      for (const empty of [false, true]) {
        const input = membershipCandidateLiteralSql(empty);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Fixture timeout')), 10000);
          });
          const [job] = await Promise.race([
            client.createQueryJob({
              query: input.statement,
              params: normalizeWarehouseParameters(input.params, input.types),
              types: input.types,
              dryRun: true,
              useLegacySql: false,
              useQueryCache: false,
              maximumBytesBilled: '1000000',
              jobTimeoutMs: 8000,
              labels: { application: 'pos-rewrite', resource: 'membership-publication-fixture' },
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
            throw new Error('Fixture budget');
          checks.push({
            name: empty ? 'empty-candidate' : 'complete-candidate',
            estimatedBytes: parsed.statistics.query.totalBytesProcessed,
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      process.stdout.write(
        JSON.stringify({
          ...event,
          eventId: 'administration.membership-publication-qualification.completed',
          mode: 'dry-run-only',
          checks,
        }) + '\n',
      );
    } catch (error) {
      const parsed = z
          .object({ code: z.number().int().optional(), message: z.string().optional() })
          .safeParse(error),
        code = parsed.success ? parsed.data.code : undefined,
        message = parsed.success ? (parsed.data.message ?? '') : '',
        point = /\[(\d{1,5}):(\d{1,5})\]/.exec(message);
      process.stdout.write(
        JSON.stringify({
          ...event,
          eventId: 'administration.membership-publication-qualification.failed',
          classification:
            code === 400
              ? 'query-definition'
              : code === 401 || code === 403
                ? 'authorization'
                : 'unavailable',
          line: point ? Number(point[1]) : null,
          column: point ? Number(point[2]) : null,
        }) + '\n',
      );
      process.exitCode = 1;
    }
  }
}
