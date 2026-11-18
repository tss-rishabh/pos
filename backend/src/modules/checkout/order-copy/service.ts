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
interface Scope {
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
    async copy(user: Principal, scope: Scope, input: OrderCopyInput): Promise<OrderCopyResult> {
      requireStore(user, scope.storeId);
      return sessions.exclusive(user.id, scope.storeId, scope.checkoutId, async (initial) => {
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
            'CHECKOUT_BUSY',
            'Another change to this sale is still running. Try again.',
          );
        if ((await sessions.leaseHolder('customer', initial.customerId)) !== initial.id)
          throw new AppError(
            409,
            'ORDER_COPY_CUSTOMER_LEASE_REQUIRED',
            'Reconnect the customer cart before copying.',
          );
        let current: Cart;
        try {
          current = await cart.read(initial);
        } catch {
          throw new AppError(
            502,
            'ORDER_COPY_CART_UNAVAILABLE',
            'Could not read cart, Please Try Again',
          );
        }
        const products = await sourceLines(user, initial.customerId, input.orderId);
        // The checkout cart helper accepts copy steps only for a state reserved to the copy. The
        // reservation lives only in memory; the persisted state never carries it.
        const copyId = randomUUID();
        let state: CheckoutState = {
            ...initial,
            busyOperationId: copyId,
            orderCopy: {
              commandId: copyId,
              reviewId: copyId,
              originHash: createHash('sha256').update(copyId).digest('hex'),
              status: 'pending',
              resultHash: null,
            },
          },
          added = 0;
        try {
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
        const partial = added < products.length;
        return {
          state: {
            ...state,
            busyOperationId: null,
            orderCopy: null,
            quote: null,
            phase: 'open',
            version: initial.version + 1,
            updatedAt: Date.now(),
          },
          value: {
            orderId: input.orderId,
            partial,
            message: partial ? orderCopyMessages.partial : orderCopyMessages.synced,
          },
        };
      });
    },
  };
}
