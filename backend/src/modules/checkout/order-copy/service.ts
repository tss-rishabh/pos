import { createHash, randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { HasProduct, Order, OrderStore } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { Cart, CheckoutState } from '../contracts.js';
import { currentRequestTrace } from '../../../observability/context.js';
import type { CheckoutSessionStore } from '../session-store.js';
import { cartCopyHash, copyManifest } from './domain.js';
import {
  orderCopyMessages,
  type CopyCartPort,
  type OrderCopyInput,
  type OrderCopyResult,
} from './contracts.js';

export interface OrderCopyLogger {
  warn(fields: Record<string, string | null>, message: string): void;
}
export interface OrderCopyScope {
  storeId: string;
  checkoutId: string;
}

/** Quantity of a product already in the cart (gift cards count one per instance). */
function cartQuantity(cart: Cart, id: string) {
  return copyManifest(cart)
    .filter((line) => line.kind !== 'complementary' && line.productId === id)
    .reduce((total, line) => total + line.quantity, 0);
}

/**
 * Legacy `AjaxFetchTheProducts` (order/views.py:2045-2104): with a connected customer, add one unit
 * of every `has_products` row of the given order to the customer cart, in row order, stopping at
 * the first failed addition ("Cart partially synced"). The connected customer cart is the server
 * cart, so legacy's array concatenation + `syncart` + guest `clear_cart` collapse into the direct
 * additions (backend/parity/order-copy.md).
 */
export function orderCopyService(
  config: Config,
  db: Databases,
  sessions: CheckoutSessionStore,
  cart: CopyCartPort,
  logger?: OrderCopyLogger,
) {
  async function sourceLines(user: Principal, customerId: string, orderId: string) {
    const reader = db.get('primary');
    const [order] = await reader
      .select({ customerId: Order.user })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    const [mapping] = order
      ? await reader
          .select({ storeId: OrderStore.store })
          .from(OrderStore)
          .where(eq(OrderStore.order, BigInt(orderId)))
          .orderBy(asc(OrderStore.id))
          .limit(1)
      : [];
    const storeVisible =
      !!mapping &&
      ((user.role === 1 && user.userType === 1) || user.storeIds.includes(String(mapping.storeId)));
    // Legacy copies any order ID; only the connected customer's own orders or orders of a store the
    // operator works at are readable here, and anything else looks like a wrong ID.
    if (!order || (String(order.customerId) !== customerId && !storeVisible))
      throw new AppError(404, 'ORDER_COPY_SOURCE_NOT_FOUND', 'Please Enter Correct Order Id');
    return (
      await reader
        .select({ productId: HasProduct.product })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(orderId)))
        .orderBy(asc(HasProduct.id))
        .limit(1000)
    ).map((line) => String(line.productId));
  }
  return {
    async copy(
      user: Principal,
      scope: OrderCopyScope,
      input: OrderCopyInput,
    ): Promise<OrderCopyResult> {
      requireStore(user, scope.storeId);
      const copyId = randomUUID();
      // Reserve the sale like every checkout operation (busyOperationId), so the cart helper's own
      // checkpoints accept the copy steps and other mutations wait. No HTTP runs under the lock.
      const { reserved, products } = await sessions.exclusive(
        user.id,
        scope.storeId,
        scope.checkoutId,
        async (initial) => {
          if (!initial.customerId)
            throw new AppError(409, 'ORDER_COPY_CUSTOMER_REQUIRED', 'Please Connect The User');
          if (initial.orderId || !['open', 'quoted'].includes(initial.phase))
            throw new AppError(
              409,
              'CHECKOUT_ALREADY_SUBMITTED',
              'This sale already has an order. Open its order details.',
            );
          if (initial.busyOperationId)
            throw new AppError(
              409,
              'CHECKOUT_REVIEW_REQUIRED',
              'A previous checkout operation needs review before continuing.',
            );
          if ((await sessions.leaseHolder('customer', initial.customerId)) !== initial.id)
            throw new AppError(
              409,
              'ORDER_COPY_CUSTOMER_LEASE_REQUIRED',
              'Reconnect the customer cart before copying.',
            );
          const lines = await sourceLines(user, initial.customerId, input.orderId);
          const next: CheckoutState = {
            ...initial,
            busyOperationId: copyId,
            orderCopy: {
              commandId: copyId,
              reviewId: copyId,
              originHash: createHash('sha256').update(copyId).digest('hex'),
              status: 'pending',
              resultHash: null,
            },
            updatedAt: Date.now(),
          };
          return { state: next, value: { reserved: next, products: lines } };
        },
      );
      let state = reserved,
        added = 0,
        unreadable = false;
      try {
        let current: Cart | null = null;
        try {
          current = await cart.read(state);
        } catch {
          unreadable = true;
        }
        if (current)
          for (const productId of products) {
            if (added) current = await cart.read(state);
            state = await cart.setLine(
              state,
              randomUUID(),
              productId,
              cartQuantity(current, productId) + 1,
              cartCopyHash(current, config.SESSION_SECRET),
            );
            added++;
          }
      } catch (error) {
        // Legacy stops at the first failed addition and keeps what was already added.
        logger?.warn(
          {
            module: 'checkout',
            resource: 'order-copy',
            eventId: 'checkout.order-copy.partial',
            requestId: currentRequestTrace()?.requestId ?? null,
            userId: user.id,
            errorCode: error instanceof AppError ? error.code : 'ORDER_COPY_STEP_FAILED',
          },
          'Order copy stopped before every product was added',
        );
      }
      const latest = state;
      await sessions.exclusive(user.id, scope.storeId, scope.checkoutId, async (stored) => {
        if (stored.busyOperationId !== copyId)
          throw new AppError(
            409,
            'CHECKOUT_OPERATION_CHANGED',
            'This checkout changed during the copy. Reload it before continuing.',
          );
        return {
          state: {
            ...latest,
            busyOperationId: null,
            orderCopy: null,
            quote: null,
            phase: 'open',
            version: stored.version + 1,
            updatedAt: Date.now(),
          },
          value: null,
        };
      });
      if (unreadable)
        throw new AppError(
          502,
          'ORDER_COPY_CART_UNAVAILABLE',
          'Could not read cart, Please Try Again',
        );
      const partial = added < products.length;
      return {
        orderId: input.orderId,
        partial,
        message: partial ? orderCopyMessages.partial : orderCopyMessages.synced,
      };
    },
  };
}
