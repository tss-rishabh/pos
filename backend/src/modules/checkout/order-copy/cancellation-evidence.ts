import { eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutState } from '../contracts.js';
import { operationHash } from '../crypto.js';
import { copyCancellationReceiptSchema } from './cancellation-contracts.js';
import { orderCopyCancellations } from './schema.js';

export function verifyCopyCancellation(
  row: typeof orderCopyCancellations.$inferSelect,
  state: CheckoutState,
  secret: string,
) {
  const receipt = copyCancellationReceiptSchema.parse(row.receipt);
  if (
    row.copyId !== receipt.id ||
    row.cancellationId !== receipt.cancellationId ||
    row.checkoutId !== state.id ||
    row.operatorId !== state.operatorId ||
    receipt.checkoutId !== state.id ||
    receipt.operatorId !== state.operatorId ||
    receipt.storeId !== state.storeId ||
    receipt.counterId !== state.counterId ||
    row.requestHash !== receipt.originalRequestHash ||
    row.receiptHash !==
      operationHash(
        'order-copy.cancellation.v1',
        { receipt, originalCommand: row.originalCommand ?? null },
        secret,
      )
  )
    throw new AppError(
      409,
      'ORDER_COPY_CANCELLATION_UNCONFIRMED',
      'The original unsent cancellation needs reconciliation. Keep its marker and saved reference.',
    );
  return receipt;
}
/** Only this proof enables the existing explicit clear/detach operation, never quoting/payment. */
export function copyCancellationClearVerifier(config: Config, db: Databases) {
  return async (state: CheckoutState) => {
    if (state.orderCopy?.status !== 'cancelled-unsent')
      throw new AppError(
        409,
        'ORDER_COPY_CANCELLATION_UNCONFIRMED',
        'Refresh the original unsent cancellation.',
      );
    const [row] = await db
      .get('writer')
      .select()
      .from(orderCopyCancellations)
      .where(eq(orderCopyCancellations.copyId, state.orderCopy.commandId))
      .limit(1);
    if (!row)
      throw new AppError(
        409,
        'ORDER_COPY_CANCELLATION_UNCONFIRMED',
        'The original unsent cancellation was not found.',
      );
    const receipt = verifyCopyCancellation(row, state, config.SESSION_SECRET);
    if (
      receipt.cancellationId !== state.orderCopy.cancellationId ||
      receipt.reviewId !== state.orderCopy.reviewId
    )
      throw new AppError(
        409,
        'ORDER_COPY_CANCELLATION_UNCONFIRMED',
        'The unsent cancellation belongs to another saved intent.',
      );
  };
}
