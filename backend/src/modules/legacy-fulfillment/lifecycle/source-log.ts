import { and, eq, sql } from 'drizzle-orm';
import { mysqlSchema, varchar } from 'drizzle-orm/mysql-core';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { legacyHyperlocalLogs } from '../schema.js';

const sourceColumns = mysqlSchema('information_schema').table('COLUMNS', {
  schema: varchar('TABLE_SCHEMA', { length: 64 }).notNull(),
  table: varchar('TABLE_NAME', { length: 64 }).notNull(),
  column: varchar('COLUMN_NAME', { length: 64 }).notNull(),
  type: varchar('DATA_TYPE', { length: 64 }).notNull(),
  nullable: varchar('IS_NULLABLE', { length: 3 }).notNull(),
  default: varchar('COLUMN_DEFAULT', { length: 255 }),
});
/** The live source is NOT NULL/no default. Readiness requires the reviewed nullable correction. */
export async function assertInitialDeliveryLogContract(tx: AdministrationTransaction) {
  const [column] = await tx
    .select({
      type: sourceColumns.type,
      nullable: sourceColumns.nullable,
      default: sourceColumns.default,
    })
    .from(sourceColumns)
    .where(
      and(
        eq(sourceColumns.schema, sql`DATABASE()`),
        eq(sourceColumns.table, 'hyperlocal_order_log'),
        eq(sourceColumns.column, 'delivery_exception_date'),
      ),
    )
    .limit(1);
  if (!column || column.type !== 'datetime' || column.nullable !== 'YES' || column.default !== null)
    throw new AppError(
      503,
      'LOCAL_DELIVERY_LOG_SCHEMA_UNAVAILABLE',
      'Initial delivery recording is unavailable until its database compatibility correction is deployed.',
    );
}
/** Caller holds the order row. No record is fabricated at arrival or transfer time. */
export async function ensureDeliveryLog(
  tx: AdministrationTransaction,
  orderId: string,
  timestamp: string,
) {
  const [existing] = await tx
    .select({ id: legacyHyperlocalLogs.id })
    .from(legacyHyperlocalLogs)
    .where(eq(legacyHyperlocalLogs.orderId, BigInt(orderId)))
    .limit(1)
    .for('share');
  if (existing) return;
  await assertInitialDeliveryLogContract(tx);
  await tx.insert(legacyHyperlocalLogs).values({
    orderId: BigInt(orderId),
    borzoId: 0n,
    action: 'NO_ACTION',
    mainStoreId: 0,
    createdInBorzo: 0,
    packed: 0,
    rto: 0,
    received: 0,
    refunded: 0,
    posAdminId: 0,
    sourceTracking: '',
    destinationTracking: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    // Production delivery_exception_date is NOT NULL without default. This insert is
    // reachable only after assertInitialDeliveryLogContract has proved the reviewed
    // nullable correction (it fails closed on production), so NULL is written as SQL.
    // Recorded as NEEDS USER DECISION in parity/w7-report.md.
    deliveryExceptionDate: sql`NULL`,
  });
}
