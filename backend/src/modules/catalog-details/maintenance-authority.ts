import { eq } from 'drizzle-orm';
import { PosUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
export function assertMaintenancePrincipal(user: Principal) {
  if (user.role !== 1 || user.userType !== 1 || !identifier.safeParse(user.id).success)
    throw new AppError(
      403,
      'CATALOG_MAINTENANCE_DENIED',
      'Catalog maintenance requires an internal administrator.',
    );
}
/** Global SKU operations cannot be safely scoped by a store ID absent from the legacy payload. */
export async function assertCurrentMaintenanceOperator(
  transaction: AdministrationTransaction,
  userId: string,
) {
  const [user] = await transaction
    .select({ active: PosUser.is_active, role: PosUser.role, type: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(userId)))
    .limit(1)
    .for('share');
  if (!user?.active || user.role !== 1 || user.type !== 1)
    throw new AppError(
      403,
      'CATALOG_MAINTENANCE_DENIED',
      'Catalog maintenance requires a current internal administrator.',
    );
}
