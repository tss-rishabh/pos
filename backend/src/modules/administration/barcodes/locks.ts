import { eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../checkins.js';
import { catalogMaintenanceLocks } from '../../catalog-details/maintenance-schema.js';

/** All participating GS1 writers take this lock BEFORE any product/GS1 row lock. */
export async function lockBarcodeMutation(transaction: AdministrationTransaction): Promise<void> {
  const id = 'barcode-mutations';
  await transaction
    .insert(catalogMaintenanceLocks)
    .values({ id })
    .onDuplicateKeyUpdate({ set: { id } });
  await transaction
    .select({ id: catalogMaintenanceLocks.id })
    .from(catalogMaintenanceLocks)
    .where(eq(catalogMaintenanceLocks.id, id))
    .limit(1)
    .for('update');
}
