import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { z } from 'zod';
const column = z.object({
  name: z.string().regex(/^[A-Za-z_]\w*$/),
  type: z
    .string()
    .regex(/^(?:[a-z]+(?:\(\d+(?:,\d+)?\))?(?: unsigned)?|enum\((?:'[^'\\;]*'(?:,)?)+\))$/i),
  nullable: z.boolean(),
  key: z.string(),
  extra: z.string(),
  default: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  collation: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .nullable()
    .optional(),
});
const schema = z.object({
  tables: z.record(z.string(), z.array(column)),
  errors: z.array(z.unknown()),
});
export type FixtureValue = string | number | null;
function columnDefault(value: z.infer<typeof column>) {
  // Older metadata snapshots did not capture defaults; do not invent one.
  if (value.default === undefined) return '';
  if (value.extra.includes('DEFAULT_GENERATED')) {
    if (
      typeof value.default !== 'string' ||
      !/^CURRENT_TIMESTAMP(?:\([0-6]\))?$/i.test(value.default)
    )
      throw new Error('Fixture generated default is not verified.');
    return ' DEFAULT ' + value.default.toUpperCase();
  }
  if (value.default === undefined || value.default === null)
    return value.nullable && value.default === null ? ' DEFAULT NULL' : '';
  return ' DEFAULT ' + mysql.escape(value.default);
}
/** Source-verified types, without production indexes. Caller must create an isolated local schema. */
export function verifiedMysqlFixture(
  connection: mysql.Connection,
  additionalMetadataFiles: readonly string[] = [],
) {
  if (
    additionalMetadataFiles.length > 8 ||
    additionalMetadataFiles.some((filename) => !/^evidence\/mysql-[a-z0-9-]+\.json$/.test(filename))
  )
    throw new Error('Additional fixture metadata must use explicit evidence files.');
  let metadata = {
    ...schema.parse(JSON.parse(readFileSync('evidence/mysql-schema.json', 'utf8')) as unknown)
      .tables,
    ...schema.parse(JSON.parse(readFileSync('evidence/mysql-extra-schema.json', 'utf8')) as unknown)
      .tables,
  };
  for (const filename of additionalMetadataFiles) {
    const additional = schema.parse(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
    if (additional.errors.length)
      throw new Error('Additional fixture metadata has unresolved errors.');
    metadata = { ...metadata, ...additional.tables };
  }
  return {
    async create(tables: readonly string[]) {
      const [modeRows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT @@SESSION.sql_mode AS mode',
      );
      const previousMode = z.array(z.object({ mode: z.string() })).parse(modeRows)[0]?.mode;
      if (previousMode === undefined) throw new Error('Fixture session SQL mode unavailable.');
      // Pinned Django sets STRICT_TRANS_TABLES. Recreate its verified legacy
      // zero-date DDL defaults under that profile, then restore the caller's mode.
      await connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
      try {
        for (const table of tables) {
          const columns = metadata[table];
          if (!columns) throw new Error('Fixture table metadata unavailable.');
          const keys = columns
            .filter((value) => value.key === 'PRI')
            .map((value) => mysql.escapeId(value.name));
          await connection.query(
            `CREATE TABLE ${mysql.escapeId(table)} (${columns.map((value) => mysql.escapeId(value.name) + ' ' + value.type + (value.collation ? ' CHARACTER SET ' + mysql.escapeId(value.collation.split('_')[0]!) + ' COLLATE ' + mysql.escapeId(value.collation) : '') + (value.nullable ? ' NULL' : ' NOT NULL') + columnDefault(value) + (value.extra.includes('auto_increment') ? ' AUTO_INCREMENT' : '')).join(',')}${keys.length ? ',PRIMARY KEY(' + keys.join(',') + ')' : ''}) ENGINE=InnoDB`,
          );
        }
      } finally {
        await connection.query('SET SESSION sql_mode=?', [previousMode]);
      }
    },
    async insert(table: string, overrides: Record<string, FixtureValue>) {
      const columns = metadata[table];
      if (
        !columns ||
        Object.keys(overrides).some((name) => !columns.some((value) => value.name === name))
      )
        throw new Error('Fixture column unverified.');
      const selected = columns.filter(
          (value) => !value.extra.includes('auto_increment') || value.name in overrides,
        ),
        values = selected.map((value) => {
          if (value.name in overrides) return overrides[value.name];
          if (value.nullable) return null;
          if (/^(date|timestamp)/i.test(value.type))
            return value.type === 'date' ? '2026-11-16' : '2026-11-16 10:00:00';
          if (value.type.startsWith('time')) return '10:00:00';
          if (/^(bigint|int|smallint|tinyint|double|float|decimal|mediumint|bit)/i.test(value.type))
            return 0;
          if (value.type.startsWith('enum')) return /^enum\('([^']*)'/.exec(value.type)?.[1] || '';
          return value.type === 'json' ? '{}' : '';
        });
      await connection.query(
        `INSERT INTO ${mysql.escapeId(table)} (${selected.map((value) => mysql.escapeId(value.name)).join(',')}) VALUES (${selected.map(() => '?').join(',')})`,
        values,
      );
    },
  };
}
