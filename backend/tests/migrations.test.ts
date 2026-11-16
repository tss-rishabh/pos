import { it, expect } from 'vitest';
import { migrationPlan, splitMigration } from '../src/db/migrations.js';

it('restricts migration SQL to rewrite-owned tables and parses semicolons in values/comments', () => {
  expect(
    splitMigration(
      "-- comment\nCREATE TABLE pos_rewrite_fixture (value VARCHAR(20)); INSERT INTO pos_rewrite_fixture VALUES ('value;still value'); /* end */",
    ),
  ).toHaveLength(2);
  expect(() => splitMigration('ALTER TABLE pos_order ADD COLUMN x INT;')).toThrow(
    'LEGACY_SCHEMA_MUTATION_FORBIDDEN',
  );
  expect(() => splitMigration('DROP TABLE pos_rewrite_fixture;')).toThrow(
    'LEGACY_SCHEMA_MUTATION_FORBIDDEN',
  );
  expect(() => splitMigration("INSERT INTO pos_rewrite_fixture VALUES ('broken);")).toThrow(
    'INVALID_MIGRATION_SQL',
  );
  expect(migrationPlan().every((value) => value.statements.length > 0)).toBe(true);
});
