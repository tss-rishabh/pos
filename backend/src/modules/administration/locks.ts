import { eq } from 'drizzle-orm';
import type { AdministrationTransaction } from './checkins.js';
import { administrationRegistries } from './schema.js';
import { unavailable } from '../../domain/errors.js';

/** Low-frequency identity writes share a database lock across all application instances. */
export async function lockAdministrationRegistry(
  transaction: AdministrationTransaction,
  resource:
    | 'stores'
    | 'operators'
    | 'salespeople'
    | 'documentation'
    | 'settings'
    | 'inventory-imports'
    | 'access-control'
    | 'gift-card-batches',
) {
  const [registry] = await transaction
    .select({ resource: administrationRegistries.resource })
    .from(administrationRegistries)
    .where(eq(administrationRegistries.resource, resource))
    .limit(1)
    .for('update');
  if (!registry) return unavailable('Administration registry migration');
}
