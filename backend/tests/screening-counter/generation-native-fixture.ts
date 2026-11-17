import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { splitMigration } from '../../src/db/migrations.js';
import { counterInstallationSql } from '../../src/modules/legacy-order-imports/screening-counter/writers.js';
import { counterGenerationDemands } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-demands.js';
import { counterGenerationJournal } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-journal.js';
import { counterGenerationDiscoverySource } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-discovery.js';
import {
  generationJournalKey,
  generationSourceKey,
  generationOptions,
  generationNow,
} from './generation-fixture.js';
/** Disposable protocol fixture. This intentionally does not pretend to qualify
 * publisher privileges: current-only discovery never mints native authority. */
export async function quotaGenerationNativeFixture(template: string) {
  const u = new URL(template);
  if (
    u.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(u.hostname) ||
    u.pathname !== '/pos_rewrite_legacy_order_imports_test' ||
    u.search ||
    u.hash
  )
    throw new Error('Isolated quota fixture required');
  const schema = 'quota_generation_' + randomUUID().replaceAll('-', '').slice(0, 16),
    connection = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
  await connection.changeUser({ database: schema });
  const pool = mysql.createPool({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: schema,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectionLimit: 24,
  });
  const db = { get: () => drizzle(pool) },
    clock = { now: generationNow };
  try {
    await connection.query('CREATE TABLE users(id BIGINT SIGNED PRIMARY KEY) ENGINE=InnoDB');
    for (const statement of counterInstallationSql)
      if (/^CREATE TABLE/i.test(statement.trim())) await connection.query(statement);
    for (const statement of splitMigration(
      readFileSync(
        'compatibility/upstream/screening-origins/screening-counter-generation-migration.sql',
        'utf8',
      ),
    ))
      await connection.query(statement);
    const [identity] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT @@server_uuid serverUuid',
    );
    const options = {
        ...generationOptions(),
        sourceSchema: schema,
        serverUuid: String(identity[0]!.serverUuid),
        discoveryBatchSize: 2,
      },
      demands = counterGenerationDemands(db, generationJournalKey, () => clock.now),
      journal = counterGenerationJournal(
        db,
        { journalKey: generationJournalKey, sourceKey: generationSourceKey },
        () => clock.now,
      ),
      source = counterGenerationDiscoverySource(db, options);
    return {
      schema,
      connection,
      pool,
      db,
      clock,
      options,
      demands,
      journal,
      source,
      async reset() {
        for (const table of [
          'pos_rewrite_screening_counter_generation_demands',
          'pos_rewrite_screening_counter_generation_cursors',
          'pos_rewrite_screening_counter_generation_jobs',
          'pos_rewrite_screening_counters',
          'pos_rewrite_screening_counter_heads',
          'pos_rewrite_screening_contributions',
          'users',
        ])
          await connection.query('DELETE FROM ' + mysql.escapeId(table));
        clock.now = generationNow;
      },
      async addUsers(...ids: string[]) {
        for (const id of ids) await connection.execute('INSERT INTO users VALUES(?)', [id]);
      },
      async close() {
        await pool.end();
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      },
    };
  } catch (error) {
    await pool.end();
    await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
    await connection.end();
    throw error;
  }
}
