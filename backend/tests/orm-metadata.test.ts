import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { is } from 'drizzle-orm';
import { getTableConfig, MySqlTable } from 'drizzle-orm/mysql-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

// Read-only production snapshot (SHOW CREATE TABLE + INFORMATION_SCHEMA.COLUMNS),
// captured outside the repository. Values are never edited by this test.
const snapshot = z
  .object({
    database: z.string(),
    missing: z.array(z.string()),
    tables: z.record(
      z.string(),
      z.object({
        columns: z.array(
          z.object({
            COLUMN_NAME: z.string(),
            COLUMN_TYPE: z.string(),
            IS_NULLABLE: z.enum(['YES', 'NO']),
            COLUMN_KEY: z.string(),
          }),
        ),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync('tests/golden/schema/production-schema.json', 'utf8')) as unknown);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}
/** Every Drizzle definition of a production (non `pos_rewrite_*`) table under src/. */
async function productionTables() {
  const found: { file: string; table: MySqlTable }[] = [];
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    if (!/mysqlTable\(\s*'(?!pos_rewrite_)/.test(text)) continue;
    const module = (await import(pathToFileURL(resolve(file)).href)) as Record<string, unknown>;
    for (const value of Object.values(module))
      if (is(value, MySqlTable)) {
        const config = getTableConfig(value);
        // Rewrite-owned tables and INFORMATION_SCHEMA views are not production tables.
        if (!config.name.startsWith('pos_rewrite_') && !config.schema)
          found.push({ file: relative('.', file), table: value });
      }
  }
  return found;
}
/** Comparable column type: lower case, display widths dropped except tinyint(1). */
function normalize(type: string) {
  const value = type.toLowerCase().replace(/\s+/g, ' ').trim();
  if (value === 'boolean' || value === 'tinyint(1)') return 'tinyint(1)';
  return value.replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, '$1');
}
function compatible(declared: string, physical: string) {
  const a = normalize(declared),
    b = normalize(physical);
  if (a === b) return true;
  // A declaration without explicit precision/length fixes only the base type.
  return !a.includes('(') && b.startsWith(a + '(') && !b.slice(a.length).includes(' ');
}

// Drift between Drizzle definitions and production found when this test was
// introduced (W2, 19 November 2026). Fixing it belongs to W3–W5 and is tracked
// in backend/parity/w2-followups.md. Remove entries as definitions are corrected;
// any new mismatch fails this test.
const knownMismatches = z
  .object({ mismatches: z.array(z.string()) })
  .parse(JSON.parse(readFileSync('tests/orm-known-mismatches.json', 'utf8')) as unknown).mismatches;

it('defines every production table only with columns, types and nullability that exist in production', async () => {
  const mismatches: string[] = [];
  for (const { file, table } of await productionTables()) {
    const config = getTableConfig(table),
      name = config.name,
      physical = snapshot.tables[name];
    if (!physical) {
      mismatches.push(
        `${file}: ${name}: ${snapshot.missing.includes(name) ? 'not captured' : 'not in production snapshot'}`,
      );
      continue;
    }
    for (const column of config.columns) {
      const actual = physical.columns.find((value) => value.COLUMN_NAME === column.name);
      if (!actual) {
        mismatches.push(`${file}: ${name}.${column.name}: column absent in production`);
        continue;
      }
      const declared = column.getSQLType();
      if (!compatible(declared, actual.COLUMN_TYPE))
        mismatches.push(
          `${file}: ${name}.${column.name}: type ${declared} != ${actual.COLUMN_TYPE}`,
        );
      if (column.notNull !== (actual.IS_NULLABLE === 'NO'))
        mismatches.push(
          `${file}: ${name}.${column.name}: ${column.notNull ? 'NOT NULL' : 'nullable'} != ${actual.IS_NULLABLE === 'NO' ? 'NOT NULL' : 'nullable'}`,
        );
      if (column.primary && actual.COLUMN_KEY !== 'PRI')
        mismatches.push(`${file}: ${name}.${column.name}: primary key not in production`);
    }
  }
  expect(mismatches.sort()).toEqual([...knownMismatches].sort());
}, 60_000);
