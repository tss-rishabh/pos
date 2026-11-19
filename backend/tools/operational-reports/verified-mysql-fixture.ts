import mysql from 'mysql2/promise';
import {
  createProductionTables,
  productionColumns,
  type SqlSession,
} from '../../tests/helpers/production-schema.js';

export type FixtureValue = string | number | null;

let uniqueFiller = 0;

/**
 * Production-DDL fixture for an isolated local schema the caller created.
 *
 * `create` builds tables only from the committed production snapshot
 * (`tests/golden/schema/production-schema.json`) through the shared snapshot helper, with their
 * production keys and indexes. `insert` fills every column the scenario does not set with a
 * type-appropriate value, using the snapshot's production columns. An unset NOT NULL text column
 * that is part of a production UNIQUE KEY gets a distinct `fixture-N` value, so several rows can
 * coexist under the production keys.
 *
 * The second argument is accepted for callers that still pass the former per-feature evidence
 * metadata files; it is ignored because the production snapshot is the only schema authority.
 */
export function verifiedMysqlFixture(
  connection: SqlSession,
  ignoredMetadataFiles: readonly string[] = [],
) {
  void ignoredMetadataFiles;
  return {
    async create(tables: readonly string[]) {
      await createProductionTables(connection, tables);
    },
    async insert(table: string, overrides: Record<string, FixtureValue>) {
      const columns = productionColumns(table);
      if (Object.keys(overrides).some((name) => !columns.some((value) => value.name === name)))
        throw new Error('Fixture column is not a production column.');
      const selected = columns.filter((value) => !value.autoIncrement || value.name in overrides),
        values = selected.map((value) => {
          if (value.name in overrides) return overrides[value.name];
          if (value.nullable) return null;
          const text = /^(?:var)?char\((\d+)\)$/i.exec(value.type);
          if (value.unique && text)
            return ('fixture-' + String(++uniqueFiller)).slice(0, Number(text[1]));
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
