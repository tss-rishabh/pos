import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { productionCreateTable } from '../../tests/helpers/production-schema.js';

export type LegacyFixtureValue = string | number | bigint | boolean | null;

/**
 * Production DDL for a mapped legacy table, taken verbatim from the committed production snapshot
 * (`tests/golden/schema/production-schema.json`). Callers must enforce an isolated local test
 * schema. Prefer `createProductionTables` from `tests/helpers/production-schema.ts`.
 */
export function legacyFixtureTableSql(table: MySqlTable): string {
  return productionCreateTable(table);
}

/** Model-derived defaults let tests supply only fields material to their scenario. */
export function legacyFixtureRecord(
  table: MySqlTable,
  values: Record<string, LegacyFixtureValue>,
  timestamp = '2026-11-16 00:00:00',
): Record<string, LegacyFixtureValue> {
  const record: Record<string, LegacyFixtureValue> = {};
  for (const column of getTableConfig(table).columns) {
    if ('autoIncrement' in column && column.autoIncrement) continue;
    const type = column.getSQLType();
    record[column.name] = !column.notNull
      ? null
      : /^(date|datetime|timestamp)/.test(type)
        ? type === 'date'
          ? '2000-01-01'
          : timestamp
        : type.startsWith('time')
          ? '00:00:00'
          : /^(decimal|numeric)/.test(type)
            ? '0.00'
            : column.dataType === 'boolean'
              ? false
              : column.dataType === 'number' || column.dataType === 'bigint'
                ? 0
                : '';
  }
  return Object.assign(record, values);
}
