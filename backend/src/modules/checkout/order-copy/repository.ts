import { and, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Product, ProductStore, Store } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { assertActiveCheckoutCustomer } from '../customer-access.js';
import { offlineCashReceipts } from '../offline-cash/schema.js';
import { checkoutStateSchema, type CheckoutState } from '../contracts.js';
import { checkoutSessions, customerLeases } from '../schema.js';
import { orderCopyCommands, orderCopyReviews } from './schema.js';
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
export function orderCopyRepository(config: Config, db: Databases, clock = Date.now) {
  const checkIns = checkInService(db, config);
  async function scope<T>(
    user: Principal,
    scope: CopyScope,
    action: (
      tx: AdministrationTransaction,
      state: CheckoutState & { customerId: string },
    ) => Promise<T>,
    readOnly = false,
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
    return db.get('writer').transaction(async (tx) => {
      await checkIns.assertCheckIn(user.id, scope.storeId, preflight.data.counterId, tx);
      await assertCurrentStoreAccess(tx, user.id, scope.storeId);
      const [row] = await tx.select().from(checkoutSessions).where(where).for('update');
      const parsed = checkoutStateSchema.safeParse(row?.state);
      if (!parsed.success) throw changed();
      const state = parsed.data;
      if (
        !state.customerId ||
        state.version !== row?.version ||
        state.counterId !== preflight.data.counterId ||
        state.orderId ||
        !['open', 'quoted', 'uncertain'].includes(state.phase) ||
        state.createdAt + 12 * 3600000 < clock()
      )
        throw changed();
      await assertActiveCheckoutCustomer(tx, state.customerId);
      // Every accepted receipt represents already-collected cash, including a
      // conflicted/importing one. Absence cannot prove another offline device
      // has no unreported receipt; those arrivals must still be retained.
      if (!readOnly && state.draftId) {
        const [cash] = await tx
          .select({
            id: offlineCashReceipts.id,
            storeId: offlineCashReceipts.storeId,
            counterId: offlineCashReceipts.counterId,
          })
          .from(offlineCashReceipts)
          .where(
            and(
              eq(offlineCashReceipts.operatorId, state.operatorId),
              eq(offlineCashReceipts.draftId, state.draftId),
            ),
          )
          .limit(1)
          .for('share');
        if (cash)
          throw new AppError(
            409,
            'ORDER_COPY_OFFLINE_CASH_COLLECTED',
            'Cash was already received for this saved sale. Keep the receipt for reconciliation.',
          );
      }
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
      return action(tx, { ...state, customerId: state.customerId });
    });
  }
  async function source(tx: AdministrationTransaction, user: Principal, source: CopySource) {
    if (source.kind === 'customer') return;
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
    return row ? copyReviewSchema.parse(row.data) : null;
  }
  async function command(tx: AdministrationTransaction, id: string): Promise<CopyCommand | null> {
    const [row] = await tx
      .select()
      .from(orderCopyCommands)
      .where(eq(orderCopyCommands.id, id))
      .for('update');
    return row ? copyCommandSchema.parse(row.data) : null;
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
  return { scope, source, state, review, command, save, available };
}
export type OrderCopyRepository = ReturnType<typeof orderCopyRepository>;
