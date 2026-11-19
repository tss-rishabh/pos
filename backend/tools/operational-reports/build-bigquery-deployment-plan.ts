import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  observedLegacyExportRawTable,
  rawLegacyExportProjection,
} from '../../src/modules/operational-reports/raw-legacy-export.js';
import {
  dailyWarehouseRowHashExpression,
  dailyWarehouseContract,
} from '../../src/modules/daily-report-warehouse.js';

const directory = 'parity/bigquery-deployment';
await mkdir(directory, { recursive: true });
async function publish(name: string, value: string) {
  const file = directory + '/' + name,
    temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, file);
}
const column = z.object({
    name: z.string(),
    type: z.string(),
    nullable: z.boolean(),
    key: z.string(),
    extra: z.string(),
    default: z.union([z.string(), z.number(), z.null()]).optional(),
    collation: z.string().nullable().optional(),
  }),
  metadata = z.object({
    checkedAt: z.string(),
    schema: z.literal('tss'),
    tables: z.record(z.string(), z.array(column)),
    errors: z.array(z.unknown()),
  }),
  warehouse = z.object({
    checkedAt: z.string(),
    scope: z.object({
      project: z.literal('tssgcp2025'),
      dataset: z.literal('tss_mysql_raw_layer'),
      location: z.literal('asia-south1'),
    }),
    tables: z.record(
      z.string(),
      z.object({
        schema: z
          .object({ fields: z.array(z.object({ name: z.string(), type: z.string() })) })
          .optional(),
      }),
    ),
    errors: z.array(z.unknown()),
  });
const sourceTables: Record<
  string,
  {
    source: string;
    sourceEvidence: string;
    metadataSha256: string;
    columns: z.infer<typeof column>[];
  }
> = {};
for (const filename of [
  'mysql-schema.json',
  'mysql-extra-schema.json',
  'mysql-legacy-fulfillment-schema.json',
  'mysql-legacy-cancellations-schema.json',
  'mysql-admin-shipping-schema.json',
  'mysql-auth-history-schema.json',
]) {
  const file = 'evidence/' + filename,
    bytes = await readFile(file, 'utf8'),
    snapshot = metadata.parse(JSON.parse(bytes) as unknown);
  if (snapshot.errors.length) throw new Error('SOURCE_SCHEMA_EVIDENCE_INCOMPLETE');
  for (const [name, columns] of Object.entries(snapshot.tables))
    sourceTables[name] = {
      source: snapshot.schema + '.' + name,
      sourceEvidence: file,
      metadataSha256: createHash('sha256').update(bytes).digest('hex'),
      columns,
    };
}
const bq = warehouse.parse(
  JSON.parse(await readFile('evidence/bigquery-schema.json', 'utf8')) as unknown,
);
if (bq.errors.length) throw new Error('WAREHOUSE_SCHEMA_EVIDENCE_INCOMPLETE');
const sourceSchemas = Object.fromEntries(
  Object.entries(sourceTables)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      const observed = 'tss_' + name,
        raw = bq.tables[observed],
        fields = new Set(raw?.schema?.fields.map((field) => field.name) || []);
      return [
        name,
        {
          ...value,
          observedRawTable: raw ? bq.scope.project + '.' + bq.scope.dataset + '.' + observed : null,
          rawTablePresent: !!raw,
          missingColumns: raw
            ? value.columns
                .filter((column) => !fields.has(column.name))
                .map((column) => column.name)
            : value.columns.map((column) => column.name),
          publicationPolicy:
            name === 'auth_user'
              ? {
                  allowedColumns: ['id', 'username', 'first_name', 'last_name'],
                  excluded:
                    'Passwords, contacts, flags and privileges are not needed by the history view.',
                }
              : {
                  allowedColumns: null,
                  requiredReview:
                    'Choose resource-required columns from the exact schema; no blanket publication of credentials, tokens, contacts or private file URLs.',
                },
        },
      ];
    }),
);
const bindings = new Map<string, Set<string>>();
async function inspect(path: string) {
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/\b(?:BQ|BIGQUERY)_[A-Z0-9_]+\b/g)) {
    const name = match[0];
    if (name.endsWith('_')) continue;
    const files = bindings.get(name) || new Set<string>();
    files.add(path);
    bindings.set(name, files);
  }
}
async function walk(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = path + '/' + entry.name;
    if (entry.isDirectory()) await walk(target);
    else if (entry.name.endsWith('.ts')) await inspect(target);
  }
}
await walk('src/modules');
await inspect('src/config.ts');
const configInputs = Object.fromEntries(
  [...bindings.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, paths]) => [
      name,
      {
        kind: name.includes('CONTRACT')
          ? 'attested-contract'
          : name.includes('UDF')
            ? 'source-compatible-function'
            : name.includes('VIEW') ||
                name.includes('TABLE') ||
                /(?:ORDERS|RETURNS|PRODUCTS|LINES|STORES|STATUSES|LOGS|BALANCES|CLOSES|BANKING|COLLECTIONS|SALES)$/.test(
                  name,
                )
              ? 'normalized-relation'
              : 'client-or-runtime-limit',
        consumers: [...paths].sort(),
        configuredByThisPlan: false,
      },
    ]),
);
const plan = {
  generatedAt: new Date().toISOString(),
  warehouseEvidenceAt: bq.checkedAt,
  scope: bq.scope,
  status: 'review-required-not-applied',
  readOnlyAuthorization:
    'Metadata/SELECT/dry-run only. This tool performs only local file writes, not cloud writes.',
  sourceSchemas,
  normalizedInputs: configInputs,
  financialPublication: {
    contract: dailyWarehouseContract,
    rowHashExpression: dailyWarehouseRowHashExpression,
    requires: [
      'One read-only repeatable-read source snapshot, or a proven CDC transaction-consistent generation across every required relation.',
      'Immutable generation ID and complete per-store/day partition manifests including explicit empty partitions, row counts and native row hashes.',
      'Source report_queries.py cash/count/HP quantity/revenue are published unchanged; never invent HP sales.',
      'Readiness includes current banking/opening/close/outflow data; absent relations never imply zero.',
      'Fresh source progress and publication timestamps, explicit wall-clock timezone, approved source SQL/source revision, and immutable generation selection.',
      'No MySQL historical fallback; no deployment activation by pointing normalized-view settings at raw tables.',
    ],
    sourceSql: 'src/modules/daily-report.ts',
    readerContract: 'src/modules/daily-report-warehouse.ts',
  },
  nonfinancialProjections: [
    {
      resource: 'legacy-report-export-history',
      source: observedLegacyExportRawTable,
      sql: directory + '/legacy-report-export-projection.sql',
      activation: false,
      limits: [
        'Column projection only; independent complete CDC/publication, source-clock and name-sort/search collation evidence still required.',
        'Retains bounded source time_period text exactly; never returns private file URL, free-text source message, token or command/filter JSON.',
        'Download authorization still uses writer-current internal-role1 and private storage checks.',
      ],
    },
  ],
  historyProvenance: {
    sourceAuthModel: 'users.PosUser',
    physicalTssAdminLogActorFk: 'tss.django_admin_log.user_id -> tss.auth_user.id (RESTRICT)',
    physicalContentTypeFk:
      'tss.django_admin_log.content_type_id -> tss.django_content_type.id (RESTRICT)',
    mobileCms:
      'A django_admin_log location was discovered; source ownership, schema and this POS operational lineage are unresolved. No substitution is proposed.',
    unresolved:
      'Physical inherited log actor FK does not prove the current POS writer. Require database/auth-model/router/FK provenance before normalizing history.',
    minimalActorColumns: ['id', 'username', 'first_name', 'last_name'],
  },
  prohibitedDuringReaderAuthorization: [
    'CREATE/ALTER/DROP datasets, tables, views or routines',
    'Copy/load/extract/export jobs, scheduled queries or external storage writes',
    'IAM/stream mutation or key copying',
    'Source-row output, raw errors containing SQL/values, or contact/secret publication',
  ],
};
await publish('plan.json', JSON.stringify(plan, null, 2) + '\n');
await publish(
  'legacy-report-export-projection.sql',
  '-- Reviewed nonfinancial SELECT projection only. No reader activation or publication attestation.\n-- Source: ' +
    observedLegacyExportRawTable +
    '\n' +
    rawLegacyExportProjection() +
    ';\n',
);
process.stdout.write(
  JSON.stringify({
    artifact: directory + '/plan.json',
    sourceTables: Object.keys(sourceSchemas).length,
    missingSourceTables: Object.values(sourceSchemas).filter((value) => !value.rawTablePresent)
      .length,
    normalizedInputs: Object.keys(configInputs).length,
    cloudWrites: 0,
  }) + '\n',
);
