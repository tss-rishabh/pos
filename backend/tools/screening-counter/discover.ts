/** One bounded exact-name metadata read. Never reads source rows/key bytes. */
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
let stage = 'configuration';
async function main() {
  if (process.env.SCREENING_COUNTER_DIAGNOSTIC_FIXTURE === 'credential-error') {
    stage = 'synthetic-private-error';
    throw Object.assign(new Error('synthetic-private-message'), {
      request: { headers: { authorization: 'Bearer synthetic-private-bearer' } },
      response: { body: 'synthetic-private-body', headers: { secret: 'synthetic-private-header' } },
      cause: new Error('synthetic-private-cause'),
      toJSON() {
        throw new Error('Do not serialize private errors');
      },
    });
  }
  const keyFilename = process.env.BQ_SCREENING_COUNTER_KEY_FILE;
  if (!keyFilename) throw new Error('Read-only key filename required');
  const client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1', keyFilename });
  stage = 'exact-metadata-query';
  const names = [
    'tss_spiderman_screening_orders',
    'spiderman_screening_orders',
    'tss_orders',
    'tss_has_products',
  ] as const;
  const quoted = String.fromCharCode(96);
  const response: unknown = await client.query({
    query:
      'SELECT table_name,table_type FROM ' +
      quoted +
      'tssgcp2025.tss_mysql_raw_layer.INFORMATION_SCHEMA.TABLES' +
      quoted +
      ' WHERE table_name IN UNNEST(@names) ORDER BY table_name',
    params: { names: [...names] },
    types: { names: ['STRING'] },
    useLegacySql: false,
    maximumBytesBilled: '1000000000',
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'screening-counter-metadata' },
  });
  const tables = z
    .array(z.object({ table_name: z.enum(names), table_type: z.string().max(64) }).strict())
    .max(names.length)
    .parse(z.array(z.unknown()).parse(response)[0]);
  if (new Set(tables.map((row) => row.table_name)).size !== tables.length)
    throw new Error('Duplicate metadata');
  const evidence = {
    checkedAt: new Date().toISOString(),
    project: 'tssgcp2025',
    dataset: 'tss_mysql_raw_layer',
    location: 'asia-south1',
    requestedNames: names,
    tables,
    sourceRowsRead: 0,
    readOnly: true,
  };
  stage = 'local-evidence';
  const destination = resolve('evidence/bigquery-screening-counter-metadata.json');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, destination);
  process.stdout.write(
    JSON.stringify({
      resource: 'screening-counter-metadata',
      tables: tables.map((row) => row.table_name),
      sourceRowsRead: 0,
      readOnly: true,
    }) + '\n',
  );
}
void main().catch((_error: unknown) => {
  // SDK exceptions can contain bearer/request/response/cause secrets.
  process.stderr.write(
    JSON.stringify({ resource: 'screening-counter-metadata', stage, code: 'METADATA_FAILED' }) +
      '\n',
  );
  process.exitCode = 1;
});
