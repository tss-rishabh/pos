import { eq } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store } from '../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { AppError } from '../../domain/errors.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
/** Native permissions only; no historical order facts and no locks spanning warehouse I/O. */
export function orderReadAuthority(db: Databases) {
  return async (user: Principal, storeId: string) => {
    requireStore(user, storeId);
    return db.get('writer').transaction(async (tx) => {
      await assertCurrentStoreAccess(tx, user.id, storeId);
      const [store] = await tx
        .select({ id: Store.id })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1)
        .for('share');
      const [actor] = await tx
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(user.id)))
        .limit(1)
        .for('share');
      if (
        !store ||
        !actor?.is_active ||
        actor.role !== user.role ||
        actor.user_type !== user.userType
      )
        throw new AppError(
          403,
          'ORDER_READ_SCOPE_CHANGED',
          'Your order-viewing permissions changed. Refresh this store.',
        );
      return currentAuthenticationVersion(tx, actor);
    });
  };
}
