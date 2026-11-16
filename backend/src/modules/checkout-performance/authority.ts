import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Order } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { checkoutStateSchema, type CheckoutState } from '../checkout/contracts.js';
import { checkoutOperations, checkoutSessions } from '../checkout/schema.js';
import { performanceIdentifier, type PerformanceScope } from './contracts.js';

const missing = () =>
  new AppError(
    404,
    'CHECKOUT_PERFORMANCE_NOT_FOUND',
    'Checkout timing metadata is unavailable for this sale.',
  );
const pending = () =>
  new AppError(
    409,
    'CHECKOUT_PERFORMANCE_NOT_READY',
    'Timing metadata can be saved after this sale is confirmed.',
  );
export interface PerformanceFrame {
  state: CheckoutState;
  customerId: string;
  checkoutOperationId: string;
}
export function performanceAuthority(config: Config, db: Databases) {
  const checkIns = checkInService(db, config);
  function matches(
    state: CheckoutState,
    user: Principal,
    scope: PerformanceScope,
    orderId?: string,
  ) {
    return (
      state.id === scope.checkoutId &&
      state.operatorId === user.id &&
      state.storeId === scope.storeId &&
      state.orderId !== null &&
      (orderId === undefined || state.orderId === orderId) &&
      state.phase === 'submitted' &&
      state.orderSubmissionOperationId !== null
    );
  }
  return async <T>(
    user: Principal,
    scope: PerformanceScope,
    orderId: string | undefined,
    action: (tx: AdministrationTransaction, frame: PerformanceFrame) => Promise<T>,
    requirePaidPreflight = false,
  ): Promise<T> => {
    requireStore(user, scope.storeId);
    if (config.DEMO_MODE)
      throw new AppError(
        503,
        'CHECKOUT_PERFORMANCE_UNAVAILABLE',
        'Timing metadata is unavailable in this workspace.',
      );
    const condition = and(
        eq(checkoutSessions.id, scope.checkoutId),
        eq(checkoutSessions.operatorId, user.id),
        eq(checkoutSessions.storeId, scope.storeId),
      ),
      [preflight] = await db
        .get('writer')
        .select({ state: checkoutSessions.state })
        .from(checkoutSessions)
        .where(condition)
        .limit(1),
      initial = checkoutStateSchema.safeParse(preflight?.state);
    if (!initial.success) throw missing();
    if (!matches(initial.data, user, scope, orderId)) throw pending();
    if (requirePaidPreflight) {
      // Refuse premature metadata before taking any checkout/check-in/order lock.
      // Otherwise a note-bearing cash transaction can hold Order then wait for
      // Checkout while metadata holds Checkout and waits for Order.
      const [paid] = await db
        .get('writer')
        .select({ id: Order.id })
        .from(Order)
        .where(
          and(
            eq(Order.id, BigInt(initial.data.orderId!)),
            eq(Order.user, BigInt(initial.data.customerId ?? initial.data.operatorCustomerId)),
            eq(Order.payment_statuses, 4n),
            eq(Order.order_statuses, 3n),
          ),
        )
        .limit(1);
      if (!paid) throw pending();
    }
    return db.get('writer').transaction(async (tx) => {
      await checkIns.assertCheckIn(user.id, scope.storeId, initial.data.counterId, tx);
      const [current] = await tx
          .select({ state: checkoutSessions.state, version: checkoutSessions.version })
          .from(checkoutSessions)
          .where(condition)
          .limit(1)
          .for('update'),
        parsed = checkoutStateSchema.safeParse(current?.state);
      if (
        !parsed.success ||
        !matches(parsed.data, user, scope, orderId) ||
        parsed.data.counterId !== initial.data.counterId ||
        parsed.data.orderSubmissionOperationId !== initial.data.orderSubmissionOperationId ||
        parsed.data.version !== current?.version
      )
        throw pending();
      const [operation] = await tx
          .select({ status: checkoutOperations.status, result: checkoutOperations.result })
          .from(checkoutOperations)
          .where(
            and(
              eq(checkoutOperations.checkoutId, scope.checkoutId),
              eq(checkoutOperations.id, parsed.data.orderSubmissionOperationId!),
            ),
          )
          .limit(1)
          .for('share'),
        receipt = z.object({ state: checkoutStateSchema }).safeParse(operation?.result);
      if (operation?.status !== 'succeeded' || !receipt.success) throw pending();
      const original = receipt.data.state,
        customerId = original.customerId ?? original.operatorCustomerId;
      if (
        !matches(original, user, scope, parsed.data.orderId!) ||
        original.counterId !== parsed.data.counterId ||
        original.orderSubmissionOperationId !== parsed.data.orderSubmissionOperationId ||
        original.version > parsed.data.version ||
        customerId !== (parsed.data.customerId ?? parsed.data.operatorCustomerId)
      )
        throw pending();
      performanceIdentifier.parse(customerId);
      return action(tx, {
        state: original,
        customerId,
        checkoutOperationId: parsed.data.orderSubmissionOperationId!,
      });
    });
  };
}
