import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { readJson, withStateLock, type PosStateStore } from '../state-store.js';
import { returnOperationSchema, type ReturnOperation } from './contracts.js';

/**
 * Ephemeral return/exchange state (table-disposition.md "checkout/returns").
 *
 * Durable facts stay in the production tables legacy writes (return_orders, has_products,
 * comments, pos_exchange_log, pos_transaction_logs, product_store, hold_stock_store). Redis only
 * holds the operation bookkeeping, the per-line busy lock and the recovery-claim receipts. Returns,
 * exchanges and return-date extension have no customer OTP step, as legacy
 * (`order/views.py:885-1313`). Every key carries a TTL (production Redis is `noeviction`).
 */

/** `pos:return_op:{operationId}`: 7 days after the last write (ledger row pos_rewrite_return_operations). */
export const RETURN_OPERATION_TTL_SECONDS = 7 * 86400;
/**
 * `pos:exchange_recovery_claim:*`: 30 days, never refreshed. The receipt only answers "was my
 * lost claim recorded?" for a counter workflow that is resumed within hours; 30 days outlives the
 * 7-day operation so a late outcome read still says `recorded`, while pos_exchange_log stays the
 * durable record of the takeover (staff_user_id, retry_count).
 */
export const RECOVERY_CLAIM_TTL_SECONDS = 30 * 86400;
/** A whole return/exchange request is bounded by its external calls (10 s + 10 s + 30 s). */
export const LINE_LOCK_TTL_SECONDS = 120;

export const returnStateKeys = {
  operation: (id: string) => `pos:return_op:${id}`,
  /** The latest operation started for an order line (replaces the old line/phase index). */
  lineOperation: (orderId: string, lineId: string) => `pos:return_line_op:${orderId}:${lineId}`,
  /** The Redis counterpart of the old `FOR UPDATE` on the operation row. */
  lineLock: (orderId: string, lineId: string) => `pos:return_line_lock:${orderId}:${lineId}`,
  claim: (storeId: string, orderId: string, lineId: string, claimId: string) =>
    `pos:exchange_recovery_claim:${storeId}:${orderId}:${lineId}:${claimId}`,
  claimId: (claimId: string) => `pos:exchange_recovery_claim_id:${claimId}`,
};

/** Plain SHA-256 of canonical JSON; request fingerprints and read revisions, not proofs. */
export function fingerprint(scope: string, value: unknown): string {
  return createHash('sha256')
    .update(
      `${scope}\n${JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? String(item) : item,
      )}`,
    )
    .digest('hex');
}

const busy = () =>
  new AppError(
    409,
    'RETURN_LINE_BUSY',
    'Another return or exchange for this item is still running. Check its status before retrying.',
  );

export function returnState(store: PosStateStore) {
  async function writeOperation(operation: ReturnOperation, onlyIfAbsent = false) {
    const value = JSON.stringify(returnOperationSchema.parse(operation));
    const written = await store.set(
      returnStateKeys.operation(operation.id),
      value,
      RETURN_OPERATION_TTL_SECONDS,
      onlyIfAbsent,
    );
    if (written)
      await store.set(
        returnStateKeys.lineOperation(operation.orderId, operation.lineId),
        operation.id,
        RETURN_OPERATION_TTL_SECONDS,
      );
    return written;
  }
  return {
    store,
    readOperation: (id: string) =>
      readJson(store, returnStateKeys.operation(id), returnOperationSchema),
    async lineOperation(orderId: string, lineId: string) {
      const id = await store.get(returnStateKeys.lineOperation(orderId, lineId));
      if (!id) return null;
      const operation = await readJson(store, returnStateKeys.operation(id), returnOperationSchema);
      return operation && operation.orderId === orderId && operation.lineId === lineId
        ? operation
        : null;
    },
    /** SET NX: false when the operation id is already used. */
    createOperation: (operation: ReturnOperation) => writeOperation(operation, true),
    saveOperation: async (operation: ReturnOperation) => {
      await writeOperation(operation);
      return operation;
    },
    withLine<T>(orderId: string, lineId: string, run: () => Promise<T>) {
      return withStateLock(store, returnStateKeys.lineLock(orderId, lineId), run, {
        ttlSeconds: LINE_LOCK_TTL_SECONDS,
        waitMs: 3000,
        busy,
      });
    },
  };
}
export type ReturnState = ReturnType<typeof returnState>;

export const recoveryClaimReceiptSchema = z
  .object({
    v: z.literal(1),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    operatorId: z.string(),
    counterId: z.string(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    operationId: z.uuid().nullable(),
    status: z.enum(['pending', 'recorded']),
    recordedAt: z.string().nullable(),
  })
  .strict();
export type RecoveryClaimReceipt = z.infer<typeof recoveryClaimReceiptSchema>;
