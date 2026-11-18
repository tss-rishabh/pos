import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';
import { checkoutSessionStore } from '../checkout/session-store.js';
import { configuredStateStore } from '../checkout/state-store.js';
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
  // W4: checkout sales live in the Redis session store (pos_rewrite_checkout_sessions removed).
  const sessions = config.DEMO_MODE ? null : checkoutSessionStore(configuredStateStore(config));
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
    const preflight = await sessions!.readScoped(user.id, scope.storeId, scope.checkoutId);
    if (!preflight) throw missingCustomerProfile();
    return db.get('writer').transaction(async (tx) => {
      await checkIns.assertCheckIn(user.id, scope.storeId, preflight.counterId, tx);
      const state = await sessions!.readScoped(user.id, scope.storeId, scope.checkoutId);
      if (
        !state ||
        state.id !== scope.checkoutId ||
        state.counterId !== preflight.counterId ||
        !state.customerId ||
        state.phase === 'cleared'
      )
        throw missingCustomerProfile();
      return action(tx, { ...state, customerId: state.customerId });
    });
  };
}
