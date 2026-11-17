import { it, expect } from 'vitest';
import { migrationPlan, splitMigration } from '../src/db/migrations.js';
import { readFileSync } from 'node:fs';
import { screeningReservationDdl } from '../src/modules/legacy-order-imports/screening-profile.js';

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

it('ships the exact shared source schema before public financial journals', () => {
  const paths = migrationPlan().map((value) => value.id);
  const shared = 'src/modules/legacy-order-imports/screening-shared-migration.sql',
    source = 'src/modules/checkout/screening-writer/source-migration.sql',
    negatives = 'src/modules/checkout/screening-writer/negative-migration.sql',
    journals = 'src/modules/checkout/screening-writer/migration.sql',
    facts = 'src/modules/checkout/payments/provider-evidence-migration.sql';
  for (const path of [shared, source, negatives, journals, facts]) expect(paths).toContain(path);
  expect(paths.indexOf(shared)).toBeLessThan(paths.indexOf(source));
  expect(paths.indexOf(source)).toBeLessThan(paths.indexOf(negatives));
  expect(paths.indexOf(negatives)).toBeLessThan(paths.indexOf(journals));
  expect(paths.indexOf('src/modules/checkout/migrations/0003_payments.sql')).toBeLessThan(
    paths.indexOf(facts),
  );
  expect(readFileSync(shared, 'utf8')).toBe(screeningReservationDdl + ';\n');
  // Retain the previously shipped migration checksum. New source/rewrite
  // installations and incremental upgrades must produce the same statements.
  expect([
    ...splitMigration(readFileSync(source, 'utf8')),
    ...splitMigration(readFileSync(negatives, 'utf8')),
  ]).toEqual(
    splitMigration(
      readFileSync('compatibility/upstream/public-screening-writer/migration.review.sql', 'utf8'),
    ),
  );
});
