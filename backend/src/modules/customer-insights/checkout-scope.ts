import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { checkoutStateSchema, type CheckoutState } from '../checkout/contracts.js';
import { checkoutSessions } from '../checkout/schema.js';
import type { CustomerProfileScope } from './contracts.js';

export function missingCustomerProfile(): AppError {
  return new AppError(
    404,
    'CUSTOMER_PROFILE_NOT_FOUND',
    'This sale has no available customer profile.',
  );
}

export function customerProfileEditable(state: CheckoutState): boolean {
  return (
    ['open', 'quoted'].includes(state.phase) &&
    !state.busyOperationId &&
    !state.orderId &&
    state.draftImport?.status !== 'pending'
  );
}

/** Shared authority and lock order for all customer panels and scoped edits. */
export function customerCheckoutScope(config: Config, db: Databases) {
  const checkIns = checkInService(db, config);
  return async function withCheckout<T>(
    user: Principal,
    scope: CustomerProfileScope,
    lock: 'share' | 'update',
    action: (
      tx: AdministrationTransaction,
      state: CheckoutState & { customerId: string },
    ) => Promise<T>,
  ): Promise<T> {
    if (config.DEMO_MODE)
      throw new AppError(
        503,
        'CUSTOMER_PROFILE_UNAVAILABLE',
        'Customer details are unavailable in this workspace.',
      );
    requireStore(user, scope.storeId);
    const where = and(
      eq(checkoutSessions.id, scope.checkoutId),
      eq(checkoutSessions.operatorId, user.id),
      eq(checkoutSessions.storeId, scope.storeId),
    );
    const [initial] = await db
      .get('writer')
      .select({ state: checkoutSessions.state })
      .from(checkoutSessions)
      .where(where)
      .limit(1);
    const preflight = checkoutStateSchema.safeParse(initial?.state);
    if (!preflight.success) throw missingCustomerProfile();
    return db.get('writer').transaction(async (tx) => {
      await checkIns.assertCheckIn(user.id, scope.storeId, preflight.data.counterId, tx);
      const [row] = await tx
        .select({ state: checkoutSessions.state, version: checkoutSessions.version })
        .from(checkoutSessions)
        .where(where)
        .limit(1)
        .for(lock);
      const parsed = checkoutStateSchema.safeParse(row?.state);
      if (!parsed.success) throw missingCustomerProfile();
      const state = parsed.data;
      if (
        state.id !== scope.checkoutId ||
        state.operatorId !== user.id ||
        state.storeId !== scope.storeId ||
        state.counterId !== preflight.data.counterId ||
        state.version !== row?.version ||
        !state.customerId ||
        state.phase === 'cleared'
      )
        throw missingCustomerProfile();
      return action(tx, { ...state, customerId: state.customerId });
    });
  };
}
