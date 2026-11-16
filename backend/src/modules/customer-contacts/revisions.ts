import { eq, sql } from 'drizzle-orm';
import { bigint, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';

/** Perpetual monotonic identity fence. Never delete/reset this row on archive/reactivation. */
export const customerContactRevisions = mysqlTable('pos_rewrite_customer_contact_revisions', {
  customerId: varchar('customer_id', { length: 32 }).primaryKey(),
  revision: bigint('revision', { mode: 'bigint', unsigned: true }).notNull().default(0n),
});
/** Caller has already locked the MUser row. Locking read bypasses an older RR snapshot. */
export async function readCurrentContactRevision(
  tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  identifier.parse(customerId);
  const [row] = await tx
    .select({ revision: customerContactRevisions.revision })
    .from(customerContactRevisions)
    .where(eq(customerContactRevisions.customerId, customerId))
    .limit(1)
    .for('share');
  const revision = row?.revision ?? 0n;
  if (revision < 0n || revision > 18446744073709551615n)
    throw new AppError(
      503,
      'CUSTOMER_CONTACT_REVISION_INVALID',
      'Customer verification requires review.',
    );
  return revision;
}
/** Seed before a prospective contact mutation, under the MUser lock; avoid missing-key gap upgrades. */
export async function ensureCustomerContactRevision(
  tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  identifier.parse(customerId);
  await tx
    .insert(customerContactRevisions)
    .values({ customerId, revision: 0n })
    .onDuplicateKeyUpdate({ set: { customerId } });
  return readCurrentContactRevision(tx, customerId);
}
/** Caller holds the same MUser lock; include this bump in its successful contact mutation transaction. */
export async function bumpCurrentContactRevision(
  tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  identifier.parse(customerId);
  await tx
    .insert(customerContactRevisions)
    .values({ customerId, revision: 1n })
    .onDuplicateKeyUpdate({ set: { revision: sql`${customerContactRevisions.revision}+1` } });
  return readCurrentContactRevision(tx, customerId);
}
