import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Order, OrderStore } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { operationHash } from '../checkout/crypto.js';
import { paymentAttempts } from '../checkout/payments/schema.js';
import { paymentAttemptSchema } from '../checkout/payments/contracts.js';
import { assertCheckoutProjection, checkoutHeaderHashSql } from '../checkout/projection.js';
import { performanceAuthority, type PerformanceFrame } from './authority.js';
import {
  performanceIdentifier,
  performanceInput,
  performanceReceipt,
  performanceScope,
  performanceSnapshot,
  sourcePerformanceJson,
  type PerformanceInput,
  type PerformanceScope,
} from './contracts.js';
import { checkoutPerformanceReceipts } from './schema.js';

type Saved = typeof checkoutPerformanceReceipts.$inferSelect;
const unavailable = () =>
    new AppError(
      503,
      'CHECKOUT_PERFORMANCE_UNCONFIRMED',
      'The completed sale could not be confirmed for timing metadata.',
    ),
  missing = () =>
    new AppError(404, 'CHECKOUT_PERFORMANCE_NOT_FOUND', 'Checkout timing metadata was not found.'),
  conflict = () =>
    new AppError(
      409,
      'CHECKOUT_PERFORMANCE_CONFLICT',
      'This sale already has a different timing snapshot.',
    );
export function checkoutPerformanceService(
  config: Config,
  db: Databases,
  clock: () => number = Date.now,
) {
  const withFrame = performanceAuthority(config, db);
  function savedReceipt(
    row: Saved,
    user: Principal,
    scope: PerformanceScope,
    frame: PerformanceFrame,
    input?: PerformanceInput,
  ) {
    if (
      row.operatorId !== user.id ||
      row.checkoutId !== scope.checkoutId ||
      row.storeId !== scope.storeId ||
      row.counterId !== frame.state.counterId ||
      String(row.orderId) !== frame.state.orderId ||
      String(row.customerId) !== frame.customerId ||
      row.checkoutOperationId !== frame.checkoutOperationId ||
      row.checkoutVersion !== frame.state.version
    )
      throw missing();
    const parsed = performanceReceipt.safeParse(row.receipt);
    if (
      !parsed.success ||
      parsed.data.operationId !== row.operationId ||
      parsed.data.checkoutId !== scope.checkoutId ||
      parsed.data.orderId !== String(row.orderId) ||
      sourcePerformanceJson(parsed.data.performance) !== row.performanceJson ||
      !/^[a-f0-9]{64}$/.test(row.headerHash)
    )
      throw unavailable();
    if (
      input &&
      (row.requestHash !==
        operationHash(
          'checkout-performance',
          { operatorId: user.id, scope, input },
          config.SESSION_SECRET,
        ) ||
        row.operationId !== input.operationId ||
        parsed.data.orderId !== input.orderId)
    )
      throw conflict();
    return parsed.data;
  }
  async function paid(
    tx: AdministrationTransaction,
    user: Principal,
    scope: PerformanceScope,
    frame: PerformanceFrame,
  ) {
    const orderId = BigInt(frame.state.orderId!),
      [order] = await tx
        .select({
          customerId: Order.user,
          method: Order.payment_methods,
          payment: Order.payment_statuses,
          status: Order.order_statuses,
          payable: Order.pay_amt,
          hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}`,
        })
        .from(Order)
        .where(eq(Order.id, orderId))
        .limit(1)
        .for('update');
    if (
      !order ||
      order.payment !== 4n ||
      order.status !== 3n ||
      String(order.customerId) !== frame.customerId ||
      !['14', '3'].includes(String(order.method)) ||
      (order.method === 3n && order.payable !== 0)
    )
      throw unavailable();
    await assertCheckoutProjection(tx, {
      orderId: String(orderId),
      storeId: scope.storeId,
      counterId: frame.state.counterId,
      customerId: frame.customerId,
    });
    const mappings = await tx
        .select({
          id: OrderStore.id,
          storeId: OrderStore.store,
          counterId: OrderStore.counter,
          performanceJson: OrderStore.performance_json,
          operatorId: sql<string>`CAST(order_stores.admin_user_id AS CHAR)`,
        })
        .from(OrderStore)
        .where(eq(OrderStore.order, orderId))
        .limit(2)
        .for('update'),
      mapping = mappings[0];
    if (
      mappings.length !== 1 ||
      !mapping ||
      String(mapping.storeId) !== scope.storeId ||
      String(mapping.counterId) !== frame.state.counterId ||
      mapping.operatorId !== user.id
    )
      throw unavailable();
    let paymentId: string | null = null;
    if (order.method === 14n) {
      const rows = await tx
          .select({ id: paymentAttempts.id, state: paymentAttempts.state })
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.orderId, String(orderId)),
              eq(paymentAttempts.storeId, scope.storeId),
              eq(paymentAttempts.status, 'paid'),
            ),
          )
          .limit(2)
          .for('share'),
        attempt = paymentAttemptSchema.safeParse(rows[0]?.state);
      if (
        rows.length !== 1 ||
        !attempt.success ||
        attempt.data.id !== rows[0]!.id ||
        attempt.data.status !== 'paid' ||
        attempt.data.orderId !== String(orderId) ||
        attempt.data.storeId !== scope.storeId ||
        attempt.data.counterId !== frame.state.counterId
      )
        throw unavailable();
      paymentId = rows[0]!.id;
    }
    return { mapping, headerHash: order.hash, paymentId };
  }
  return {
    async record(user: Principal, rawScope: PerformanceScope, body: unknown) {
      const scope = performanceScope.parse(rawScope),
        input = performanceInput.parse(body);
      requireStore(user, scope.storeId);
      const [known] = await db
        .get('writer')
        .select({ id: checkoutPerformanceReceipts.operationId })
        .from(checkoutPerformanceReceipts)
        .where(eq(checkoutPerformanceReceipts.operationId, input.operationId))
        .limit(1);
      return withFrame(
        user,
        scope,
        input.orderId,
        async (tx, frame) => {
          const [saved] = await tx
            .select()
            .from(checkoutPerformanceReceipts)
            .where(eq(checkoutPerformanceReceipts.operationId, input.operationId))
            .limit(1);
          if (saved) return savedReceipt(saved, user, scope, frame, input);
          const [existing] = await tx
            .select({ id: checkoutPerformanceReceipts.operationId })
            .from(checkoutPerformanceReceipts)
            .where(eq(checkoutPerformanceReceipts.orderId, BigInt(input.orderId)))
            .limit(1);
          if (existing) throw conflict();
          const proof = await paid(tx, user, scope, frame),
            performanceJson = sourcePerformanceJson(input.performance);
          if (
            proof.mapping.performanceJson !== '' &&
            proof.mapping.performanceJson !== performanceJson
          )
            throw conflict();
          if (proof.mapping.performanceJson !== performanceJson) {
            const [result] = await tx
              .update(OrderStore)
              .set({ performance_json: performanceJson })
              .where(
                and(
                  eq(OrderStore.id, proof.mapping.id),
                  eq(OrderStore.order, BigInt(input.orderId)),
                  eq(OrderStore.store, BigInt(scope.storeId)),
                  eq(OrderStore.counter, BigInt(frame.state.counterId)),
                  eq(OrderStore.performance_json, proof.mapping.performanceJson),
                ),
              );
            if (result.affectedRows !== 1) throw conflict();
          }
          const recordedAt = new Date(clock()),
            receipt = performanceReceipt.parse({
              operationId: input.operationId,
              checkoutId: scope.checkoutId,
              orderId: input.orderId,
              status: 'recorded',
              performance: input.performance,
              recordedAt: recordedAt.toISOString(),
            });
          await tx
            .insert(checkoutPerformanceReceipts)
            .values({
              operationId: input.operationId,
              checkoutId: scope.checkoutId,
              checkoutOperationId: frame.checkoutOperationId,
              checkoutVersion: frame.state.version,
              orderId: BigInt(input.orderId),
              orderStoreId: proof.mapping.id,
              operatorId: user.id,
              customerId: BigInt(frame.customerId),
              storeId: scope.storeId,
              counterId: frame.state.counterId,
              headerHash: proof.headerHash,
              requestHash: operationHash(
                'checkout-performance',
                { operatorId: user.id, scope, input },
                config.SESSION_SECRET,
              ),
              paymentId: proof.paymentId,
              performanceJson,
              receipt,
              requestId: currentRequestTrace()?.requestId ?? null,
              recordedAt,
            });
          return receipt;
        },
        !known,
      );
    },
    async read(user: Principal, rawScope: PerformanceScope, orderId: string) {
      const scope = performanceScope.parse(rawScope);
      performanceIdentifier.parse(orderId);
      requireStore(user, scope.storeId);
      const [known] = await db
        .get('writer')
        .select({ id: checkoutPerformanceReceipts.operationId })
        .from(checkoutPerformanceReceipts)
        .where(
          and(
            eq(checkoutPerformanceReceipts.orderId, BigInt(orderId)),
            eq(checkoutPerformanceReceipts.operatorId, user.id),
            eq(checkoutPerformanceReceipts.checkoutId, scope.checkoutId),
            eq(checkoutPerformanceReceipts.storeId, scope.storeId),
          ),
        )
        .limit(1);
      return withFrame(
        user,
        scope,
        orderId,
        async (tx, frame) => {
          const [row] = await tx
            .select()
            .from(checkoutPerformanceReceipts)
            .where(eq(checkoutPerformanceReceipts.orderId, BigInt(orderId)))
            .limit(1);
          if (row)
            return performanceSnapshot.parse({
              checkoutId: scope.checkoutId,
              orderId,
              receipt: savedReceipt(row, user, scope, frame),
            });
          await paid(tx, user, scope, frame);
          return performanceSnapshot.parse({
            checkoutId: scope.checkoutId,
            orderId,
            receipt: null,
          });
        },
        !known,
      );
    },
    async receipt(user: Principal, rawScope: PerformanceScope, operationId: string) {
      const scope = performanceScope.parse(rawScope);
      z.uuid().parse(operationId);
      return withFrame(user, scope, undefined, async (tx, frame) => {
        const [row] = await tx
          .select()
          .from(checkoutPerformanceReceipts)
          .where(eq(checkoutPerformanceReceipts.operationId, operationId))
          .limit(1);
        if (!row) throw missing();
        return savedReceipt(row, user, scope, frame);
      });
    },
  };
}
