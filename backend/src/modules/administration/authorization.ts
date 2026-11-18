import { and, eq, sql } from 'drizzle-orm';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { Role } from '../../domain/access.js';
import type { AdministrationTransaction } from './checkins.js';

/** Call inside the writer transaction; shared locks prevent revocation during the mutation. */
export async function assertCurrentOperatorIdentity(
  transaction: AdministrationTransaction,
  userId: string,
  allowedRoles: readonly Role[],
): Promise<{ role: Role; userType: 1 | 2 }> {
  const [identity] = await transaction
    .select({ role: PosUser.role, active: PosUser.is_active, userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(userId)))
    .limit(1)
    .for('share');
  if (
    !identity?.active ||
    ![1, 2, 3, 4, 5].includes(identity.role) ||
    ![1, 2].includes(identity.userType)
  )
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (!allowedRoles.some((role) => role === identity.role))
    throw new AppError(
      403,
      'ROLE_ACCESS_DENIED',
      'This action requires a permitted operator role.',
    );
  return { role: identity.role as Role, userType: identity.userType === 1 ? 1 : 2 };
}
export async function assertCurrentOperatorRole(
  transaction: AdministrationTransaction,
  userId: string,
  allowedRoles: readonly Role[],
): Promise<Role> {
  return (await assertCurrentOperatorIdentity(transaction, userId, allowedRoles)).role;
}
export async function assertCurrentStoreAccess(
  transaction: AdministrationTransaction,
  userId: string,
  storeId: string,
  allowedRoles: readonly Role[] = [1, 2, 3, 4, 5],
  storeLock: 'share' | 'update' = 'update',
): Promise<void> {
  const identity = await assertCurrentOperatorIdentity(transaction, userId, allowedRoles);
  // Writer callers subsequently mutate this Store or its financial children.
  // Take their final lock mode before assignment/check-in/Order locks: a shared
  // lock followed by an upgrade can deadlock two otherwise independent actors.
  // Pure readers may explicitly retain a shared lock and must not upgrade it.
  const [store] = await transaction
    .select({ category: Store.category })
    .from(Store)
    .where(eq(Store.id, BigInt(storeId)))
    .limit(1)
    .for(storeLock);
  if (identity.role === 1 && identity.userType === 1) return;
  if (identity.userType === 2) {
    if (store?.category !== 'FRANCHISE')
      throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
  }
  const [assignment] = await transaction
    .select({ id: UserStore.id })
    .from(UserStore)
    .where(
      and(eq(UserStore.django_user_id, BigInt(userId)), eq(UserStore.store_id, sql`${storeId}`)),
    )
    .limit(1)
    .for('share');
  if (!assignment)
    throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
}

export async function assertCurrentInventoryAccess(
  transaction: AdministrationTransaction,
  userId: string,
  storeId: string,
): Promise<void> {
  await assertCurrentStoreAccess(transaction, userId, storeId, [1, 2, 3]);
  const [identity] = await transaction
    .select({ userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(userId)))
    .limit(1);
  if (identity?.userType !== 1)
    throw new AppError(
      403,
      'INVENTORY_ADMINISTRATION_DENIED',
      'Stock administration is restricted for this user type.',
    );
}
