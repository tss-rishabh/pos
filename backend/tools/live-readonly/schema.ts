import { createHash } from 'node:crypto';
/**
 * Live schema drift check: for every production table Drizzle maps under `src/`, live
 * `INFORMATION_SCHEMA.COLUMNS` and `SHOW CREATE TABLE` (without `AUTO_INCREMENT=`) must equal the
 * committed snapshot `tests/golden/schema/production-schema.json`. Only table names, column names,
 * attribute names and column types are reported.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { is, sql } from 'drizzle-orm';
import { getTableConfig, MySqlTable } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import type { Databases } from '../../src/db/pools.js';
import { backendRoot } from './connection.js';
import type { ColumnDrift, TableDrift } from './summary.js';

export const columnAttributes = [
  'COLUMN_NAME',
  'ORDINAL_POSITION',
  'COLUMN_TYPE',
  'IS_NULLABLE',
  'COLUMN_DEFAULT',
  'COLUMN_KEY',
  'EXTRA',
  'CHARACTER_SET_NAME',
  'COLLATION_NAME',
] as const;
type Attribute = (typeof columnAttributes)[number];
const scalar = z.union([z.string(), z.number(), z.null()]);
const snapshotSchema = z.object({
  serverVersion: z.string(),
  tables: z.record(
    z.string(),
    z.object({
      createTable: z.string(),
      columns: z.array(z.record(z.string(), scalar)),
    }),
  ),
});
export type SchemaSnapshot = z.infer<typeof snapshotSchema>;

export function readSnapshot(): SchemaSnapshot {
  return snapshotSchema.parse(
    JSON.parse(
      readFileSync(join(backendRoot, 'tests/golden/schema/production-schema.json'), 'utf8'),
    ) as unknown,
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every production (non `pos_rewrite_*`, non INFORMATION_SCHEMA) table a Drizzle schema maps. */
export async function drizzleProductionTables(): Promise<string[]> {
  const names = new Set<string>();
  for (const file of sourceFiles(join(backendRoot, 'src'))) {
    if (!/mysqlTable\(\s*'(?!pos_rewrite_)/.test(readFileSync(file, 'utf8'))) continue;
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const value of Object.values(module))
      if (is(value, MySqlTable)) {
        const config = getTableConfig(value);
        if (!config.name.startsWith('pos_rewrite_') && !config.schema) names.add(config.name);
      }
  }
  return [...names].sort();
}

const normalizeValue = (value: unknown) =>
  value === null || value === undefined ? null : String(value);
export const stripAutoIncrement = (ddl: string) => ddl.replace(/ AUTO_INCREMENT=\d+/, '');
/**
 * Cross-version DDL comparison only: MySQL 8.4 prints `CHARACTER SET x COLLATE y` on column lines
 * where 8.0 prints `COLLATE y` or `CHARACTER SET x` alone. Column character sets and collations
 * are still compared exactly through INFORMATION_SCHEMA.COLUMNS, so only the column-level clause
 * text is dropped here; everything else (types, defaults, keys, table options) stays exact.
 */
export function crossVersionDdl(ddl: string): string {
  return stripAutoIncrement(ddl)
    .split('\n')
    .map((line) =>
      line.startsWith('  `') ? line.replace(/ (?:CHARACTER SET|COLLATE) \w+/g, '') : line,
    )
    .join('\n');
}

/** Compares one table; returns `undefined` when it matches the snapshot exactly. */
/**
 * A column type as printed in the aggregate summary. Long enum/set types (for example the
 * 800-character `has_products.status` enum) exceed the summary's 200-character field limit, so
 * they are shortened to their first 60 characters plus the full length and a short digest.
 */
export function summarizeColumnType(type: string): string {
  if (type.length <= 120 && /^[A-Za-z0-9_ .:,()'<>/=+-]*$/.test(type)) return type;
  const digest = createHash('sha256').update(type).digest('hex').slice(0, 12);
  const head = type.slice(0, 60).replace(/[^A-Za-z0-9_ .:,()'<>/=+-]/g, '_');
  return `${head}... (${type.length} chars, sha256 ${digest})`;
}
export function compareTable(
  table: string,
  snapshot: SchemaSnapshot['tables'][string] | undefined,
  liveColumns: readonly Record<string, unknown>[],
  liveCreateTable: string | undefined,
  ddlComparison: 'exact' | 'cross-version' = 'exact',
): TableDrift | undefined {
  if (!snapshot || liveCreateTable === undefined)
    return { table, missing: true, columns: [], createTableDiffers: false };
  const columns: ColumnDrift[] = [];
  const live = new Map(liveColumns.map((row) => [String(row['COLUMN_NAME']), row]));
  const expected = new Map(snapshot.columns.map((row) => [String(row['COLUMN_NAME']), row]));
  for (const [name, row] of expected) {
    const actual = live.get(name);
    if (!actual) {
      columns.push({ column: name, attributes: ['missing'] });
      continue;
    }
    const attributes = columnAttributes.filter(
      (attribute: Attribute) =>
        normalizeValue(row[attribute]) !== normalizeValue(actual[attribute]),
    );
    if (attributes.length)
      columns.push({
        column: name,
        attributes: [...attributes],
        ...(attributes.includes('COLUMN_TYPE')
          ? {
              snapshotType: summarizeColumnType(String(row['COLUMN_TYPE'])),
              liveType: summarizeColumnType(String(actual['COLUMN_TYPE'])),
            }
          : {}),
      });
  }
  for (const name of live.keys())
    if (!expected.has(name)) columns.push({ column: name, attributes: ['extra'] });
  const normalize = ddlComparison === 'exact' ? stripAutoIncrement : crossVersionDdl;
  const createTableDiffers = normalize(liveCreateTable) !== normalize(snapshot.createTable);
  return columns.length || createTableDiffers
    ? { table, missing: false, columns, createTableDiffers }
    : undefined;
}

/** Reads live metadata through the guarded connection and compares it with the snapshot. */
export async function liveSchemaDrift(
  databases: Databases,
  database: string,
  tables: readonly string[],
  ddlComparison: 'exact' | 'cross-version',
  snapshot: SchemaSnapshot = readSnapshot(),
): Promise<TableDrift[]> {
  const db = databases.get('primary');
  const [columns] = (await db.execute(
    sql`SELECT ${sql.raw(columnAttributes.join(', '))}, TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${database} AND TABLE_NAME IN (${sql.join(
      tables.map((table) => sql`${table}`),
      sql`, `,
    )}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  )) as unknown as [Record<string, unknown>[]];
  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const row of columns) {
    const name = String(row['TABLE_NAME']);
    byTable.set(name, [...(byTable.get(name) ?? []), row]);
  }
  const drift: TableDrift[] = [];
  for (const table of tables) {
    let ddl: string | undefined;
    if (byTable.has(table)) {
      const [rows] = (await db.execute(
        sql.raw(`SHOW CREATE TABLE ${mysql.escapeId(table)}`),
      )) as unknown as [Record<string, unknown>[]];
      ddl = z.string().parse(rows[0]?.['Create Table']);
    }
    const result = compareTable(
      table,
      snapshot.tables[table],
      byTable.get(table) ?? [],
      ddl,
      ddlComparison,
    );
    if (result) drift.push(result);
  }
  return drift;
}
