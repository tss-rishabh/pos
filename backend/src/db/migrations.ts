import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { databasePool, type Databases } from './pools.js';
import type { Config } from '../config.js';

export const migrationPaths = [
  'migrations/0001_rewrite_state.sql',
  'migrations/0002_auth_sessions.sql',
  'migrations/0003_login_challenges.sql',
  'migrations/0004_auth_security_alerts.sql',
  'migrations/0005_profile_media.sql',
  'migrations/0006_operator_auth_epochs.sql',
  'migrations/0007_google_identities.sql',
  'migrations/0008_desktop_sso.sql',
  'src/modules/administration/migration.sql',
  'src/modules/gift-card-batches/migration.sql',
  'src/modules/administration/media-migration.sql',
  'src/modules/administration/settings-migration.sql',
  'src/modules/administration/ecommerce-sync/migration.sql',
  'src/modules/administration/import-migration.sql',
  'src/modules/administration/parent-store-imports/migration.sql',
  'src/modules/administration/mfa-migration.sql',
  'src/modules/administration/store-image-migration.sql',
  'src/modules/administration/access-migration.sql',
  'src/modules/administration/slack-migration.sql',
  'src/modules/application-links/migration.sql',
  'src/modules/checkout/migrations/0002_checkout.sql',
  'src/modules/checkout/migrations/0003_payments.sql',
  'src/modules/checkout/payments/legacy-migration.sql',
  'src/modules/checkout/migrations/0004_returns.sql',
  'src/modules/checkout/migrations/0005_financial_delivery_context.sql',
  'src/modules/checkout/migrations/0006_discount_approvals.sql',
  'src/modules/checkout/migrations/0007_exchange_stock_proof.sql',
  'src/modules/checkout/migrations/0008_checkout_draft_binding.sql',
  'src/modules/checkout/migrations/0009_checkout_projection_proof.sql',
  'src/modules/checkout/migrations/0010_customer_registration.sql',
  'src/modules/checkout/migrations/0011_offline_cash.sql',
  'src/modules/checkout/migrations/0012_offline_cash_receipt_identity.sql',
  'src/modules/checkout/migrations/0013_offline_cash_import_proof.sql',
  'src/modules/checkout/migrations/0014_wallet_adjustments.sql',
  'src/modules/checkout/migrations/0015_gift_card_issuance.sql',
  'src/modules/checkout/migrations/0016_product_feedback.sql',
  'src/modules/checkout/migrations/0017_customer_consent_proof.sql',
  'src/modules/checkout/order-copy/migration.sql',
  'src/modules/checkout/order-copy/cancellation-migration.sql',
  'src/modules/checkout/cancellations/migration.sql',
  'src/modules/checkout/cancellations/benefit-migration.sql',
  'src/modules/checkout/cancellations/membership-producer-migration.sql',
  'src/modules/customer-insights/migration.sql',
  'src/modules/customer-contacts/migration.sql',
  'src/modules/customer-contacts/contact-revisions-migration.sql',
  'src/modules/customer-otp/migration.sql',
  'src/modules/customer-website-handoff/migration.sql',
  'src/modules/global-vouchers/migration.sql',
  'src/modules/legacy-order-imports/migration.sql',
  'src/modules/legacy-order-imports/resumption-migration.sql',
  'src/modules/checkout-performance/migration.sql',
  'src/modules/checkout/order-messages/migration.sql',
  'src/modules/checkout/payment-reversals/migration.sql',
  'compatibility/customer-contacts/migration.sql',
  'compatibility/upstream/ordinary/migration.sql',
  'src/modules/fulfillment/migration.sql',
  'src/modules/fulfillment/trace-migration.sql',
  'src/modules/legacy-fulfillment/migration.sql',
  'src/modules/legacy-fulfillment/lifecycle/migration.sql',
  'src/modules/legacy-order-status/migration.sql',
  'src/modules/legacy-order-status/repair-migration.sql',
  'src/modules/finance/migration.sql',
  'src/modules/legacy-order-imports/financial-proof-migration.sql',
  'src/modules/operational-reports/migration.sql',
  'src/modules/operational-reports/scheduled-migration.sql',
  'src/modules/catalog-details/maintenance-migration.sql',
  'src/modules/administration/barcodes/migration.sql',
] as const;
export class MigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface Migration {
  id: string;
  checksum: string;
  statements: string[];
}

/** This deliberately supports ordinary SQL, not DELIMITER or stored routines. */
export function splitMigration(source: string): string[] {
  const statements: string[] = [];
  let current = '',
    quote = '',
    lineComment = false,
    blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i]!,
      next = source[i + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        current += '\n';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        i++;
        current += ' ';
      }
      continue;
    }
    if (quote) {
      current += character;
      if (character === '\\' && next !== undefined) {
        current += next;
        i++;
        continue;
      }
      if (character === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = '';
      }
      continue;
    }
    if (character === '-' && next === '-' && /\s/.test(source[i + 2] || ' ')) {
      lineComment = true;
      i++;
      continue;
    }
    if (character === '#') {
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += character;
  }
  if (quote || blockComment) throw new MigrationError('INVALID_MIGRATION_SQL');
  if (current.trim()) statements.push(current.trim());
  for (const statement of statements)
    if (
      !/^(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+|INSERT\s+(?:IGNORE\s+)?INTO\s+|CREATE\s+(?:UNIQUE\s+)?INDEX\s+`?\w+`?\s+ON\s+)`?pos_rewrite_[a-z0-9_]+`?(?:\s|\()/i.test(
        statement,
      )
    )
      throw new MigrationError('LEGACY_SCHEMA_MUTATION_FORBIDDEN');
  return statements;
}
export function migrationPlan(): Migration[] {
  return migrationPaths.map((id) => {
    const content = readFileSync(fileURLToPath(new URL('../../' + id, import.meta.url)), 'utf8');
    return {
      id,
      checksum: createHash('sha256').update(content).digest('hex'),
      statements: splitMigration(content),
    };
  });
}
const versions = mysqlTable('pos_rewrite_schema_migrations', {
  id: varchar('id', { length: 255 }).primaryKey(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  appliedAt: datetime('applied_at', { mode: 'date', fsp: 3 }).notNull(),
});
const steps = mysqlTable('pos_rewrite_schema_migration_steps', {
  id: varchar('id', { length: 255 }).notNull(),
  step: int('step').notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
  completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
});

/** Readiness checks the immutable journal; it never creates or repairs schema. */
export async function assertMigrationsCurrent(db: Databases) {
  const plan = migrationPlan(),
    ids = plan.map((migration) => migration.id),
    writer = db.get('writer');
  const applied = await writer
      .select({ id: versions.id, checksum: versions.checksum })
      .from(versions)
      .where(inArray(versions.id, ids))
      .limit(plan.length),
    checksums = new Map(applied.map((row) => [row.id, row.checksum]));
  if (plan.some((migration) => checksums.get(migration.id) !== migration.checksum))
    throw new MigrationError('MIGRATION_NOT_CURRENT');
  const [unfinished] = await writer
    .select({ id: steps.id })
    .from(steps)
    .where(and(inArray(steps.id, ids), ne(steps.state, 'applied')))
    .limit(1);
  if (unfinished) throw new MigrationError('MIGRATION_STEP_NEEDS_REVIEW');
}

/** DDL implicitly commits in MySQL. An interrupted step requires explicit operator review. */
export async function applyMigrations(config: Config, plan: Migration[] = migrationPlan()) {
  if (!config.MYSQL_WRITER_URL) throw new MigrationError('MYSQL_WRITER_REQUIRED');
  const pool = databasePool(config.MYSQL_WRITER_URL, config),
    connection = await pool.getConnection().catch(async (error) => {
      await pool.end();
      throw error;
    });
  const database = drizzle(connection),
    schema = new URL(config.MYSQL_WRITER_URL).pathname;
  const lock =
    'pos-rewrite-migrations:' + createHash('sha256').update(schema).digest('hex').slice(0, 24);
  let acquired = false;
  const applied: string[] = [],
    skipped: string[] = [];
  try {
    const lockResult = await database.execute(sql`SELECT GET_LOCK(${lock},10) AS acquired`);
    const rows = lockResult[0];
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      typeof rows[0] !== 'object' ||
      rows[0] === null ||
      !('acquired' in rows[0]) ||
      !['1', 1].includes(rows[0].acquired as string | number)
    )
      throw new MigrationError('MIGRATION_LOCK_UNAVAILABLE');
    acquired = true;
    await database.execute(
      sql`CREATE TABLE IF NOT EXISTS pos_rewrite_schema_migrations (id VARCHAR(255) NOT NULL PRIMARY KEY,checksum VARCHAR(64) NOT NULL,applied_at DATETIME(3) NOT NULL) ENGINE=InnoDB`,
    );
    await database.execute(
      sql`CREATE TABLE IF NOT EXISTS pos_rewrite_schema_migration_steps (id VARCHAR(255) NOT NULL,step INT NOT NULL,checksum VARCHAR(64) NOT NULL,state VARCHAR(16) NOT NULL,started_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,PRIMARY KEY(id,step)) ENGINE=InnoDB`,
    );
    for (const migration of plan) {
      if (
        !migrationPaths.includes(migration.id as (typeof migrationPaths)[number]) ||
        !/^[a-f0-9]{64}$/.test(migration.checksum) ||
        splitMigration(migration.statements.join(';')).length !== migration.statements.length
      )
        throw new MigrationError('INVALID_MIGRATION_PLAN');
      const [version] = await database
        .select()
        .from(versions)
        .where(eq(versions.id, migration.id))
        .limit(1);
      if (version) {
        if (version.checksum !== migration.checksum)
          throw new MigrationError('APPLIED_MIGRATION_CHANGED');
        skipped.push(migration.id);
        continue;
      }
      for (const [step, statement] of migration.statements.entries()) {
        const condition = and(eq(steps.id, migration.id), eq(steps.step, step));
        const [prior] = await database.select().from(steps).where(condition).limit(1);
        if (prior) {
          if (prior.checksum !== migration.checksum)
            throw new MigrationError('PARTIAL_MIGRATION_CHANGED');
          if (prior.state !== 'applied') throw new MigrationError('MIGRATION_STEP_NEEDS_REVIEW');
          continue;
        }
        await database.insert(steps).values({
          id: migration.id,
          step,
          checksum: migration.checksum,
          state: 'started',
          startedAt: new Date(),
        });
        await database.execute(sql.raw(statement));
        await database
          .update(steps)
          .set({ state: 'applied', completedAt: new Date() })
          .where(condition);
      }
      await database
        .insert(versions)
        .values({ id: migration.id, checksum: migration.checksum, appliedAt: new Date() });
      applied.push(migration.id);
    }
    return { applied, skipped };
  } finally {
    if (acquired) await database.execute(sql`SELECT RELEASE_LOCK(${lock})`).catch(() => undefined);
    connection.release();
    await pool.end();
  }
}
