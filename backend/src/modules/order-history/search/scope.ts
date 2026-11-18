import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { PosUser, Store, UserStore } from '../../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../../auth/revocation.js';
import { AppError } from '../../../domain/errors.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService } from '../../administration/checkins.js';
import type { OrderSearchInput, SourceSearchScope } from './contracts.js';
const denied = () =>
  new AppError(
    403,
    'ORDER_SEARCH_SCOPE_DENIED',
    'This order selection is outside your current store permissions.',
  );
const py = (value: string | null) => (value === null ? 'None' : value);
export function sourceSearchAuthority(config: Config, db: Databases) {
  const checkIns = checkInService(db, config);
  return async function capture(
    user: Principal,
    contextStoreId: string,
    input: OrderSearchInput,
  ): Promise<SourceSearchScope> {
    requireStore(user, contextStoreId);
    const checkedInStoreId = await checkIns.checkedInStore(user.id),
      queue = input.inQueue || input.notPacked;
    return db.get('writer').transaction(async (tx) => {
      await assertCurrentStoreAccess(tx, user.id, contextStoreId);
      const [actor] = await tx
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(user.id)))
        .limit(1)
        .for('share');
      if (!actor?.is_active || actor.role !== user.role || actor.user_type !== user.userType)
        throw denied();
      const internal = actor.role === 1 && actor.user_type === 1,
        franchiseViewer = actor.user_type === 2;
      const allowed = (
        internal
          ? await tx.select({ id: Store.id }).from(Store).for('share')
          : await tx
              .select({ id: Store.id })
              .from(Store)
              .innerJoin(
                UserStore,
                and(
                  eq(UserStore.store_id, Store.id),
                  eq(UserStore.django_user_id, BigInt(user.id)),
                ),
              )
              .for('share')
      ).map((row) => String(row.id));
      const allowedStores = [...new Set(allowed)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      if (
        !allowedStores.includes(contextStoreId) ||
        input.storeIds.some((id) => !allowedStores.includes(id))
      )
        throw denied();
      const effectiveType = queue ? 'HL' : input.orderType,
        explicitIds = !queue && Boolean(input.orderIds.length);
      if ((queue || (effectiveType === 'HL' && !explicitIds)) && !checkedInStoreId)
        throw new AppError(
          409,
          'ORDER_QUEUE_CHECK_IN_REQUIRED',
          'Check in to a store before opening its local-delivery queue.',
        );
      let heLocationLabel: string | null = null;
      if (effectiveType === 'HE' && input.storeIds.length) {
        const [store] = await tx
          .select({ name: Store.store_name, code: Store.location_code })
          .from(Store)
          .where(eq(Store.id, BigInt(input.storeIds[0]!)))
          .limit(1)
          .for('share');
        if (!store) throw denied();
        heLocationLabel = `${py(store.code)} (${py(store.name)})`;
      }
      return {
        contextStoreId,
        checkedInStoreId,
        allowedStores,
        internal,
        franchiseViewer,
        effectiveType,
        selectedStores: input.storeIds,
        explicitIds,
        heLocationLabel,
        binding: createHash('sha256')
          .update(
            JSON.stringify([
              user.id,
              actor.role,
              actor.user_type,
              await currentAuthenticationVersion(tx, actor),
              allowedStores,
              checkedInStoreId,
              effectiveType,
              input.storeIds,
              explicitIds,
            ]),
          )
          .digest('hex'),
      };
    });
  };
}
