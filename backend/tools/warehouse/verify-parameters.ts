import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { warehouseService } from '../../src/modules/warehouse.js';
import { AppError } from '../../src/domain/errors.js';

// One generated-literal SELECT only. No dataset table, DDL, export or source row.
if (
  process.argv.length !== 2 ||
  !process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  !isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
)
  throw new Error('READ_ONLY_READER_KEY_PATH_REQUIRED');
const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
  SESSION_SECRET: randomBytes(48).toString('base64url'),
  BIGQUERY_PROJECT_ID: 'tssgcp2025',
  BIGQUERY_LOCATION: 'asia-south1',
  BIGQUERY_MAX_BYTES_BILLED: '1048576',
});
const query = `SELECT CAST(@day AS STRING) AS day,
  CAST(@moment AS STRING) AS moment,
  FORMAT_TIME('%H:%M:%E6S',@clock) AS clock,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',@instant,'UTC') AS instant,
  (SELECT COUNTIF(value=@day) FROM UNNEST(@days) AS value) AS date_matches,
  @missing IS NULL AS preserves_null,
  ST_EQUALS(@location,ST_GEOGPOINT(72.8777,19.0760)) AS geography_matches`;
const params = {
  day: '2026-11-01',
  moment: '2026-11-01 13:00:00.123456',
  clock: '13:00:00.123456',
  instant: '2026-11-01T07:30:00.123456Z',
  days: ['2026-11-01', null, '2026-11-02'],
  missing: null,
  location: 'POINT(72.8777 19.0760)',
};
const types = {
  day: 'DATE',
  moment: 'DATETIME',
  clock: 'TIME',
  instant: 'TIMESTAMP',
  days: ['DATE'],
  missing: 'DATE',
  location: 'GEOGRAPHY',
};
let passed = false;
let failureCode: string | null = null;
let failedFields: string[] = [];
try {
  const rows = await warehouseService(config).queryReport(
    query,
    params,
    types,
    'warehouse-parameter-validation',
  );
  const expected = z.tuple([
    z
      .object({
        day: z.literal('2026-11-01'),
        moment: z.literal('2026-11-01 13:00:00.123456'),
        clock: z.literal('13:00:00.123456'),
        instant: z.literal('2026-11-01T07:30:00.123456Z'),
        date_matches: z.literal(1),
        preserves_null: z.literal(true),
        geography_matches: z.literal(true),
      })
      .strict(),
  ]);
  const result = expected.safeParse(rows);
  passed = result.success;
  if (!result.success)
    failedFields = result.error.issues.map((issue) => issue.path.join('.')).slice(0, 10);
} catch (error) {
  failureCode = error instanceof AppError ? error.code : 'VALIDATION_FAILED';
  // Provider/authentication/query text and credentials never enter evidence.
}
const evidence = {
  checkedAt: new Date().toISOString(),
  project: 'tssgcp2025',
  location: 'asia-south1',
  scope: 'shared-warehouse-generated-literal-select-only',
  sourceRowsRead: false,
  passed,
  failureCode,
  failedFields,
  fields: 7,
  configuredMaximumBytesBilled: config.BIGQUERY_MAX_BYTES_BILLED,
  statementSha256: createHash('sha256').update(query).digest('hex'),
  normalizerSha256: createHash('sha256')
    .update(await readFile(new URL('../../src/modules/warehouse-parameters.ts', import.meta.url)))
    .digest('hex'),
  warehouseSha256: createHash('sha256')
    .update(await readFile(new URL('../../src/modules/warehouse.ts', import.meta.url)))
    .digest('hex'),
  types,
};
const filename = 'evidence/bigquery-parameter-validation.json',
  temporary = filename + '.' + randomUUID() + '.tmp';
await writeFile(temporary, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
await rename(temporary, filename);
process.stdout.write(
  JSON.stringify({
    module: 'warehouse',
    resource: 'query-parameter-validation',
    eventId: 'warehouse.query-parameter-validation.' + (passed ? 'completed' : 'failed'),
    eventInstanceId: randomUUID(),
    requestId: null,
    userId: null,
    passed,
    evidence: filename,
  }) + '\n',
);
if (!passed) process.exitCode = 1;
