import { asc, eq } from 'drizzle-orm';
import type { Principal, Role } from '../../../domain/access.js';
import { requireRole } from '../../../domain/access.js';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { PosUser, UserStore } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../checkins.js';
import type { ImportActor } from '../import-profile.js';
export interface ParentImportActor extends ImportActor {
  userType: 1 | 2;
  storeIds: string[];
}
export function authorizeParentImport(user: Principal) {
  requireRole(user, [1, 2, 3, 4, 5]);
  identifier.parse(user.id);
  if (![1, 2].includes(user.userType))
    throw new AppError(
      403,
      'PARENT_STORE_IMPORT_DENIED',
      'This account cannot manage store associations.',
    );
}
export async function currentParentImportActor(
  tx: AdministrationTransaction,
  id: string,
): Promise<ParentImportActor> {
  const [user] = await tx
    .select({ role: PosUser.role, userType: PosUser.user_type, active: PosUser.is_active })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(id)))
    .limit(1)
    .for('share');
  if (!user?.active || ![1, 2, 3, 4, 5].includes(user.role) || ![1, 2].includes(user.userType))
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (user.role === 1 && user.userType === 1)
    return { role: 1, userType: 1, allActors: true, storeIds: [] };
  const assignments = await tx
    .select({ id: UserStore.store_id })
    .from(UserStore)
    .where(eq(UserStore.django_user_id, BigInt(id)))
    .orderBy(asc(UserStore.store_id))
    .limit(5001)
    .for('share');
  if (assignments.length > 5000)
    throw new AppError(
      503,
      'PARENT_STORE_SCOPE_TOO_WIDE',
      'Reconcile this operator store scope before importing.',
    );
  return {
    role: user.role as Role,
    userType: user.userType as 1 | 2,
    allActors: user.role === 1 && user.userType === 1,
    storeIds: [
      ...new Set(
        assignments.flatMap((row) => (row.id !== null && row.id > 0n ? [String(row.id)] : [])),
      ),
    ],
  };
}
