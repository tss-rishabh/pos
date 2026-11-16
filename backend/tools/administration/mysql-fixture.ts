import mysql from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';

export type LegacyFixtureValue = string | number | bigint | boolean | null;

/** Pure SQL construction only. Callers must enforce an isolated local test schema. */
export function legacyFixtureTableSql(table: MySqlTable): string {
  const config = getTableConfig(table);
  const definitions = config.columns.map(
    (column) =>
      `${mysql.escapeId(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${'autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : ''}`,
  );
  const primary = config.columns
    .filter((column) => column.primary)
    .map((column) => mysql.escapeId(column.name));
  if (primary.length) definitions.push(`PRIMARY KEY (${primary.join(',')})`);
  return `CREATE TABLE ${mysql.escapeId(config.name)} (${definitions.join(',')}) ENGINE=InnoDB`;
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
