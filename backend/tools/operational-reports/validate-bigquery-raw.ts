import { BigQuery } from '@google-cloud/bigquery';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import {
  rawLegacyExportProjection,
  rawLegacyExportValidationQuery,
  observedLegacyExportRawTable,
} from '../../src/modules/operational-reports/raw-legacy-export.js';

const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFilename || !isAbsolute(keyFilename)) throw new Error('READ_ONLY_READER_KEY_PATH_REQUIRED');
const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1', keyFilename });
const query = rawLegacyExportValidationQuery(),
  params = {
    start: '2026-11-01 00:00:00',
    end: '2026-11-02 00:00:00',
    allOwners: false,
    owner: '44',
    limit: 25,
  },
  types = {
    start: 'DATETIME',
    end: 'DATETIME',
    allOwners: 'BOOL',
    owner: 'STRING',
    limit: 'INT64',
  };
const result: {
  checkedAt: string;
  scope: { project: string; dataset: string; location: string };
  source: string;
  dryRun: unknown;
  syntheticFixture: unknown;
  errors: string[];
  limitations: string[];
} = {
  checkedAt: new Date().toISOString(),
  scope: { project: 'tssgcp2025', dataset: 'tss_mysql_raw_layer', location: 'asia-south1' },
  source: observedLegacyExportRawTable,
  dryRun: null,
  syntheticFixture: null,
  errors: [],
  limitations: [
    'The raw source query is dry-run only; no raw export, customer or operator row was selected.',
    'The executed SELECT contains only generated fixture literals; no source table is referenced.',
    'Successful type/payload validation is not source CDC completeness, publication, collation or production parity certification. No DDL, UDF/view creation or export was executed.',
  ],
};
try {
  const [job] = await client.createQueryJob({
    query,
    params: normalizeWarehouseParameters(params, types),
    types,
    dryRun: true,
    useLegacySql: false,
    maximumBytesBilled: '10485760',
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'raw-export-schema-validation' },
  });
  const metadata = z
    .object({
      statistics: z.object({
        query: z.object({
          totalBytesProcessed: z.string().optional(),
          schema: z
            .object({ fields: z.array(z.object({ name: z.string(), type: z.string() })) })
            .optional(),
        }),
      }),
    })
    .parse(job.metadata);
  result.dryRun = {
    statementSha256: createHash('sha256').update(query).digest('hex'),
    estimatedBytes: metadata.statistics.query.totalBytesProcessed || null,
    fields: metadata.statistics.query.schema?.fields || [],
  };
} catch {
  result.errors.push('RAW_EXPORT_DRY_RUN_FAILED');
}
const fixture = `WITH fixture_source AS (
  SELECT CAST('9007199254740993' AS INT64) AS id,'' AS report_name,'fixture-kind' AS report_type,CAST(NULL AS STRING) AS time_period,1 AS is_completed,'FAILED' AS export_status,CAST('9007199254740995' AS INT64) AS export_requested_by,DATETIME '2026-11-01 10:00:00' AS export_requested_at,CAST(NULL AS DATETIME) AS export_completed_at,DATETIME '2026-11-01 11:00:00' AS updated_at,'CSV' AS export_format,2147483647 AS export_size,9 AS export_rows_count
  UNION ALL SELECT 2,'Fixture title','fixture-kind','',0,'error',44,DATETIME '2026-11-01 10:00:00',DATETIME '2026-11-01 12:00:00',DATETIME '2026-11-01 11:00:00','CSV',0,0
  UNION ALL SELECT 3,'','','2026-11-01 - 2026-11-02',0,'RUNNING',44,DATETIME '2026-11-01 10:00:00',NULL,NULL,'CSV',1,0
), projected AS (${rawLegacyExportProjection('fixture_source')})
SELECT id,report_name,time_period,status,operator_id,byte_count,CAST(terminal_at AS STRING) AS terminal_at FROM projected ORDER BY CAST(id AS INT64)`;
try {
  const [rows]: [unknown, ...unknown[]] = await client.query({
    query: fixture,
    useLegacySql: false,
    maximumBytesBilled: '1048576',
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'raw-export-synthetic-validation' },
  });
  const parsed = z
    .array(
      z.object({
        id: z.string(),
        report_name: z.string(),
        time_period: z.string().nullable(),
        status: z.string(),
        operator_id: z.string(),
        byte_count: z.number().int().safe(),
        terminal_at: z.string(),
      }),
    )
    .parse(rows);
  const expected = [
    {
      id: '2',
      report_name: 'Fixture title',
      time_period: '',
      status: 'FAILED',
      operator_id: '44',
      byte_count: 0,
      terminal_at: '2026-11-01 12:00:00',
    },
    {
      id: '3',
      report_name: 'Legacy report',
      time_period: '2026-11-01 - 2026-11-02',
      status: 'QUEUED',
      operator_id: '44',
      byte_count: 1024,
      terminal_at: '2026-11-01 10:00:00',
    },
    {
      id: '9007199254740993',
      report_name: 'fixture-kind',
      time_period: null,
      status: 'COMPLETED',
      operator_id: '9007199254740995',
      byte_count: 2199023254528,
      terminal_at: '2026-11-01 11:00:00',
    },
  ];
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error('FIXTURE_MISMATCH');
  result.syntheticFixture = {
    cases: 3,
    verified: true,
    statementSha256: createHash('sha256').update(fixture).digest('hex'),
    properties: [
      '64bit string identities',
      'completion flag precedence',
      'error normalization',
      'empty-name fallback',
      'KiB-to-byte arithmetic',
      'DATETIME terminal fallback',
      'original source period NULL/empty/literal values',
    ],
  };
} catch {
  result.errors.push('RAW_EXPORT_SYNTHETIC_FIXTURE_FAILED');
}
const filename = 'evidence/bigquery-raw-projection-validation.json',
  temporary = filename + '.' + randomUUID() + '.tmp';
await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
await rename(temporary, filename);
process.stdout.write(
  JSON.stringify({
    evidence: filename,
    dryRun: result.dryRun !== null,
    syntheticFixture: result.syntheticFixture !== null,
    errors: result.errors,
  }) + '\n',
);
if (result.errors.length) process.exitCode = 1;
