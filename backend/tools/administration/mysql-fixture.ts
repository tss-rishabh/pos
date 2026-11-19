import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import {
  isProductionTable,
  productionColumns,
  productionCreateTable,
} from '../../tests/helpers/production-schema.js';

export type LegacyFixtureValue = string | number | bigint | boolean | null;

/**
 * Production DDL for a mapped legacy table, taken verbatim from the committed production snapshot
 * (`tests/golden/schema/production-schema.json`). Callers must enforce an isolated local test
 * schema. Prefer `createProductionTables` from `tests/helpers/production-schema.ts`.
 */
export function legacyFixtureTableSql(table: MySqlTable): string {
  return productionCreateTable(table);
}

let uniqueFiller = 0;

/**
 * Model-derived defaults let tests supply only fields material to their scenario. An unset
 * NOT NULL text column in a production UNIQUE KEY gets a distinct `fixture-N` value so several
 * rows can coexist under the production keys.
 */
export function legacyFixtureRecord(
  table: MySqlTable,
  values: Record<string, LegacyFixtureValue>,
  timestamp = '2026-11-16 00:00:00',
): Record<string, LegacyFixtureValue> {
  const record: Record<string, LegacyFixtureValue> = {},
    unique = new Set(
      isProductionTable(table)
        ? productionColumns(table).flatMap((column) =>
            column.unique && /char\(/i.test(column.type) ? [column.name] : [],
          )
        : [],
    );
  for (const column of getTableConfig(table).columns) {
    if ('autoIncrement' in column && column.autoIncrement) continue;
    const type = column.getSQLType();
    record[column.name] = !column.notNull
      ? null
      : unique.has(column.name) && !(column.name in values)
        ? 'fixture-' + String(++uniqueFiller)
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
