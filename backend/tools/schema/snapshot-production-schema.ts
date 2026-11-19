/**
 * Captures the exact production DDL for every non-rewrite table referenced by Drizzle schemas.
 *
 * Read-only: the session is set READ ONLY and only INFORMATION_SCHEMA / SHOW CREATE TABLE run.
 * Credentials come only from POS_PROD_RO_MYSQL_URL and are never printed or written.
 * AUTO_INCREMENT counters are stripped because they are data, not schema.
 *
 * Usage: POS_PROD_RO_MYSQL_URL=mysql://user:pass@host:3306/tss \
 *   node --import tsx tools/schema/snapshot-production-schema.ts [extra_table ...]
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = join(backendRoot, 'tests/golden/schema/production-schema.json');
const caPath = resolve(backendRoot, '../global-bundle.pem');

const envSchema = z.object({
  POS_PROD_RO_MYSQL_URL: z.string().url().startsWith('mysql://'),
  POS_PROD_RO_MYSQL_CA: z.string().min(1).optional(),
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

export function referencedProductionTables(srcDir: string): string[] {
  const pattern = /mysqlTable\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  const names = new Set<string>();
  for (const file of sourceFiles(srcDir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && !name.startsWith('pos_rewrite_')) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Production tables captured in addition to the Drizzle-referenced ones: tables read only by raw
 * report SQL or by test fixtures. With them, a plain rerun reproduces the committed 119-table set.
 */
export const DEFAULT_EXTRA_TABLES: readonly string[] = [
  'auth_permission',
  'automated_refund_sic_logs',
  'bank_transfer_requests',
  'cancel_orders',
  'coupons_users',
  'django_session',
  'flag_history',
  'hyperlocal_availability_log',
  'jp_customers',
  'order_attributes',
  'order_cancel_message_mapping',
  'order_coupon_log',
  'order_freebie_triggers',
  'order_freebies',
  'order_tss_money',
  'order_tss_point',
  'refund_alternate_payment_details',
  'refund_requests',
  'reward_point_history',
  'user_detail_logs',
  'user_email_membership_copy_logs',
  'welcome_offer',
];

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
  EXTRA: string;
  CHARACTER_SET_NAME: string | null;
  COLLATION_NAME: string | null;
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const url = new URL(env.POS_PROD_RO_MYSQL_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'tss';
  const tables = [...new Set([...referencedProductionTables(join(backendRoot, 'src')), ...DEFAULT_EXTRA_TABLES, ...process.argv.slice(2)])].sort();

  const conn = await mysql.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectTimeout: 10_000,
    ssl: { ca: readFileSync(env.POS_PROD_RO_MYSQL_CA ?? caPath), rejectUnauthorized: true },
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('SET SESSION MAX_EXECUTION_TIME=10000');
    const [versionRows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const [columns] = await conn.query<ColumnRow[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
              COLUMN_KEY, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database, tables],
    );
    const present = new Set(columns.map((c) => c.TABLE_NAME));
    const snapshot: Record<string, { createTable: string; columns: Omit<ColumnRow, 'TABLE_NAME' | keyof RowDataPacket>[] }> = {};
    for (const table of tables.filter((t) => present.has(t))) {
      const [rows] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE ${mysql.escapeId(table)}`);
      const ddl = String(rows[0]?.['Create Table'] ?? '').replace(/ AUTO_INCREMENT=\d+/, '');
      snapshot[table] = {
        createTable: ddl,
        columns: columns
          .filter((c) => c.TABLE_NAME === table)
          .map((c) => ({
            COLUMN_NAME: c.COLUMN_NAME,
            ORDINAL_POSITION: c.ORDINAL_POSITION,
            COLUMN_TYPE: c.COLUMN_TYPE,
            IS_NULLABLE: c.IS_NULLABLE,
            COLUMN_DEFAULT: c.COLUMN_DEFAULT,
            COLUMN_KEY: c.COLUMN_KEY,
            EXTRA: c.EXTRA,
            CHARACTER_SET_NAME: c.CHARACTER_SET_NAME,
            COLLATION_NAME: c.COLLATION_NAME,
          })),
      };
    }
    const missing = tables.filter((t) => !present.has(t));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      `${JSON.stringify(
        { capturedAt: new Date().toISOString(), database, serverVersion: String(versionRows[0]?.['version'] ?? ''), missing, tables: snapshot },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`captured ${Object.keys(snapshot).length} tables; missing in ${database}: ${missing.join(', ') || 'none'}\n`);
  } finally {
    await conn.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
    process.stderr.write(`schema snapshot failed: ${code}\n`);
    process.exitCode = 1;
  });
}
