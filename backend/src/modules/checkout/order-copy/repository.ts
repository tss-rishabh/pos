import { and, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Product, ProductStore, Store } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { retryTransaction } from '../../../db/retry.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { assertActiveCheckoutCustomer } from '../customer-access.js';
import { checkoutStateSchema, type CheckoutState } from '../contracts.js';
import { checkoutSessions, customerLeases } from '../schema.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import { authorizeCustomerCopy, type CopySourceAccess } from './customer-authority.js';
import { orderCopyCommands, orderCopyReviews, orderCopyCancellations } from './schema.js';
import { copyCancellationReceiptSchema } from './cancellation-contracts.js';
import {
  copyCommandSchema,
  copyReviewSchema,
  type CopyScope,
  type CopySource,
  type CopyCommand,
  type CopyReview,
} from './contracts.js';

const changed = () =>
  new AppError(
    409,
    'ORDER_COPY_CONTEXT_CHANGED',
    'The checkout or copy review changed. Reload its original reference.',
  );
export function orderCopyRepository(
  config: Config,
  db: Databases,
  clock = Date.now,
  options: { customerOtp?: CustomerVerificationClient } = {},
) {
  const checkIns = checkInService(db, config);
  async function ownerScope<T>(
    user: Principal,
    scope: CopyScope,
    action: (tx: AdministrationTransaction, state: CheckoutState) => Promise<T>,
  ): Promise<T> {
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
    if (!preflight.success) throw changed();
    return retryTransaction(() =>
      db.get('writer').transaction(async (tx) => {
        await checkIns.assertCheckIn(user.id, scope.storeId, preflight.data.counterId, tx);
        await assertCurrentStoreAccess(tx, user.id, scope.storeId);
        const [row] = await tx.select().from(checkoutSessions).where(where).for('update');
        const parsed = checkoutStateSchema.safeParse(row?.state);
        if (
          !parsed.success ||
          parsed.data.version !== row?.version ||
          parsed.data.id !== scope.checkoutId ||
          parsed.data.operatorId !== user.id ||
          parsed.data.storeId !== scope.storeId ||
          parsed.data.counterId !== preflight.data.counterId
        )
          throw changed();
        return action(tx, parsed.data);
      }),
    );
  }
  async function activeState(
    tx: AdministrationTransaction,
    state: CheckoutState,
  ): Promise<CheckoutState & { customerId: string }> {
    if (
      !state.customerId ||
      state.orderId ||
      !['open', 'quoted', 'uncertain'].includes(state.phase) ||
      state.createdAt + 12 * 3600000 < clock()
    )
      throw changed();
    await assertActiveCheckoutCustomer(tx, state.customerId);
    const [lease] = await tx
      .select()
      .from(customerLeases)
      .where(eq(customerLeases.customerId, state.customerId))
      .for('update');
    if (!lease || lease.checkoutId !== state.id || lease.expiresAt <= clock())
      throw new AppError(
        409,
        'ORDER_COPY_CUSTOMER_LEASE_REQUIRED',
        'Reconnect the customer cart before copying.',
      );
    return { ...state, customerId: state.customerId };
  }
  async function scope<T>(
    user: Principal,
    scope: CopyScope,
    action: (
      tx: AdministrationTransaction,
      state: CheckoutState & { customerId: string },
    ) => Promise<T>,
  ): Promise<T> {
    return ownerScope(user, scope, async (tx, state) => action(tx, await activeState(tx, state)));
  }
  async function source(
    tx: AdministrationTransaction,
    user: Principal,
    source: CopySource,
    access: CopySourceAccess,
  ) {
    if (source.kind === 'customer')
      return authorizeCustomerCopy(tx, user, access, options.customerOtp, clock);
    requireStore(user, source.storeId);
    await assertCurrentStoreAccess(tx, user.id, source.storeId);
    const [store] = await tx
      .select({ active: Store.is_active })
      .from(Store)
      .where(eq(Store.id, BigInt(source.storeId)))
      .limit(1)
      .for('share');
    if (!store?.active)
      throw new AppError(404, 'ORDER_COPY_SOURCE_NOT_FOUND', 'The source store is unavailable.');
    return undefined;
  }
  async function state(tx: AdministrationTransaction, value: CheckoutState) {
    await tx
      .update(checkoutSessions)
      .set({ version: value.version, state: value })
      .where(eq(checkoutSessions.id, value.id));
  }
  async function review(tx: AdministrationTransaction, id: string): Promise<CopyReview | null> {
    const [row] = await tx
      .select()
      .from(orderCopyReviews)
      .where(eq(orderCopyReviews.id, id))
      .for('update');
    if (!row) return null;
    const parsed = copyReviewSchema.parse(row.data);
    if (
      parsed.id !== row.id ||
      parsed.checkoutId !== row.checkoutId ||
      parsed.operatorId !== row.operatorId
    )
      throw changed();
    return parsed;
  }
  async function command(tx: AdministrationTransaction, id: string): Promise<CopyCommand | null> {
    const [row] = await tx
      .select()
      .from(orderCopyCommands)
      .where(eq(orderCopyCommands.id, id))
      .for('update');
    if (!row) return null;
    if (copyCancellationReceiptSchema.safeParse(row.data).success) return null;
    const parsed = copyCommandSchema.parse(row.data);
    if (parsed.status === 'cancelled-unsent') return null;
    if (
      parsed.id !== row.id ||
      parsed.review.id !== row.reviewId ||
      parsed.review.checkoutId !== row.checkoutId ||
      parsed.review.operatorId !== row.operatorId
    )
      throw changed();
    return parsed;
  }
  async function commandForReview(tx: AdministrationTransaction, reviewId: string) {
    const row = await occupiedReview(tx, reviewId);
    return row ? command(tx, row.id) : null;
  }
  async function occupiedReview(tx: AdministrationTransaction, reviewId: string) {
    const [row] = await tx
      .select({ id: orderCopyCommands.id })
      .from(orderCopyCommands)
      .where(eq(orderCopyCommands.reviewId, reviewId))
      .limit(1)
      .for('update');
    return row ?? null;
  }
  async function save(tx: AdministrationTransaction, value: CopyCommand) {
    await tx
      .update(orderCopyCommands)
      .set({ data: value })
      .where(eq(orderCopyCommands.id, value.id));
  }
  async function available(productId: string, storeId: string, quantity: number): Promise<boolean> {
    const rows = await db
      .get('primary')
      .select({
        id: ProductStore.id,
        stock: ProductStore.stock,
        available: ProductStore.is_avail,
        deleted: ProductStore.is_del,
      })
      .from(ProductStore)
      .innerJoin(Product, eq(Product.id, ProductStore.product))
      .where(
        and(eq(ProductStore.product, BigInt(productId)), eq(ProductStore.store, BigInt(storeId))),
      )
      .limit(2);
    return (
      rows.length === 1 &&
      rows[0]!.available &&
      !rows[0]!.deleted &&
      rows[0]!.stock >= BigInt(quantity)
    );
  }
  async function cancellation(tx: AdministrationTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(orderCopyCancellations)
      .where(eq(orderCopyCancellations.copyId, id))
      .limit(1)
      .for('update');
    return row ?? null;
  }
  return {
    scope,
    ownerScope,
    activeState,
    source,
    state,
    review,
    command,
    commandForReview,
    occupiedReview,
    cancellation,
    save,
    available,
  };
}
export type OrderCopyRepository = ReturnType<typeof orderCopyRepository>;
