/** Exact, bounded metadata-only check. No source application rows are selected. */
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
async function main() {
  if (process.argv[2] !== '--read-only' || !process.env.BQ_COUPON_HISTORY_VALIDATION_KEY_FILE)
    throw Error('EXPLICIT_READ_ONLY_REQUIRED');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.BQ_COUPON_HISTORY_VALIDATION_KEY_FILE;
  const client = new BigQuery({
    projectId: 'tssgcp2025',
    location: 'asia-south1',
    autoRetry: false,
    maxRetries: 0,
  });
  client.timeout = 10000;
  const tick = String.fromCharCode(96);
  const query =
    'SELECT table_name FROM ' +
    tick +
    'tssgcp2025.tss_mysql_raw_layer.INFORMATION_SCHEMA.TABLES' +
    tick +
    " WHERE table_name IN ('tss_order_coupon_log','order_coupon_log','tss_order_coupon_logs') LIMIT 4";
  const [estimate] = await client.createQueryJob({
    query,
    dryRun: true,
    useLegacySql: false,
    useQueryCache: false,
    maximumBytesBilled: '50000000',
    jobTimeoutMs: 10000,
    location: 'asia-south1',
  });
  const bytes = BigInt(
    z
      .object({
        statistics: z.object({
          query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
        }),
      })
      .parse(estimate.metadata).statistics.query.totalBytesProcessed,
  );
  if (bytes > 50000000n) throw Error('METADATA_BUDGET');
  const [job] = await client.createQueryJob({
    query,
    useLegacySql: false,
    useQueryCache: false,
    maximumBytesBilled: '50000000',
    jobTimeoutMs: 10000,
    location: 'asia-south1',
  });
  try {
    const [rows, next, response] = await job.getQueryResults({
      autoPaginate: false,
      maxApiCalls: 1,
      maxResults: 4,
      timeoutMs: 10000,
    });
    if (next || !response?.jobComplete || response.pageToken) throw Error('METADATA_INCOMPLETE');
    const names = z
      .array(
        z
          .object({
            table_name: z.enum([
              'tss_order_coupon_log',
              'order_coupon_log',
              'tss_order_coupon_logs',
            ]),
          })
          .strict(),
      )
      .max(3)
      .parse(rows);
    process.stdout.write(
      JSON.stringify({
        resource: 'coupon-history-metadata',
        checkedAt: new Date().toISOString(),
        tables: names.map((row) => row.table_name),
        estimatedBytes: bytes.toString(),
        sourceRowsRead: 0,
        writes: 0,
      }) + '\n',
    );
  } catch (error) {
    void job.cancel().catch(() => undefined);
    throw error;
  }
}
void main().catch(() => {
  process.stderr.write(
    JSON.stringify({ resource: 'coupon-history-metadata', code: 'READ_ONLY_METADATA_FAILED' }) +
      '\n',
  );
  process.exitCode = 1;
});
