import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../../domain/errors.js';
import { withEphemeralLock, type EphemeralStore } from '../../../jobs/ephemeral.js';

/** Ledger `pos_rewrite_catalog_locks` -> `pos:lock:catalog:{name}` (SET NX PX, token release). */
export const barcodeMutationLockKey = 'pos:lock:catalog:barcode-mutations';

/**
 * Serialises GS1 writers across instances. `products_gs1` has no UNIQUE(gtin)/UNIQUE(product_id),
 * so this lease is the only duplicate guard (legacy `core/views.py:1265-1277` had none). Acquire it
 * before the writer transaction and release it after commit: call the transaction inside `run`.
 */
export async function withBarcodeMutationLock<T>(
  ephemeral: EphemeralStore,
  run: () => Promise<T>,
  options: { leaseMs?: number; waitMs?: number } = {},
): Promise<T> {
  const leaseMs = options.leaseMs ?? 30_000,
    deadline = Date.now() + (options.waitMs ?? 10_000);
  for (;;) {
    const result = await withEphemeralLock(ephemeral, barcodeMutationLockKey, leaseMs, run);
    if (result) return result.value;
    if (Date.now() >= deadline)
      throw new AppError(
        409,
        'BARCODE_ASSIGNMENT_BUSY',
        'Another barcode change is in progress. Try again.',
      );
    await sleep(25);
  }
}
