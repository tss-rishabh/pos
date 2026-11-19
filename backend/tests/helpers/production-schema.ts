import { readFileSync } from 'node:fs';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';
import { z } from 'zod';

/**
 * The only place in the repository that turns DDL into tables.
 *
 * The rewrite ships no migrations and must run against the production schema exactly as it is
 * (AGENTS.md, schema freeze). MySQL-backed tests therefore build a disposable local schema from
 * the committed read-only production snapshot `tests/golden/schema/production-schema.json`
 * (`SHOW CREATE TABLE` output), creating only the tables a suite needs. No column, index or
 * trigger is added to that DDL. Callers must already be connected to an isolated loopback test
 * database that they created themselves.
 */

const snapshotColumn = z.object({
  COLUMN_NAME: z.string().regex(/^[A-Za-z_]\w*$/),
  ORDINAL_POSITION: z.number().int().positive(),
  COLUMN_TYPE: z.string().min(1),
  IS_NULLABLE: z.enum(['YES', 'NO']),
  COLUMN_DEFAULT: z.string().nullable(),
  COLUMN_KEY: z.string(),
  EXTRA: z.string(),
});
const snapshotSchema = z.object({
  tables: z.record(
    z.string().regex(/^[A-Za-z_]\w*$/),
    z.object({
      createTable: z.string().startsWith('CREATE TABLE `'),
      columns: z.array(snapshotColumn).min(1),
    }),
  ),
});

export interface ProductionColumn {
  name: string;
  /** `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE`, for example `bigint` or `enum('a','b')`. */
  type: string;
  nullable: boolean;
  default: string | null;
  autoIncrement: boolean;
  generatedDefault: boolean;
}

let cached: z.infer<typeof snapshotSchema>['tables'] | undefined;
function snapshot() {
  cached ??= snapshotSchema.parse(
    JSON.parse(
      readFileSync(new URL('../golden/schema/production-schema.json', import.meta.url), 'utf8'),
    ) as unknown,
  ).tables;
  return cached;
}

function tableName(table: string | MySqlTable): string {
  return typeof table === 'string' ? table : getTableConfig(table).name;
}

export function isProductionTable(table: string | MySqlTable): boolean {
  return Object.hasOwn(snapshot(), tableName(table));
}

export function productionTableNames(): readonly string[] {
  return Object.keys(snapshot());
}

/** Production columns in ordinal order. Throws for a table that is not in the snapshot. */
export function productionColumns(table: string | MySqlTable): readonly ProductionColumn[] {
  const name = tableName(table),
    entry = snapshot()[name];
  if (!entry) throw new Error(`Table ${name} is not in the production schema snapshot.`);
  return [...entry.columns]
    .sort((left, right) => left.ORDINAL_POSITION - right.ORDINAL_POSITION)
    .map((column) => ({
      name: column.COLUMN_NAME,
      type: column.COLUMN_TYPE,
      nullable: column.IS_NULLABLE === 'YES',
      default: column.COLUMN_DEFAULT,
      autoIncrement: column.EXTRA.includes('auto_increment'),
      generatedDefault: column.EXTRA.includes('DEFAULT_GENERATED'),
    }));
}

/** The production `SHOW CREATE TABLE` statement for one snapshot table. */
export function productionCreateTable(table: string | MySqlTable): string {
  const name = tableName(table),
    entry = snapshot()[name];
  if (!entry) throw new Error(`Table ${name} is not in the production schema snapshot.`);
  return entry.createTable;
}

/** Minimal mysql2 surface shared by connections, pool connections and pools. */
export interface SqlSession {
  query(sql: string, values?: unknown): Promise<unknown>;
}

async function currentDatabase(session: SqlSession): Promise<string> {
  const result = z
    .tuple([z.array(z.object({ name: z.string().nullable() })).length(1)], z.unknown())
    .parse(await session.query('SELECT DATABASE() AS name'));
  const name = result[0][0]!.name;
  if (
    !name ||
    !/^[A-Za-z0-9_]+$/.test(name) ||
    /^(?:mysql|sys|information_schema|performance_schema)$/i.test(name)
  )
    throw new Error('Production-schema fixtures need an isolated test database selected.');
  return name;
}

/**
 * Creates the named production tables, byte-for-byte from the snapshot DDL, in the session's
 * current (isolated) database. Accepts table names or Drizzle tables; duplicates are ignored.
 * Foreign-key checks and `sql_mode` are relaxed only for this session while creating, so a
 * subset of tables (and legacy zero-date defaults) can be created, then both are restored.
 */
export async function createProductionTables(
  session: SqlSession,
  tables: readonly (string | MySqlTable)[],
): Promise<void> {
  const names = [...new Set(tables.map(tableName))],
    entries = snapshot(),
    missing = names.filter((name) => !Object.hasOwn(entries, name));
  if (missing.length)
    throw new Error(`Tables not in the production schema snapshot: ${missing.join(', ')}`);
  await currentDatabase(session);
  await session.query(
    'SET @fixture_previous_mode = @@SESSION.sql_mode, @fixture_previous_fk = @@SESSION.foreign_key_checks',
  );
  await session.query("SET SESSION sql_mode = '', SESSION foreign_key_checks = 0");
  try {
    for (const name of names) await session.query(entries[name]!.createTable);
  } finally {
    await session.query(
      'SET SESSION sql_mode = @fixture_previous_mode, SESSION foreign_key_checks = @fixture_previous_fk',
    );
  }
}

/**
 * Creates a fresh isolated database on a loopback test server, selects it on `session`, and
 * creates the requested production tables there. Returns the database name.
 */
export async function createProductionSchema(
  session: SqlSession & { changeUser?: (options: { database: string }) => Promise<unknown> },
  databaseName: string,
  tables: readonly (string | MySqlTable)[],
): Promise<string> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(databaseName))
    throw new Error('Fixture database names must be plain identifiers.');
  await session.query(`CREATE DATABASE ${mysql.escapeId(databaseName)}`);
  if (session.changeUser) await session.changeUser({ database: databaseName });
  else await session.query(`USE ${mysql.escapeId(databaseName)}`);
  await createProductionTables(session, tables);
  return databaseName;
}

export interface WriteFailure {
  /** Production table whose writes fail. */
  table: string | MySqlTable;
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  /** SQLSTATE 45000 message raised by the failing write. */
  message: string;
  /** Fail only rows whose new (or, for DELETE, old) column value equals this value. */
  when?: { column: string; equals: string | number };
}

/**
 * Test-only fault injection on a disposable fixture schema: makes matching writes to a
 * production table fail with SQLSTATE 45000 so a suite can prove its transaction rolls back.
 * This never alters a table definition. Returns a function that removes the injected fault.
 */
export async function injectWriteFailure(
  session: SqlSession,
  failure: WriteFailure,
): Promise<() => Promise<void>> {
  const table = tableName(failure.table);
  if (!isProductionTable(table))
    throw new Error(`Table ${table} is not in the production schema snapshot.`);
  await currentDatabase(session);
  const columns = productionColumns(table),
    when = failure.when;
  if (when && !columns.some((column) => column.name === when.column))
    throw new Error(`Column ${when.column} is not a production column of ${table}.`);
  const name = `fixture_fault_${table}_${failure.event.toLowerCase()}`.slice(0, 64),
    row = failure.event === 'DELETE' ? 'OLD' : 'NEW',
    signal = `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT=${mysql.escape(failure.message)}`,
    body = when
      ? `BEGIN IF ${row}.${mysql.escapeId(when.column)}=${mysql.escape(when.equals)} THEN ${signal}; END IF; END`
      : signal;
  await session.query(
    `CREATE TRIGGER ${mysql.escapeId(name)} BEFORE ${failure.event} ON ${mysql.escapeId(table)} FOR EACH ROW ${body}`,
  );
  return async () => {
    await session.query(`DROP TRIGGER IF EXISTS ${mysql.escapeId(name)}`);
  };
}
