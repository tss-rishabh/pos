import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { OrderStore } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { CheckoutSessionStore } from '../checkout/session-store.js';
import { idempotencyKey, readJson, type PosStateStore } from '../checkout/state-store.js';
import {
  performanceInput,
  performanceReceipt,
  sourcePerformanceJson,
  type PerformanceReceipt,
  type PerformanceScope,
  type PerformanceValues,
} from './contracts.js';

/**
 * Legacy `AjaxOrderView` (order/views.py:2697-2699, 2801-2802) sets
 * `order_stores.performance_json = json.dumps({...POST performance_json, overall_performance_time})`
 * for every order_stores row of the created order. Exported so the order-submission path can
 * write it in the same request, exactly as legacy does.
 */
export async function writeOrderPerformance(
  db: Databases,
  orderId: string,
  performance: PerformanceValues,
): Promise<void> {
  await db
    .get('writer')
    .update(OrderStore)
    .set({ performance_json: sourcePerformanceJson(performance) })
    .where(eq(OrderStore.order, BigInt(orderId)));
}

/** Idempotency receipt `pos:idem:checkout-performance:{operatorId}:{operationId}`, 24 h. */
export const PERFORMANCE_RECEIPT_TTL_SECONDS = 86_400;
const savedSchema = z
  .object({
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    storeId: z.string(),
    receipt: performanceReceipt,
  })
  .strict();
const missing = () =>
    new AppError(404, 'CHECKOUT_PERFORMANCE_NOT_FOUND', 'Checkout timing metadata was not found.'),
  conflict = () =>
    new AppError(
      409,
      'CHECKOUT_PERFORMANCE_CONFLICT',
      'This timing reference was already used for a different sale.',
    );

export function checkoutPerformanceService(
  db: Databases,
  deps: { stateStore: PosStateStore; sessions: CheckoutSessionStore },
  clock: () => number = Date.now,
) {
  const key = (user: Principal, operationId: string) =>
    idempotencyKey('checkout-performance', user.id, operationId);
  return {
    async record(user: Principal, scope: PerformanceScope, body: unknown) {
      requireStore(user, scope.storeId);
      const input = performanceInput.parse(body),
        requestHash = createHash('sha256')
          .update(JSON.stringify([scope.storeId, scope.checkoutId, input.orderId]))
          .update(sourcePerformanceJson(input.performance))
          .digest('hex');
      const saved = await readJson(deps.stateStore, key(user, input.operationId), savedSchema);
      if (saved) {
        if (saved.requestHash !== requestHash) throw conflict();
        return saved.receipt;
      }
      const state = await deps.sessions.readScoped(user.id, scope.storeId, scope.checkoutId);
      if (!state)
        throw new AppError(
          404,
          'CHECKOUT_NOT_FOUND',
          'Checkout was not found for this operator and store.',
        );
      if (state.orderId !== input.orderId)
        throw new AppError(
          409,
          'CHECKOUT_PERFORMANCE_ORDER_MISMATCH',
          'Timing data can only be saved for the order this sale created.',
        );
      await writeOrderPerformance(db, input.orderId, input.performance);
      const receipt: PerformanceReceipt = performanceReceipt.parse({
        operationId: input.operationId,
        checkoutId: scope.checkoutId,
        orderId: input.orderId,
        status: 'recorded',
        performance: input.performance,
        recordedAt: new Date(clock()).toISOString(),
      });
      await deps.stateStore.set(
        key(user, input.operationId),
        JSON.stringify({ requestHash, storeId: scope.storeId, receipt }),
        PERFORMANCE_RECEIPT_TTL_SECONDS,
      );
      return receipt;
    },
    async receipt(user: Principal, scope: PerformanceScope, operationId: string) {
      requireStore(user, scope.storeId);
      const saved = await readJson(deps.stateStore, key(user, operationId), savedSchema);
      if (
        !saved ||
        saved.storeId !== scope.storeId ||
        saved.receipt.checkoutId !== scope.checkoutId
      )
        throw missing();
      return saved.receipt;
    },
  };
}
