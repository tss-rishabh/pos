import { BigQuery } from '@google-cloud/bigquery';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  customerHistorySql,
  customerHistoryLinesSql,
} from '../../src/modules/customer-history/sql.js';
import type { HistoryStatement } from '../../src/modules/customer-history/gateway.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';

const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFilename || !isAbsolute(keyFilename)) throw new Error('READ_ONLY_KEY_PATH_REQUIRED');
const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1', keyFilename }),
  budget = 1000000000n;
const statements: HistoryStatement[] = [
  {
    resource: 'customer-history',
    statement: customerHistorySql(),
    params: { customer: '7', sourceNow: '2026-11-16 20:30:00', returnBefore: '', pageSize: 26 },
    types: { customer: 'STRING', sourceNow: 'DATETIME', returnBefore: 'STRING', pageSize: 'INT64' },
  },
  {
    resource: 'customer-history-lines',
    statement: customerHistoryLinesSql(),
    params: { customer: '7', order: '9007199254740993', before: '', pageSize: 51 },
    types: { customer: 'STRING', order: 'STRING', before: 'STRING', pageSize: 'INT64' },
  },
];
const results: {
  resource: string;
  statementSha256: string;
  estimatedBytes: string | null;
  overConfiguredBudget: boolean | null;
  errorCode: string | null;
  errorLocation: string | null;
}[] = [];
for (const entry of statements) {
  const result = {
    resource: entry.resource,
    statementSha256: createHash('sha256').update(entry.statement).digest('hex'),
    estimatedBytes: null as string | null,
    overConfiguredBudget: null as boolean | null,
    errorCode: null as string | null,
    errorLocation: null as string | null,
  };
  try {
    const [job] = await client.createQueryJob({
      query: entry.statement,
      params: normalizeWarehouseParameters(entry.params, entry.types),
      types: entry.types,
      dryRun: true,
      useLegacySql: false,
      maximumBytesBilled: String(budget),
      jobTimeoutMs: 10000,
      labels: { application: 'pos-rewrite', resource: entry.resource },
    });
    const metadata = z
      .object({
        statistics: z.object({
          query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
        }),
      })
      .parse(job.metadata);
    result.estimatedBytes = metadata.statistics.query.totalBytesProcessed;
    result.overConfiguredBudget = BigInt(result.estimatedBytes) > budget;
  } catch (error) {
    result.errorCode = 'QUERY_DRY_RUN_FAILED';
    const diagnostic = z
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
    if (diagnostic.success) result.errorLocation = diagnostic.data.errors?.[0]?.location || null;
  }
  results.push(result);
}
const artifact = {
    checkedAt: new Date().toISOString(),
    scope: { project: 'tssgcp2025', dataset: 'tss_mysql_raw_layer', location: 'asia-south1' },
    configuredBudgetBytes: String(budget),
    results,
    rawRowsRead: 0,
    cloudWrites: 0,
    limitations: [
      'Dry-run metadata only; no source or customer row selected.',
      'A successful dry run does not certify CDC consistency or source parity.',
      'Over-budget readers require an optimized projection/cluster deployment; no automatic byte-cap increase or MySQL history fallback.',
    ],
  },
  file = 'evidence/bigquery-customer-history-dry-run.json',
  temporary = file + '.' + randomUUID() + '.tmp';
await writeFile(temporary, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 });
await rename(temporary, file);
process.stdout.write(JSON.stringify({ evidence: file, results }) + '\n');
if (results.some((result) => result.errorCode)) process.exitCode = 1;
