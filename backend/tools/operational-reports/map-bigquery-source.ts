import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const column = z.object({
    name: z.string(),
    type: z.string(),
    nullable: z.boolean(),
    collation: z.string().nullable().optional(),
  }),
  source = z.object({ tables: z.record(z.string(), z.array(column)) }),
  field: z.ZodType<{
    name: string;
    type: string;
    collation?: string | null;
    fields?: { name: string; type: string }[] | null;
  }> = z.object({
    name: z.string(),
    type: z.string(),
    collation: z.string().nullable().optional(),
    fields: z
      .array(z.object({ name: z.string(), type: z.string() }))
      .nullable()
      .optional(),
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
        schema: z.object({ fields: z.array(field) }).optional(),
        tableConstraints: z
          .object({ primaryKey: z.object({ columns: z.array(z.string()) }).optional() })
          .optional(),
      }),
    ),
    cdcMetadata: z.array(
      z.object({ tableName: z.string(), upsertStreamApplyWatermark: z.string().nullable() }),
    ),
    tableOptions: z.array(
      z.object({ table_name: z.string(), option_name: z.string(), option_value: z.string() }),
    ),
  });
const schemas: Record<string, z.infer<typeof column>[]> = {};
for (const filename of [
  'mysql-schema.json',
  'mysql-extra-schema.json',
  'mysql-legacy-fulfillment-schema.json',
  'mysql-legacy-cancellations-schema.json',
  'mysql-admin-shipping-schema.json',
  'mysql-auth-history-schema.json',
])
  Object.assign(
    schemas,
    source.parse(JSON.parse(await readFile('evidence/' + filename, 'utf8')) as unknown).tables,
  );
const bq = warehouse.parse(
    JSON.parse(await readFile('evidence/bigquery-schema.json', 'utf8')) as unknown,
  ),
  watermarks = new Map(
    bq.cdcMetadata.map((row) => [row.tableName, row.upsertStreamApplyWatermark]),
  ),
  coverage = Object.fromEntries(
    Object.entries(schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, columns]) => {
        const rawName = 'tss_' + table,
          raw = bq.tables[rawName],
          fields = new Map((raw?.schema?.fields || []).map((value) => [value.name, value]));
        return [
          table,
          {
            candidateRawTable: raw
              ? bq.scope.project + '.' + bq.scope.dataset + '.' + rawName
              : null,
            observedBy: 'exact-tss-prefix-and-column-name-comparison',
            present: !!raw,
            sourceColumnCount: columns.length,
            missingSourceColumns: raw
              ? columns.filter((value) => !fields.has(value.name)).map((value) => value.name)
              : columns.map((value) => value.name),
            primaryKey: raw?.tableConstraints?.primaryKey?.columns || null,
            cdcWatermark: watermarks.get(rawName) || null,
            maxStaleness:
              bq.tableOptions.find(
                (value) => value.table_name === rawName && value.option_name === 'max_staleness',
              )?.option_value || null,
            columns: columns.map((value) => ({
              name: value.name,
              mysqlType: value.type,
              mysqlNullable: value.nullable,
              mysqlCollation: value.collation || null,
              bigqueryType: fields.get(value.name)?.type || null,
              bigqueryCollation: fields.get(value.name)?.collation || null,
            })),
          },
        ];
      }),
  );
const result = {
    checkedAt: new Date().toISOString(),
    warehouseEvidenceAt: bq.checkedAt,
    scope: bq.scope,
    coverage,
    limitations: [
      'This compares metadata, not rows, source transactions, publication generations or full query parity.',
      'Candidate names are structurally observed exact-prefix matches; deployments still require the explicit source/CDC and collation contracts.',
      'No absent source table is replaced with a similarly named table or treated as an empty report.',
    ],
  },
  filename = 'evidence/bigquery-source-coverage.json',
  temporary = filename + '.' + randomUUID() + '.tmp';
await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
await rename(temporary, filename);
process.stdout.write(
  JSON.stringify({
    evidence: filename,
    sourceTables: Object.keys(coverage).length,
    present: Object.values(coverage).filter((value) => value.present).length,
    missing: Object.values(coverage).filter((value) => !value.present).length,
  }) + '\n',
);
