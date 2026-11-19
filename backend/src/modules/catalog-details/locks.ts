import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../domain/errors.js';
import { withEphemeralLock, type EphemeralStore } from '../../jobs/ephemeral.js';

/**
 * Ledger `catalog/maintenance+barcodes`: `pos:lock:catalog:{name}` (SET NX PX, token-checked
 * release), replacing `pos_rewrite_catalog_locks`. `barcode-mutations` is shared by barcode
 * assignment (administration/barcodes) and product troubleshooting, the only duplicate-GTIN guard
 * because products_gs1 has no unique index. Acquire before the writer transaction, release after
 * commit. Legacy has no lock here.
 */
export type CatalogLockName = 'barcode-mutations';
export const catalogLockKey = (name: CatalogLockName) => `pos:lock:catalog:${name}`;
export async function withCatalogLock<T>(
  ephemeral: EphemeralStore,
  name: CatalogLockName,
  run: () => Promise<T>,
  options: { leaseMs?: number; waitMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 5_000);
  for (;;) {
    const result = await withEphemeralLock(
      ephemeral,
      catalogLockKey(name),
      options.leaseMs ?? 30_000,
      run,
    );
    if (result) return result.value;
    if (Date.now() >= deadline)
      throw new AppError(409, 'CATALOG_BUSY', 'Another barcode change is in progress. Try again.');
    await sleep(50);
  }
}
