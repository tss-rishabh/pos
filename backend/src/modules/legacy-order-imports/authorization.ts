import { and, asc, eq, inArray } from 'drizzle-orm';
import { PosUser, Store, StoreCounter, UserStore } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { assertCurrentOperatorRole } from '../administration/authorization.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ImportScope } from './sealed-groups.js';

export type ImportAuthorizer = (
  tx: AdministrationTransaction,
  actorId: string,
  scopes: readonly ImportScope[],
) => Promise<void>;
export async function authorizeLegacyOrderImportActor(
  tx: AdministrationTransaction,
  actorId: string,
) {
  const role = await assertCurrentOperatorRole(tx, identifier.parse(actorId), [1, 2, 3]);
  const [operator] = await tx
    .select({ userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(actorId)))
    .limit(1);
  if (operator?.userType !== 1)
    throw new AppError(
      403,
      'ORDER_IMPORT_ACCESS_DENIED',
      'Historical order imports require internal administration access.',
    );
  return role;
}
export const authorizeLegacyOrderImport: ImportAuthorizer = async (tx, actorId, scopes) => {
  const role = await authorizeLegacyOrderImportActor(tx, actorId);
  if (
    !scopes.length ||
    scopes.length > 100 ||
    new Set(scopes.map((scope) => scope.storeId)).size !== scopes.length
  )
    throw new AppError(
      422,
      'ORDER_IMPORT_COUNTER_SCOPE_INVALID',
      'Select one counter for each imported store.',
    );
  for (const scope of scopes) {
    identifier.parse(scope.storeId);
    identifier.parse(scope.counterId);
  }
  const ordered = [...scopes].sort((a, b) =>
    BigInt(a.storeId) < BigInt(b.storeId) ? -1 : BigInt(a.storeId) > BigInt(b.storeId) ? 1 : 0,
  );
  if (role !== 1) {
    const assignments = await tx
      .select({ storeId: UserStore.store_id })
      .from(UserStore)
      .where(
        and(
          eq(UserStore.django_user_id, BigInt(actorId)),
          inArray(
            UserStore.store_id,
          ordered.map((scope) => BigInt(scope.storeId)),
          ),
        ),
      )
      .orderBy(asc(UserStore.store_id))
      .for('share');
    const allowed = new Set(assignments.map((row) => String(row.storeId)));
    if (ordered.some((scope) => !allowed.has(scope.storeId)))
      throw new AppError(
        403,
        'STORE_ACCESS_DENIED',
        'You do not have access to an imported store.',
      );
  }
  // Authority scales with a bounded store set, not the number of CSV rows.
  // Shared locks retain each native decision until its staging/dispatch commit.
  const stores = await tx
      .select({ id: Store.id, active: Store.is_active, type: Store.type })
      .from(Store)
      .where(
        inArray(
          Store.id,
          ordered.map((scope) => BigInt(scope.storeId)),
        ),
      )
      .orderBy(asc(Store.id))
      .for('share'),
    storeMap = new Map(stores.map((store) => [String(store.id), store]));
  if (
    ordered.some((scope) => {
      const store = storeMap.get(scope.storeId);
      return !store?.active || !['STORE', 'CORE_WAREHOUSE'].includes(store.type);
    })
  )
    throw new AppError(409, 'ORDER_IMPORT_STORE_UNAVAILABLE', 'An imported store is unavailable.');
  const counters = await tx
      .select({ id: StoreCounter.id, storeId: StoreCounter.store, active: StoreCounter.is_active })
      .from(StoreCounter)
      .where(
        inArray(
          StoreCounter.id,
          ordered.map((scope) => BigInt(scope.counterId)),
        ),
      )
      .orderBy(asc(StoreCounter.id))
      .for('share'),
    counterMap = new Map(counters.map((counter) => [String(counter.id), counter]));
  if (
    ordered.some((scope) => {
      const counter = counterMap.get(scope.counterId);
      return !counter?.active || String(counter.storeId) !== scope.storeId;
    })
  )
    throw new AppError(
      409,
      'ORDER_IMPORT_COUNTER_UNAVAILABLE',
      'An imported counter is unavailable in its store.',
    );
};
