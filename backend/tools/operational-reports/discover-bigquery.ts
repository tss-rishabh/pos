import { BigQuery } from '@google-cloud/bigquery';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Metadata only. Never reads key bytes directly, row data, SQL bodies or private descriptions. */
const project = 'tssgcp2025',
  datasetId = 'tss_mysql_raw_layer',
  location = 'asia-south1',
  filename = 'evidence/bigquery-schema.json';
const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFilename || !isAbsolute(keyFilename))
  throw new Error('An explicit user-authorized credential path is required.');
const client = new BigQuery({ projectId: project, location, keyFilename, maxRetries: 1 }),
  dataset = client.dataset(datasetId);
const name = z.string().min(1).max(1024),
  text = z.string().max(1024).nullable().optional();
interface Field {
  name: string;
  type: string;
  mode?: string | null;
  collation?: string | null;
  fields?: Field[] | null;
}
const field: z.ZodType<Field> = z.object({
  name,
  type: z.string().max(128),
  mode: text,
  collation: text,
  fields: z
    .array(z.lazy(() => field))
    .max(1000)
    .nullable()
    .optional(),
});
const tableMetadata = z.object({
  tableReference: z.object({ projectId: name, datasetId: name, tableId: name }),
  type: text,
  schema: z.object({ fields: z.array(field).max(1000) }).optional(),
  numRows: text,
  creationTime: text,
  lastModifiedTime: text,
  expirationTime: text,
  defaultCollation: text,
  maxStaleness: text,
  timePartitioning: z
    .object({ type: text, field: text, requirePartitionFilter: z.boolean().optional() })
    .optional(),
  rangePartitioning: z
    .object({ field: text, range: z.object({ start: text, end: text, interval: text }).optional() })
    .optional(),
  clustering: z.object({ fields: z.array(name).max(100) }).optional(),
  tableConstraints: z
    .object({
      primaryKey: z.object({ columns: z.array(name) }).optional(),
      foreignKeys: z
        .array(
          z.object({
            name: text,
            referencedTable: z.object({ projectId: name, datasetId: name, tableId: name }),
            columnReferences: z.array(
              z.object({ referencingColumn: name, referencedColumn: name }),
            ),
          }),
        )
        .optional(),
    })
    .optional(),
  streamingBuffer: z
    .object({ estimatedBytes: text, estimatedRows: text, oldestEntryTime: text })
    .optional(),
  materializedView: z
    .object({
      lastRefreshTime: text,
      enableRefresh: z.boolean().optional(),
      refreshIntervalMs: text,
    })
    .optional(),
  view: z.object({ query: z.string().optional(), useLegacySql: z.boolean().optional() }).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});
function errorCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599)
      return 'HTTP_' + code;
  }
  return 'METADATA_UNAVAILABLE';
}
const errors: { resource: string; code: string }[] = [];
const [rawDataset] = await dataset.getMetadata();
const metadata = z
  .object({
    location: z.string(),
    defaultCollation: text,
    creationTime: text,
    lastModifiedTime: text,
  })
  .parse(rawDataset);
if (metadata.location.toLowerCase() !== location)
  throw new Error('The authorized dataset location did not match.');
const tables: ReturnType<typeof dataset.table>[] = [];
let pageToken: string | undefined,
  truncated = false;
for (let page = 0; page < 10; page++) {
  const [batch, next] = await dataset.getTables({
    autoPaginate: false,
    maxResults: 200,
    pageToken,
  });
  tables.push(...batch);
  pageToken = next?.pageToken || undefined;
  if (!pageToken) break;
  if (page === 9) truncated = true;
}
const inventory: Record<string, unknown> = {};
let cursor = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= tables.length) return;
      const table = tables[index]!;
      const id = name.parse(table.id);
      try {
        const [raw] = await table.getMetadata();
        const parsed = tableMetadata.parse(raw);
        if (
          parsed.tableReference.projectId !== project ||
          parsed.tableReference.datasetId !== datasetId
        )
          throw new Error('Unexpected metadata scope.');
        const { view, labels, ...safe } = parsed;
        inventory[id] = {
          ...safe,
          labelKeys: Object.keys(labels || {}).sort(),
          view: view
            ? {
                useLegacySql: view.useLegacySql,
                queryHash: view.query
                  ? createHash('sha256').update(view.query).digest('hex')
                  : null,
              }
            : undefined,
        };
      } catch (error) {
        errors.push({ resource: id, code: errorCode(error) });
      }
    }
  }),
);
const routines: Record<string, unknown> = {};
try {
  const [items, next] = await dataset.getRoutines({ autoPaginate: false, maxResults: 200 });
  for (const routine of items) {
    const [raw] = await routine.getMetadata();
    const value = z
      .object({
        routineReference: z.object({ routineId: name }),
        routineType: text,
        language: text,
        arguments: z
          .array(z.object({ name: text, dataType: z.object({ typeKind: text }).optional() }))
          .optional(),
        returnType: z.object({ typeKind: text }).optional(),
        definitionBody: z.string().optional(),
        lastModifiedTime: text,
      })
      .parse(raw);
    const { definitionBody, ...safe } = value;
    routines[value.routineReference.routineId] = {
      ...safe,
      definitionHash: definitionBody
        ? createHash('sha256').update(definitionBody).digest('hex')
        : null,
    };
  }
  if (next?.pageToken) errors.push({ resource: 'routines', code: 'METADATA_LIMIT_REACHED' });
} catch (error) {
  errors.push({ resource: 'routines', code: errorCode(error) });
}
let cdcMetadata: unknown[] = [];
try {
  const query =
    'SELECT table_name, table_type, upsert_stream_apply_watermark FROM `' +
    project +
    '.' +
    datasetId +
    '.INFORMATION_SCHEMA.TABLES` ORDER BY table_name LIMIT 2000';
  await client.createQueryJob({
    query,
    dryRun: true,
    useLegacySql: false,
    location,
    maximumBytesBilled: '10485760',
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'schema-discovery' },
  });
  const [rows] = await client.query({
    query,
    useLegacySql: false,
    location,
    maximumBytesBilled: '10485760',
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'schema-discovery' },
  });
  const scalar = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    const parsed = z.object({ value: z.string() }).safeParse(value);
    return parsed.success ? parsed.data.value : null;
  };
  cdcMetadata = z
    .array(
      z.object({
        table_name: name,
        table_type: z.string(),
        upsert_stream_apply_watermark: z.unknown(),
      }),
    )
    .parse(rows)
    .map((row) => ({
      tableName: row.table_name,
      tableType: row.table_type,
      upsertStreamApplyWatermark: scalar(row.upsert_stream_apply_watermark),
    }));
} catch (error) {
  errors.push({ resource: 'information-schema-cdc-watermarks', code: errorCode(error) });
}
let tableOptions: unknown[] = [];
try {
  const query =
    'SELECT table_name, option_name, option_value FROM `' +
    project +
    '.' +
    datasetId +
    ".INFORMATION_SCHEMA.TABLE_OPTIONS` WHERE option_name IN ('max_staleness','default_collation','require_partition_filter') ORDER BY table_name,option_name LIMIT 2000";
  const [rows] = await client.query({
    query,
    useLegacySql: false,
    location,
    maximumBytesBilled: '10485760',
    jobTimeoutMs: 10000,
    labels: { application: 'pos-rewrite', resource: 'schema-discovery' },
  });
  tableOptions = z
    .array(
      z.object({
        table_name: name,
        option_name: z.enum(['max_staleness', 'default_collation', 'require_partition_filter']),
        option_value: z.string().max(512),
      }),
    )
    .parse(rows);
} catch (error) {
  errors.push({ resource: 'information-schema-table-options', code: errorCode(error) });
}
const output = {
  checkedAt: new Date().toISOString(),
  scope: {
    project,
    dataset: datasetId,
    location,
    authentication: 'explicit-user-authorized-key-file',
    expectedReader: 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com',
  },
  dataset: metadata,
  listedTables: tables.length,
  truncated,
  tables: Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b))),
  routines,
  cdcMetadata,
  tableOptions,
  errors,
  limitations: [
    'No customer/product/feedback rows were selected. No credentials, descriptions or SQL bodies are included.',
    'Table modification time, row count and a per-table CDC watermark do not establish one consistent multi-table publication generation.',
    'A BigQuery field collation does not certify MySQL collation equivalence. No DDL, UDF/view creation, extract job or external export ran.',
  ],
};
await mkdir('evidence', { recursive: true });
const temporary = filename + '.' + randomUUID() + '.tmp';
await writeFile(temporary, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
await rename(temporary, filename);
process.stdout.write(
  JSON.stringify({
    evidence: filename,
    project,
    dataset: datasetId,
    location,
    listedTables: tables.length,
    schemas: Object.keys(inventory).length,
    routines: Object.keys(routines).length,
    cdcMetadataRows: cdcMetadata.length,
    truncated,
    errors,
  }) + '\n',
);
