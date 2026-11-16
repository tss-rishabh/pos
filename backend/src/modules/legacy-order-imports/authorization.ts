import { and, eq, inArray } from 'drizzle-orm';
import { Store, StoreCounter } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentInventoryAccess } from '../administration/authorization.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ImportScope } from './sealed-groups.js';

export type ImportAuthorizer = (
  tx: AdministrationTransaction,
  actorId: string,
  scopes: readonly ImportScope[],
) => Promise<void>;
export const authorizeLegacyOrderImport: ImportAuthorizer = async (tx, actorId, scopes) => {
  const ordered = [...scopes].sort((a, b) =>
    BigInt(a.storeId) < BigInt(b.storeId) ? -1 : BigInt(a.storeId) > BigInt(b.storeId) ? 1 : 0,
  );
  for (const scope of ordered) {
    await assertCurrentInventoryAccess(tx, actorId, scope.storeId);
    const [store] = await tx
      .select({ id: Store.id })
      .from(Store)
      .where(
        and(
          eq(Store.id, BigInt(scope.storeId)),
          eq(Store.is_active, true),
          inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
        ),
      )
      .limit(1)
      .for('share');
    if (!store)
      throw new AppError(
        409,
        'ORDER_IMPORT_STORE_UNAVAILABLE',
        'An imported store is unavailable.',
      );
    const [counter] = await tx
      .select({ id: StoreCounter.id })
      .from(StoreCounter)
      .where(
        and(
          eq(StoreCounter.id, BigInt(scope.counterId)),
          eq(StoreCounter.store, BigInt(scope.storeId)),
          eq(StoreCounter.is_active, true),
        ),
      )
      .limit(1)
      .for('share');
    if (!counter)
      throw new AppError(
        409,
        'ORDER_IMPORT_COUNTER_UNAVAILABLE',
        'An imported counter is unavailable in its store.',
      );
  }
};
