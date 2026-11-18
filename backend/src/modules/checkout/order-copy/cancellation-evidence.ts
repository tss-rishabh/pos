import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutState } from '../contracts.js';

/**
 * TRANSITIONAL. Legacy has no order-copy cancellation (order/views.py:2045-2104), so no checkout can
 * reach `orderCopy.status === 'cancelled-unsent'` any more. Kept only because checkout/routes.ts
 * still wires `verifyCopyCancellationClear`; it refuses every call. Delete with that wiring.
 */
export function copyCancellationClearVerifier(_config: Config, _db: Databases) {
  return async (_state: CheckoutState): Promise<void> => {
    throw new AppError(
      409,
      'ORDER_COPY_CANCELLATION_UNCONFIRMED',
      'Order copies cannot be cancelled. Clear the cart normally.',
    );
  };
}
