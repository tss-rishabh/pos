import { eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { OrderStore, PosExchangeLog, Store } from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { returnRepositoryCore, type ReturnRepositoryOptions } from './repository-core.js';
import { returnScopeOperations } from './repository-scope.js';
import { returnLifecycleOperations } from './repository-returns.js';
import { exchangeLifecycleOperations } from './repository-exchange.js';

export type { ReturnRepositoryOptions } from './repository-core.js';

export function returnRepository(db: Databases, config: Config, options: ReturnRepositoryOptions) {
  const core = returnRepositoryCore(db, config, options);
  const { state, timestamp, stamp, load, owned } = core;
  return {
    ...returnScopeOperations(core),
    ...returnLifecycleOperations(core),
    ...exchangeLifecycleOperations(core),
    async read(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      await db.get('writer').transaction((tx) => owned(tx, user, operation));
      return operation;
    },
    async storeSlackUrl(storeId: string) {
      const [row] = await db
        .get('primary')
        .select({ url: Store.slack_group_url })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1);
      return row?.url || null;
    },
    async hasOrderStore(orderId: string) {
      const [row] = await db
        .get('writer')
        .select({ id: OrderStore.id })
        .from(OrderStore)
        .where(eq(OrderStore.order, BigInt(orderId)))
        .limit(1);
      return Boolean(row);
    },
    /**
     * A failed warehouse call (`return_processed` vinc failure, calculations.py:160-170): nothing
     * native is written for a return; an exchange's tracking row becomes FAILED_NEEDS_MANUAL_FIX.
     */
    async failure(
      user: Principal,
      storeId: string,
      id: string,
      stage: 'inbound' | 'refund',
      uncertain: boolean,
      errorCode: string,
      message: string | null,
    ) {
      const operation = await load(user, storeId, id);
      if (
        [
          'completed',
          'refund-confirmed',
          'inbound-accepted',
          'old-item-restored',
          'replacement-confirmed',
        ].includes(operation.phase)
      )
        return operation;
      if (operation.exchange)
        await db
          .get('writer')
          .update(PosExchangeLog)
          .set({
            status: 'FAILED_NEEDS_MANUAL_FIX',
            last_error: message ?? errorCode,
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
      return state.saveOperation(
        stamp({
          ...operation,
          phase: uncertain ? 'uncertain' : 'rejected',
          uncertainStage: uncertain ? stage : null,
          errorCode,
          message,
        }),
      );
    },
  };
}
export type ReturnRepository = ReturnType<typeof returnRepository>;
