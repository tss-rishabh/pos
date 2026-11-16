import mysql, { type Connection } from 'mysql2/promise';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { applyMigrations, assertMigrationsCurrent, migrationPlan } from '../src/db/migrations.js';
import { createDatabases } from '../src/db/pools.js';
import { readConfig, type Config } from '../src/config.js';

const template = process.env.MIGRATION_MYSQL_TEST_URL;
describe.skipIf(!template)('writer-only migration journal in isolated local MySQL', () => {
  let connection: Connection, config: Config, schema: string;
  beforeEach(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_migrations_test'
    )
      throw new Error('Migration tests require their explicit isolated local schema template.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    schema = `pos_rewrite_migrations_test_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-migration-fixture-'.repeat(3),
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
  });
  afterEach(async () => {
    if (connection) {
      if (schema) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('serializes concurrent runners and skips only unchanged completed migrations', async () => {
    const plan = migrationPlan(),
      results = await Promise.all([applyMigrations(config, plan), applyMigrations(config, plan)]);
    expect(results.map((value) => value.applied.length).sort((a, b) => a - b)).toEqual([
      0,
      plan.length,
    ]);
    const trace = 'r'.repeat(128),
      eventId = crypto.randomUUID();
    await connection.execute(
      'INSERT INTO pos_rewrite_notification_events(event_id,store_id,request_hash,request_id,created_at) VALUES(?,?,?,?,?)',
      [eventId, '1', 'a'.repeat(64), trace, '2026-11-16 10:00:00'],
    );
    const [traces] = await connection.execute(
      'SELECT request_id FROM pos_rewrite_notification_events WHERE event_id=?',
      [eventId],
    );
    expect(traces).toEqual([{ request_id: trace }]);
    const changed = plan.map((value, index) =>
      index === 0 ? { ...value, checksum: 'a'.repeat(64) } : value,
    );
    await expect(applyMigrations(config, changed)).rejects.toMatchObject({
      code: 'APPLIED_MIGRATION_CHANGED',
    });
  });
  it('requires review after an interrupted DDL step rather than replaying it', async () => {
    const plan = [
      {
        id: migrationPlan()[0]!.id,
        checksum: 'f'.repeat(64),
        statements: ['CREATE TABLE pos_rewrite_fixture_failure (value INVALID_FIXTURE_TYPE)'],
      },
    ];
    await expect(applyMigrations(config, plan)).rejects.toBeDefined();
    await expect(applyMigrations(config, plan)).rejects.toMatchObject({
      code: 'MIGRATION_STEP_NEEDS_REVIEW',
    });
    const [rows] = await connection.query('SELECT state FROM pos_rewrite_schema_migration_steps');
    expect(rows).toEqual([{ state: 'started' }]);
  });
  it('keeps readiness unavailable for missing, changed or unfinished migrations without repairing them', async () => {
    const db = createDatabases(config);
    try {
      await expect(assertMigrationsCurrent(db)).rejects.toBeDefined();
      await applyMigrations(config);
      await expect(assertMigrationsCurrent(db)).resolves.toBeUndefined();
      const first = migrationPlan()[0]!;
      await connection.execute('UPDATE pos_rewrite_schema_migrations SET checksum=? WHERE id=?', [
        'a'.repeat(64),
        first.id,
      ]);
      await expect(assertMigrationsCurrent(db)).rejects.toMatchObject({
        code: 'MIGRATION_NOT_CURRENT',
      });
      await connection.execute('UPDATE pos_rewrite_schema_migrations SET checksum=? WHERE id=?', [
        first.checksum,
        first.id,
      ]);
      await connection.execute(
        "UPDATE pos_rewrite_schema_migration_steps SET state='started' WHERE id=? AND step=0",
        [first.id],
      );
      await expect(assertMigrationsCurrent(db)).rejects.toMatchObject({
        code: 'MIGRATION_STEP_NEEDS_REVIEW',
      });
    } finally {
      await db.close();
    }
  });
});
